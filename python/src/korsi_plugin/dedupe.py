"""Remembering which events were handled: Korsi delivers at least once.

An event can arrive twice -- the plugin answered too slowly, a network dropped the answer -- and is
the same event both times (``Korsi-Event-Id``, the body's ``id``). :class:`EventLog` is what
:meth:`korsi_plugin.KorsiPlugin.event` asks before handling one, in three steps:

* ``claim`` takes the event, atomically, for a *lease*: ``new`` the first time, ``done`` once it
  was handled, ``busy`` while another delivery holds it. Korsi times a delivery out after ten
  seconds and tries again later, so a slow handler's event arrives again while it still runs:
  that delivery is told to come back (a 503), not that the event was handled.
* ``finish`` records it as handled -- only after the handler returned;
* ``forget`` gives the claim back when the handler failed, so Korsi's next attempt runs it.

A claim whose lease ran out was a process that died mid-handler (a deploy, the OOM killer): the
next delivery takes it over instead of being told ``busy`` forever. So an event runs at least
once, and handlers must be idempotent -- as with any at-least-once delivery.

Keep the log where the plugin keeps its own data. :class:`SQLiteEventLog` is a durable one (it can
share the plugin's SQLite file); :class:`MemoryEventLog` forgets on restart and suits tests and a
single process.
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
import uuid
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Final, Literal, Protocol

ClaimStatus = Literal["new", "busy", "done"]

#: How long a claim holds before another delivery may take it over, in seconds.
DEFAULT_LEASE_SECONDS: Final = 300.0


class EventLog(Protocol):
    async def claim(
        self, installation_id: uuid.UUID, event_id: str, *, lease_seconds: float
    ) -> ClaimStatus:
        """Take the event: ``new`` (run it), ``busy`` (another delivery runs it), ``done``."""
        ...

    async def finish(self, installation_id: uuid.UUID, event_id: str) -> None:
        """The event was handled: every later delivery of it is ``done``."""
        ...

    async def forget(self, installation_id: uuid.UUID, event_id: str) -> None:
        """Release a claim: the event was not handled after all."""
        ...


class MemoryEventLog:
    """The newest ``capacity`` events, in memory. Korsi's retries come within a day."""

    def __init__(self, capacity: int = 50_000) -> None:
        self._capacity = capacity
        #: (installation, event) -> None once done, or the moment the claim's lease runs out.
        self._seen: OrderedDict[tuple[uuid.UUID, str], float | None] = OrderedDict()
        self._now = time.monotonic

    async def claim(
        self, installation_id: uuid.UUID, event_id: str, *, lease_seconds: float
    ) -> ClaimStatus:
        key = (installation_id, event_id)
        now = self._now()
        if key in self._seen:
            until = self._seen[key]
            self._seen.move_to_end(key)
            if until is None:
                return "done"
            if until > now:
                return "busy"
        self._seen[key] = now + lease_seconds
        while len(self._seen) > self._capacity:
            self._seen.popitem(last=False)
        return "new"

    async def finish(self, installation_id: uuid.UUID, event_id: str) -> None:
        self._seen[(installation_id, event_id)] = None

    async def forget(self, installation_id: uuid.UUID, event_id: str) -> None:
        self._seen.pop((installation_id, event_id), None)


class SQLiteEventLog:
    """Events in a SQLite file, on a worker thread so a slow disk never blocks the loop."""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS korsi_event_log ("
                " installation_id TEXT NOT NULL, event_id TEXT NOT NULL,"
                " claimed_until REAL, done_at REAL,"
                " PRIMARY KEY (installation_id, event_id))"
            )

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # Autocommit; a claim is one statement, so it is atomic without a transaction.
        with closing(sqlite3.connect(self._path, timeout=10, isolation_level=None)) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            yield connection

    def _claim(self, installation_id: uuid.UUID, event_id: str, lease: float) -> ClaimStatus:
        now = time.time()
        with self._connect() as connection:
            # Inserted, or taken over from a claim whose lease ran out: either way, ours now.
            taken = connection.execute(
                "INSERT INTO korsi_event_log (installation_id, event_id, claimed_until)"
                " VALUES (?, ?, ?)"
                " ON CONFLICT (installation_id, event_id) DO UPDATE"
                " SET claimed_until = excluded.claimed_until"
                " WHERE done_at IS NULL AND claimed_until <= ?",
                (str(installation_id), event_id, now + lease, now),
            ).rowcount
            if taken:
                return "new"
            row = connection.execute(
                "SELECT done_at FROM korsi_event_log WHERE installation_id = ? AND event_id = ?",
                (str(installation_id), event_id),
            ).fetchone()
        return "done" if row is not None and row[0] is not None else "busy"

    def _finish(self, installation_id: uuid.UUID, event_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE korsi_event_log SET done_at = ?, claimed_until = NULL"
                " WHERE installation_id = ? AND event_id = ?",
                (time.time(), str(installation_id), event_id),
            )

    def _release(self, installation_id: uuid.UUID, event_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM korsi_event_log"
                " WHERE installation_id = ? AND event_id = ? AND done_at IS NULL",
                (str(installation_id), event_id),
            )

    def _prune(self, days: int) -> int:
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM korsi_event_log WHERE done_at < ?",
                (time.time() - days * 86_400,),
            )
            return cursor.rowcount

    async def claim(
        self, installation_id: uuid.UUID, event_id: str, *, lease_seconds: float
    ) -> ClaimStatus:
        return await asyncio.to_thread(self._claim, installation_id, event_id, lease_seconds)

    async def finish(self, installation_id: uuid.UUID, event_id: str) -> None:
        await asyncio.to_thread(self._finish, installation_id, event_id)

    async def forget(self, installation_id: uuid.UUID, event_id: str) -> None:
        await asyncio.to_thread(self._release, installation_id, event_id)

    async def prune(self, *, older_than_days: int = 7) -> int:
        """Forget handled events older than Korsi would retry (a day); returns how many went."""
        return await asyncio.to_thread(self._prune, older_than_days)
