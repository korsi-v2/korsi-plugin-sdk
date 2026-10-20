"""The event logs: a claim is atomic, a failure gives it back, old ids are let go."""

from __future__ import annotations

import asyncio
import sqlite3
import uuid
from contextlib import closing
from pathlib import Path

from korsi_plugin import MemoryEventLog, SQLiteEventLog

ONE = uuid.UUID(int=1)
TWO = uuid.UUID(int=2)


async def test_memory_claims_once_per_installation() -> None:
    log = MemoryEventLog()
    assert await log.first_time(ONE, "e")
    assert not await log.first_time(ONE, "e")
    assert await log.first_time(TWO, "e")
    await log.forget(ONE, "e")
    assert await log.first_time(ONE, "e")


async def test_memory_keeps_only_the_newest() -> None:
    log = MemoryEventLog(capacity=2)
    for name in ("a", "b", "c"):
        await log.first_time(ONE, name)
    assert await log.first_time(ONE, "a")
    assert not await log.first_time(ONE, "c")


async def test_sqlite_claims_once_even_when_racing(tmp_path: Path) -> None:
    log = SQLiteEventLog(tmp_path / "nested" / "events.db")
    claims = await asyncio.gather(*(log.first_time(ONE, "e") for _ in range(8)))
    assert claims.count(True) == 1
    await log.forget(ONE, "e")
    assert await log.first_time(ONE, "e")


async def test_sqlite_prunes_what_korsi_would_no_longer_retry(tmp_path: Path) -> None:
    path = tmp_path / "events.db"
    log = SQLiteEventLog(path)
    await log.first_time(ONE, "old")
    await log.first_time(ONE, "new")
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute(
            "UPDATE korsi_event_seen SET seen_at = datetime('now', '-30 days') "
            "WHERE event_id = 'old'"
        )
    assert await log.prune(older_than_days=7) == 1
    assert await log.first_time(ONE, "old")
    assert not await log.first_time(ONE, "new")
