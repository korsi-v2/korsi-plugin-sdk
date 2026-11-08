"""Feeds (ADR-0097, plugin API 1.8): declaring one, reading and checking a file, and the door.

The door is a fake that keeps runs as Korsi does: one per Idempotency-Key, batches by number.
"""

from __future__ import annotations

import io
import json
from typing import Any

import httpx
import pytest

from korsi_plugin import feed_cli
from korsi_plugin.errors import KorsiRefused
from korsi_plugin.feeds import (
    FeedSchema,
    SystemClient,
    SystemCredentials,
    batches,
    check_feeds,
    check_rows,
    define_feed,
    push,
    read_rows,
    run_key,
)

PEOPLE_SCHEMA: FeedSchema = {
    "feed": "korsi.people",
    "kind": "korsi",
    "names": {},
    "plugin_id": None,
    "record_type": None,
    "visibility": None,
    "source_key": "source_key",
    "person_fields": {},
    "upsert": None,
    "row_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["source_key"],
        "$defs": {"EmploymentType": {"type": "string", "enum": ["full_time", "part_time"]}},
        "properties": {
            "source_key": {"type": "string", "maxLength": 64},
            "given_name": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "family_name": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "weekly_hours": {"anyOf": [{"type": "integer", "maximum": 80}, {"type": "null"}]},
            "employment_type": {"anyOf": [{"$ref": "#/$defs/EmploymentType"}, {"type": "null"}]},
        },
    },
    "headers": {
        "source_key": {"fa": ["کد"], "en": ["Employee ID"]},
        "given_name": {"en": ["First name"]},
        "weekly_hours": {"en": ["Hours"]},
    },
    "refused_fields": ["national_id", "salary"],
    "sample": {},
    "max_rows": 5000,
}

CREDENTIALS = SystemCredentials(
    client_id="system-abc",
    client_secret="shown-once",
    token_endpoint="https://id.example.test/oauth/v2/token",
    scope="openid",
    api_base="https://acme.korsi.test/system/v1",
)


class FakeDoor:
    """Korsi's door, as much of it as a push needs."""

    def __init__(self) -> None:
        self.runs: dict[str, dict[str, Any]] = {}
        self.keys: dict[str, str] = {}
        self.calls: list[tuple[str, str]] = []
        self.tokens = 0
        self.throttle = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append((request.method, path))
        if path.endswith("/oauth/v2/token"):
            self.tokens += 1
            assert request.headers["authorization"].startswith("Basic ")
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        assert request.headers["authorization"] == "Bearer tok"
        assert request.headers["korsi-system-api"] == "1.0"
        if self.throttle:
            self.throttle -= 1
            return httpx.Response(
                429,
                headers={"retry-after": "1"},
                json={"code": "system.rate_limited", "params": {"retry_after_seconds": 1}},
            )
        rest = path.removeprefix("/system/v1")
        parts = rest.strip("/").split("/")
        if rest == "/connection":
            return httpx.Response(
                200,
                json={
                    "connection_id": "c1",
                    "name": "HR",
                    "mode": "active",
                    "feeds": [{"feed": "korsi.people", "create_people": True}],
                    "limits": {},
                },
            )
        if len(parts) == 2:
            return httpx.Response(200, json=PEOPLE_SCHEMA)
        if parts[2] == "runs" and len(parts) == 3:
            key = request.headers["idempotency-key"]
            if key in self.keys:
                return httpx.Response(200, json=self.runs[self.keys[key]])
            run_id = f"r{len(self.runs) + 1}"
            self.keys[key] = run_id
            self.runs[run_id] = {
                "id": run_id,
                "feed": "korsi.people",
                "status": "open",
                "rows": 0,
                "batches": {},
                "counts": {},
                "missing": 0,
                **json.loads(request.content),
            }
            return httpx.Response(201, json=self.runs[run_id])
        run = self.runs.get(parts[3]) if len(parts) > 3 else None
        if run is None:
            return httpx.Response(404, json={"code": "resource.not_found"})
        if len(parts) == 6 and parts[4] == "batches":
            rows = json.loads(request.content)["rows"]
            run["batches"][parts[5]] = rows
            return httpx.Response(200, json={"run_id": run["id"], "seq": int(parts[5])})
        if len(parts) == 5 and parts[4] == "commit":
            count = sum(len(rows) for rows in run["batches"].values())
            run["rows"] = count
            run["status"] = "trial" if run.get("dry_run") else "applied"
            run["counts"] = {"created": count - 1, "waiting": 1}
            return httpx.Response(200, json=run)
        if len(parts) == 5 and parts[4] == "apply":
            run["status"] = "applied"
            return httpx.Response(200, json=run)
        if len(parts) == 4:
            outcomes = [
                {"position": 0, "source_key": "E-1", "status": "created"},
                {"position": 1, "source_key": "E-2", "status": "waiting", "reason": "no_match"},
            ]
            return httpx.Response(200, json={"run": run, "outcomes": outcomes, "next_after": None})
        return httpx.Response(404, json={"code": "resource.not_found"})


def client_for(door: FakeDoor) -> SystemClient:
    async def no_wait(_: float) -> None:
        return None

    return SystemClient(
        CREDENTIALS,
        http=httpx.AsyncClient(transport=httpx.MockTransport(door)),
        sleep=no_wait,
    )


def test_define_feed_and_what_korsi_would_refuse() -> None:
    feed = define_feed(
        "tickets",
        names={"en": "Tickets"},
        consent={"en": "Tickets from your ticket system."},
        record_type="ticket",
        source_key="ticket_no",
        fields=["title", "assignee"],
        person_fields={"assignee": ["email", "personnel_number"]},
    )
    assert feed["person_fields"] == [{"field": "assignee", "match": ["email", "personnel_number"]}]
    manifest: dict[str, Any] = {
        "scopes": {"required": ["records.own"]},
        "record_types": [
            {
                "key": "ticket",
                "visibility": "organization",
                "schema": {
                    "properties": {
                        "ticket_no": {"type": "string", "maxLength": 40},
                        "title": {"type": "string"},
                        "assignee": {"type": "string"},
                    }
                },
            }
        ],
        "feeds": [feed],
    }
    assert check_feeds(manifest) == []
    manifest["record_types"][0]["visibility"] = "case"
    manifest["scopes"] = {"required": []}
    problems = check_feeds(manifest)
    assert any("records.own" in problem for problem in problems)
    assert any("case_members" in problem for problem in problems)
    manifest["feeds"] = [{**feed, "fields": ["title", "assignee", "missing"]}]
    assert any("does not declare" in problem for problem in check_feeds(manifest))


def test_a_file_is_read_by_its_header_words_and_what_is_never_kept_is_not_read() -> None:
    text = "﻿کد,First name,Hours,Salary,Shoe size\nE-1,Sara,44,100,40\nE-2,,,,\n"
    read = read_rows(io.StringIO(text), PEOPLE_SCHEMA)
    assert read.rows == [
        {"source_key": "E-1", "given_name": "Sara", "weekly_hours": 44},
        {"source_key": "E-2"},
    ]
    assert read.refused_columns == ["Salary"]
    assert read.unknown_columns == ["Shoe size"]
    lines = read_rows(io.StringIO('{"source_key": "E-3"}\n{"source_key": "E-4"}\n'), PEOPLE_SCHEMA)
    assert [row["source_key"] for row in lines.rows] == ["E-3", "E-4"]


def test_rows_are_checked_offline_as_korsi_would_on_arrival() -> None:
    rows: list[dict[str, Any]] = [
        {"source_key": "E-1", "weekly_hours": 44, "employment_type": "full_time"},
        {"source_key": "E-2", "national_id": "1"},
        {"source_key": "E-3", "shoe": 40},
        {"given_name": "No key"},
        {"source_key": "E-5", "weekly_hours": 99},
        {"source_key": "E-6", "employment_type": "seasonal"},
        {"source_key": "E-1"},
    ]
    found = {(p.position, p.field, p.reason.split(":")[0]) for p in check_rows(PEOPLE_SCHEMA, rows)}
    assert found == {
        (1, "national_id", "field_refused"),
        (2, "shoe", "field_unknown"),
        (3, "source_key", "required"),
        (4, "weekly_hours", "invalid"),
        (5, "employment_type", "invalid"),
        (6, "source_key", "duplicate_key"),
    }


def test_batches_keep_under_the_doors_limits_and_the_key_follows_the_rows() -> None:
    rows = [{"source_key": f"E-{index}"} for index in range(1201)]
    assert [len(chunk) for chunk in batches(rows)] == [500, 500, 201]
    wide = [{"source_key": str(index), "note": "x" * 3000} for index in range(400)]
    assert all(len(json.dumps(chunk)) < 1_000_000 for chunk in batches(wide))
    assert run_key("f", rows, complete=False, dry_run=False) == run_key(
        "f", rows, complete=False, dry_run=False
    )
    assert run_key("f", rows, complete=True, dry_run=False) != run_key(
        "f", rows, complete=False, dry_run=False
    )


async def test_push_opens_fills_and_commits_and_the_same_rows_again_are_the_same_run() -> None:
    door = FakeDoor()
    door.throttle = 1
    rows = [{"source_key": f"E-{index}"} for index in range(600)]
    async with client_for(door) as client:
        first = await push(client, "korsi.people", rows)
        again = await push(client, "korsi.people", rows)
    assert first.run["status"] == "applied"
    assert first.run["rows"] == 600
    assert [row["source_key"] for row in first.attention] == ["E-2"]
    assert again.run["id"] == first.run["id"]
    commits = [call for call in door.calls if call[1].endswith("/commit")]
    assert len(commits) == 1
    assert door.tokens == 1


async def test_a_refusal_carries_korsis_code() -> None:
    door = FakeDoor()
    async with client_for(door) as client:
        with pytest.raises(KorsiRefused) as refused:
            await client.request("GET", "/nothing/here/at/all/x/y")
    assert refused.value.code == "resource.not_found"


def test_the_command_line_pushes_a_file_and_says_what_waits(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    door = FakeDoor()
    monkeypatch.setattr(feed_cli, "SystemClient", lambda credentials: client_for(door))
    for name, value in {
        "KORSI_SYSTEM_CLIENT_ID": "system-abc",
        "KORSI_SYSTEM_CLIENT_SECRET": "shown-once",
        "KORSI_SYSTEM_TOKEN_ENDPOINT": "https://id.example.test/oauth/v2/token",
        "KORSI_SYSTEM_SCOPE": "openid",
        "KORSI_SYSTEM_API": "https://acme.korsi.test/system/v1",
    }.items():
        monkeypatch.setenv(name, value)
    staff = tmp_path / "staff.csv"
    staff.write_text("Employee ID,First name\nE-1,Sara\nE-2,Ali\n", encoding="utf-8")

    assert feed_cli.main(["push", str(staff), "--feed", "korsi.people"]) == feed_cli.ATTENTION
    out = capsys.readouterr().out
    assert "applied" in out
    assert "E-2: waiting (no_match)" in out

    assert feed_cli.main(["push", str(staff), "--feed", "korsi.people", "--dry-run"]) == (
        feed_cli.ATTENTION
    )
    dry = next(run for run in door.runs.values() if run.get("dry_run"))
    assert dry["status"] == "trial"
    assert feed_cli.main(["apply", dry["id"], "--feed", "korsi.people"]) == feed_cli.DONE
    assert door.runs[dry["id"]]["status"] == "applied"


def test_check_needs_no_korsi_with_a_saved_schema(
    tmp_path: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    schema = tmp_path / "people.json"
    schema.write_text(json.dumps(PEOPLE_SCHEMA), encoding="utf-8")
    staff = tmp_path / "staff.json"
    staff.write_text(json.dumps([{"source_key": "E-1"}, {"source_key": "E-2", "salary": 9}]))
    code = feed_cli.main(["check", str(staff), "--feed", "korsi.people", "--schema", str(schema)])
    assert code == feed_cli.INVALID
    assert "salary field_refused" in capsys.readouterr().out
