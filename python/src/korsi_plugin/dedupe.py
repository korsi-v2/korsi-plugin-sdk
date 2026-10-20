"""Remembering which events were handled: Korsi delivers at least once.

An event can arrive twice -- the plugin answered too slowly, a network dropped the answer -- and is
the same event both times (``Korsi-Event-Id``, the body's ``id``). :class:`EventLog` is what
:meth:`korsi_plugin.KorsiPlugin.event` asks before handling one:

* ``first_time`` *claims* an event, atomically, so two deliveries racing each other run it once;
* ``forget`` gives the claim back when handling failed, so Korsi's next attempt runs it again.

Keep it where the plugin keeps its own data -- a claim and the work it guards belong in one store.
:class:`SQLiteEventLog` is a durable one for a plugin without a database of its own;
:class:`MemoryEventLog` forgets on restart and suits tests and a single process.
"""

from __future__ import annotations

import asyncio
import sqlite3
import uuid
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Protocol


class EventLog(Protocol):
    async def first_time(self, installation_id: uuid.UUID, event_id: str) -> bool:
        """Claim the event: true the first time, false for every repeat."""
        ...

    async def forget(self, installation_id: uuid.UUID, event_id: str) -> None:
        """Release a claim: the event was not handled after all."""
        ...


class MemoryEventLog:
    """The newest ``capacity`` event ids, in memory. Korsi's retries come within a day."""

    def __init__(self, capacity: int = 50_000) -> None:
        self._capacity = capacity
        self._seen: OrderedDict[tuple[uuid.UUID, str], None] = OrderedDict()

    async def first_time(self, installation_id: uuid.UUID, event_id: str) -> bool:
        key = (installation_id, event_id)
        if key in self._seen:
            self._seen.move_to_end(key)
            return False
        self._seen[key] = None
        while len(self._seen) > self._capacity:
            self._seen.popitem(last=False)
        return True

    async def forget(self, installation_id: uuid.UUID, event_id: str) -> None:
        self._seen.pop((installation_id, event_id), None)


class SQLiteEventLog:
    """Event ids in a SQLite file, on a worker thread so a slow disk never blocks the loop."""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS korsi_event_seen ("
                " installation_id TEXT NOT NULL, event_id TEXT NOT NULL,"
                " seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,"
                " PRIMARY KEY (installation_id, event_id))"
            )

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # Autocommit, one statement per call: each claim is its own transaction.
        with closing(sqlite3.connect(self._path, timeout=10, isolation_level=None)) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            yield connection

    def _claim(self, installation_id: uuid.UUID, event_id: str) -> bool:
        with self._connect() as connection:
            cursor = connection.execute(
                "INSERT OR IGNORE INTO korsi_event_seen (installation_id, event_id) VALUES (?, ?)",
                (str(installation_id), event_id),
            )
            return cursor.rowcount > 0

    def _release(self, installation_id: uuid.UUID, event_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM korsi_event_seen WHERE installation_id = ? AND event_id = ?",
                (str(installation_id), event_id),
            )

    def _prune(self, days: int) -> int:
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM korsi_event_seen WHERE seen_at < datetime('now', ?)",
                (f"-{days} days",),
            )
            return cursor.rowcount

    async def first_time(self, installation_id: uuid.UUID, event_id: str) -> bool:
        return await asyncio.to_thread(self._claim, installation_id, event_id)

    async def forget(self, installation_id: uuid.UUID, event_id: str) -> None:
        await asyncio.to_thread(self._release, installation_id, event_id)

    async def prune(self, *, older_than_days: int = 7) -> int:
        """Forget ids older than Korsi would retry (a day); returns how many went."""
        return await asyncio.to_thread(self._prune, older_than_days)
