"""The event logs: a claim is atomic and leased, a failure gives it back, a death is taken over."""

from __future__ import annotations

import asyncio
import sqlite3
import uuid
from contextlib import closing
from pathlib import Path

from korsi_plugin import MemoryEventLog, SQLiteEventLog

ONE = uuid.UUID(int=1)
TWO = uuid.UUID(int=2)
LEASE = 60.0


async def test_memory_claims_finishes_and_forgets() -> None:
    log = MemoryEventLog()
    assert await log.claim(ONE, "e", lease_seconds=LEASE) == "new"
    assert await log.claim(ONE, "e", lease_seconds=LEASE) == "busy"
    assert await log.claim(TWO, "e", lease_seconds=LEASE) == "new"
    await log.forget(ONE, "e")
    assert await log.claim(ONE, "e", lease_seconds=LEASE) == "new"
    await log.finish(ONE, "e")
    assert await log.claim(ONE, "e", lease_seconds=LEASE) == "done"


async def test_memory_takes_over_a_claim_whose_lease_ran_out() -> None:
    log = MemoryEventLog()
    now = [1000.0]
    log._now = lambda: now[0]
    assert await log.claim(ONE, "e", lease_seconds=LEASE) == "new"
    now[0] += LEASE + 1  # the process holding it died
    assert await log.claim(ONE, "e", lease_seconds=LEASE) == "new"


async def test_memory_keeps_only_the_newest() -> None:
    log = MemoryEventLog(capacity=2)
    for name in ("a", "b", "c"):
        await log.claim(ONE, name, lease_seconds=LEASE)
        await log.finish(ONE, name)
    assert await log.claim(ONE, "a", lease_seconds=LEASE) == "new"
    assert await log.claim(ONE, "c", lease_seconds=LEASE) == "done"


async def test_sqlite_claims_once_even_when_racing(tmp_path: Path) -> None:
    log = SQLiteEventLog(tmp_path / "nested" / "events.db")
    claims = await asyncio.gather(*(log.claim(ONE, "e", lease_seconds=LEASE) for _ in range(8)))
    assert claims.count("new") == 1
    assert claims.count("busy") == 7
    await log.forget(ONE, "e")
    assert await log.claim(ONE, "e", lease_seconds=LEASE) == "new"
    await log.finish(ONE, "e")
    await log.forget(ONE, "e")  # a finished event is not given back
    assert await log.claim(ONE, "e", lease_seconds=LEASE) == "done"


async def test_sqlite_takes_over_a_dead_claim_and_survives_a_restart(tmp_path: Path) -> None:
    path = tmp_path / "events.db"
    assert await SQLiteEventLog(path).claim(ONE, "e", lease_seconds=LEASE) == "new"
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("UPDATE korsi_event_log SET claimed_until = 0")
    restarted = SQLiteEventLog(path)
    assert await restarted.claim(ONE, "e", lease_seconds=LEASE) == "new"
    await restarted.finish(ONE, "e")
    assert await SQLiteEventLog(path).claim(ONE, "e", lease_seconds=LEASE) == "done"


async def test_sqlite_prunes_what_korsi_would_no_longer_retry(tmp_path: Path) -> None:
    path = tmp_path / "events.db"
    log = SQLiteEventLog(path)
    for name in ("old", "new"):
        await log.claim(ONE, name, lease_seconds=LEASE)
        await log.finish(ONE, name)
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("UPDATE korsi_event_log SET done_at = 0 WHERE event_id = 'old'")
    assert await log.prune(older_than_days=7) == 1
    assert await log.claim(ONE, "old", lease_seconds=LEASE) == "new"
    assert await log.claim(ONE, "new", lease_seconds=LEASE) == "done"
