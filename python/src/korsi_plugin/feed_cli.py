"""``korsi-feed``: push a file to one of the organization's feeds in Korsi, from a command line.

What a customer's IT schedules on its own server -- every night, or after each export from the
personnel system. The connection's credential is read from the environment, as the «سامانه‌های
سازمان» page showed it once::

    KORSI_SYSTEM_CLIENT_ID      the connection's client id
    KORSI_SYSTEM_CLIENT_SECRET  its secret
    KORSI_SYSTEM_TOKEN_ENDPOINT the token endpoint the page named
    KORSI_SYSTEM_SCOPE          the scope the page named
    KORSI_SYSTEM_API            the door, https://<your korsi>/system/v1

Commands::

    korsi-feed whoami                              the connection, its mode and feeds
    korsi-feed schema korsi.people -o people.json  a feed's shape, to check files offline
    korsi-feed check staff.xlsx --feed korsi.people [--schema people.json]
    korsi-feed push staff.csv --feed korsi.people [--dry-run] [--complete] [--key KEY]
    korsi-feed status RUN_ID --feed korsi.people [--rows waiting]
    korsi-feed apply RUN_ID --feed korsi.people    apply your own dry run

Exit codes: 0 done (applied, or reported in trial), 2 held for the connection's owner (a large
change), 3 rows wait for a person or were refused, 4 the file has rows Korsi would refuse (check),
1 anything else. ``--json`` prints Korsi's answer as it came.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Final

from korsi_plugin.errors import KorsiError, KorsiRefused
from korsi_plugin.feeds import (
    FeedRowOutcome,
    FeedRunView,
    FeedSchema,
    SystemClient,
    SystemCredentials,
    check_rows,
    push,
    read_rows,
)

DONE: Final = 0
FAILED: Final = 1
HELD: Final = 2
ATTENTION: Final = 3
INVALID: Final = 4

_STATUS_WORDS: Final = {
    "applied": "applied: written",
    "trial": "reported only: nothing was written (trial mode or a dry run)",
    "held": "held: a large change, waiting for the connection's owner to press apply",
    "open": "open: still taking batches",
    "failed": "failed: nothing was written",
    "expired": "expired: nothing was written",
}


def _print(text: str) -> None:
    sys.stdout.write(text + "\n")


def _warn(text: str) -> None:
    sys.stderr.write(text + "\n")


def _summary(run: FeedRunView) -> str:
    counts = run["counts"]
    parts = ", ".join(f"{name} {value}" for name, value in counts.items())
    line = f"run {run['id']} ({run['feed']}): {_STATUS_WORDS.get(run['status'], run['status'])}"
    if run.get("held_reason"):
        line += f" [{run['held_reason']}: {run.get('changes')} of {run.get('existing')}]"
    if run.get("missing"):
        line += f"; not in this list: {run['missing']}"
    return f"{line}\n  {parts}"


def _rows(outcomes: Sequence[FeedRowOutcome]) -> str:
    return "\n".join(
        f"  row {row['position']} {row.get('source_key') or '-'}: {row['status']}"
        + (f" ({row['reason']}" + (f": {row['field']}" if row.get("field") else "") + ")")
        * bool(row.get("reason"))
        for row in outcomes
    )


def _load(path: str) -> FeedSchema:
    loaded: FeedSchema = json.loads(Path(path).read_text(encoding="utf-8"))
    return loaded


def _save(path: str, text: str) -> None:
    Path(path).write_text(text, encoding="utf-8")


def _need(client: SystemClient | None) -> SystemClient:
    if client is None:
        msg = "set the connection's credentials (KORSI_SYSTEM_*)"
        raise RuntimeError(msg)
    return client


def _dump(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


async def _schema(client: SystemClient | None, feed: str, path: str | None) -> FeedSchema:
    if path:
        return _load(path)
    if client is None:
        msg = "give --schema, or set the connection's credentials to read the feed's shape"
        raise RuntimeError(msg)
    return await client.feed_schema(feed)


def _read(source: str, schema: FeedSchema) -> Any:
    if source == "-":
        import io

        return read_rows(io.StringIO(sys.stdin.read()), schema)
    return read_rows(source, schema)


async def _main(arguments: argparse.Namespace) -> int:
    command = arguments.command
    offline = command == "check" and arguments.schema
    client = None if offline else SystemClient(SystemCredentials.from_env())
    try:
        if command == "whoami":
            me = await _need(client).connection()
            if arguments.json:
                _print(_dump(me))
            else:
                _print(f"{me['name']} ({me['connection_id']}): {me['mode']}")
                for grant in me["feeds"]:
                    extra = "  creates people" if grant["create_people"] else ""
                    _print(f"  {grant['feed']}{extra}")
            return DONE
        if command == "schema":
            shape = await _need(client).feed_schema(arguments.feed)
            text = _dump(shape)
            if arguments.output:
                _save(arguments.output, text)
            else:
                _print(text)
            return DONE
        if command == "check":
            shape = await _schema(client, arguments.feed, arguments.schema)
            read = _read(arguments.file, shape)
            for column in read.refused_columns:
                _warn(f"column not read -- Korsi never keeps it: {column}")
            for column in read.unknown_columns:
                _warn(f"column not read -- no field of {arguments.feed} is called that: {column}")
            problems = check_rows(shape, read.rows)
            for problem in problems:
                _print(
                    f"row {problem.position} {problem.source_key or '-'}: "
                    f"{problem.field} {problem.reason}"
                )
            _print(f"{len(read.rows)} rows, {len(problems)} would be refused")
            return INVALID if problems else DONE
        if command == "push":
            client = _need(client)
            shape = await _schema(client, arguments.feed, arguments.schema)
            read = _read(arguments.file, shape)
            for column in (*read.refused_columns, *read.unknown_columns):
                _warn(f"column not read: {column}")
            if not read.rows:
                _warn("no rows to push")
                return FAILED
            limit = int(shape.get("max_rows") or 0)
            if limit and len(read.rows) > limit:
                _warn(f"{len(read.rows)} rows; one run of {arguments.feed} carries at most {limit}")
                return FAILED
            result = await push(
                client,
                arguments.feed,
                read.rows,
                complete=arguments.complete,
                dry_run=arguments.dry_run,
                key=arguments.key,
            )
            if arguments.json:
                _print(_dump({"run": result.run, "attention": result.attention}))
            else:
                _print(_summary(result.run))
                if result.attention:
                    _print(_rows(result.attention))
            if result.run["status"] == "held":
                return HELD
            return ATTENTION if result.attention else DONE
        if command == "status":
            client = _need(client)
            report = await client.run(arguments.feed, arguments.run_id)
            rows = await client.outcomes(arguments.feed, arguments.run_id, status=arguments.rows)
            if arguments.json:
                _print(_dump({"run": report["run"], "outcomes": rows}))
            else:
                _print(_summary(report["run"]))
                if rows:
                    _print(_rows(rows))
            return HELD if report["run"]["status"] == "held" else DONE
        if command == "apply":
            run = await _need(client).apply(arguments.feed, arguments.run_id)
            _print(_dump(run) if arguments.json else _summary(run))
            return HELD if run["status"] == "held" else DONE
        return FAILED
    except KorsiRefused as error:
        _warn(f"Korsi refused: {error.code}" + (f" -- {error.title}" if error.title else ""))
        if error.params:
            _warn(f"  {json.dumps(dict(error.params), ensure_ascii=False)}")
        return FAILED
    except (KorsiError, RuntimeError, OSError, ValueError) as error:
        _warn(str(error))
        return FAILED
    finally:
        if client is not None:
            await client.aclose()


def parser() -> argparse.ArgumentParser:
    made = argparse.ArgumentParser(
        prog="korsi-feed",
        description="Push a file to one of the organization's feeds in Korsi.",
        epilog="The connection's credential comes from KORSI_SYSTEM_* environment variables.",
    )
    made.add_argument("--json", action="store_true", help="print Korsi's answers as JSON")
    commands = made.add_subparsers(dest="command", required=True)
    commands.add_parser("whoami", help="the connection, its mode and its feeds")
    schema = commands.add_parser("schema", help="a feed's shape, to check files offline")
    schema.add_argument("feed")
    schema.add_argument("-o", "--output")
    check = commands.add_parser("check", help="what Korsi would refuse in a file, before pushing")
    check.add_argument("file", help="a .csv, .json, .jsonl or .xlsx file, or - for stdin")
    check.add_argument("--feed", required=True)
    check.add_argument("--schema", help="a schema saved with `korsi-feed schema`: no Korsi needed")
    send = commands.add_parser("push", help="push a file as one run")
    send.add_argument("file", help="a .csv, .json, .jsonl or .xlsx file, or - for stdin")
    send.add_argument("--feed", required=True)
    send.add_argument("--dry-run", action="store_true", help="match and report, write nothing")
    send.add_argument(
        "--complete",
        action="store_true",
        help="this is the whole list: what Korsi holds and it lacks is marked (never removed)",
    )
    send.add_argument("--key", help="the run's Idempotency-Key; by default, from the rows")
    send.add_argument("--schema", help="a saved schema, instead of reading it from Korsi")
    status = commands.add_parser("status", help="a run's status and its rows")
    status.add_argument("run_id")
    status.add_argument("--feed", required=True)
    status.add_argument("--rows", help="only rows of this outcome: waiting, refused, created...")
    apply = commands.add_parser("apply", help="apply your own dry run, after reading it")
    apply.add_argument("run_id")
    apply.add_argument("--feed", required=True)
    return made


def main(argv: Sequence[str] | None = None) -> int:
    """The entry point. Returns the exit code."""
    return asyncio.run(_main(parser().parse_args(argv)))


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
