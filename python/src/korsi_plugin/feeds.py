"""Feeds: what an organization's own systems write into Korsi, and the door they write through.

Two halves, for two different readers (ADR-0097, plugin API 1.8):

**A plugin declares a feed** in its manifest -- a shape an organization's ticket system, ERP or
script may write into the plugin's own records. :func:`define_feed` builds the entry and
:func:`check_feeds` finds, before Korsi does, what Korsi would refuse in it. The plugin never talks
to the system: it stays ``egress: none``, reads its records as always, and learns that a run was
applied from the ``plugin.feed.run`` event.

**An organization's IT writes a feed** through Korsi's machine door, ``/system/v1``, with a system
connection's client id and secret from the «سامانه‌های سازمان» page. :class:`SystemClient` gets
the token (``grant_type=client_credentials`` at ZITADEL's token endpoint) and makes the calls;
:func:`push` opens a run, sends it in batches and commits it; :func:`read_rows` reads a CSV, JSON,
JSON-lines or (with ``openpyxl`` installed) XLSX file into rows by the feed's header words; and
:func:`check_rows` validates rows against a feed's published schema without asking Korsi. The
``korsi-feed`` command (:mod:`korsi_plugin.feed_cli`) is all of it on a command line.

Korsi's own feed is the staff list, ``korsi.people``; a plugin's is ``<plugin id>.<key>``.
"""

from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import os
import re
import time
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Final, Literal, TypedDict

import httpx

from korsi_plugin.errors import KorsiRefused, KorsiUnreachable
from korsi_plugin.manifest import FeedPersonField, FeedSpec, LocalizedText

#: The door's contract version, sent by Korsi on every answer.
SYSTEM_API: Final = "1.0"
SYSTEM_VERSION_HEADER: Final = "Korsi-System-API"
#: Korsi's own feed: the staff list.
PEOPLE_FEED: Final = "korsi.people"
#: Rows and bytes one batch may carry.
BATCH_MAX_ROWS: Final = 500
BATCH_MAX_BYTES: Final = 1_000_000
#: The most feeds one plugin declares, and the longest key a plugin feed's row may carry.
MAX_FEEDS: Final = 5
MAX_FEED_SOURCE_KEY: Final = 200
#: The environment variables the credentials are read from (:meth:`SystemCredentials.from_env`).
ENV_CLIENT_ID: Final = "KORSI_SYSTEM_CLIENT_ID"
ENV_CLIENT_SECRET: Final = "KORSI_SYSTEM_CLIENT_SECRET"  # noqa: S105 -- a variable's name
ENV_TOKEN_ENDPOINT: Final = "KORSI_SYSTEM_TOKEN_ENDPOINT"  # noqa: S105 -- a variable's name
ENV_SCOPE: Final = "KORSI_SYSTEM_SCOPE"
ENV_API_BASE: Final = "KORSI_SYSTEM_API"

ConnectionMode = Literal["trial", "active", "paused"]
RunStatus = Literal["open", "trial", "held", "applied", "failed", "expired"]
RowStatus = Literal["pending", "created", "updated", "unchanged", "waiting", "refused"]

_FEED_KEY = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
_FIELD_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_FEEDABLE = frozenset({"organization", "case_members"})


# ---------------------------------------------------------------------------
# The door's shapes (`/system/v1`)
# ---------------------------------------------------------------------------


class FeedGrant(TypedDict):
    feed: str
    create_people: bool


class SystemLimits(TypedDict):
    requests_per_minute: int
    runs_per_hour: int
    row_puts_per_hour: int
    batch_max_rows: int
    batch_max_bytes: int


class SystemSelf(TypedDict):
    """``GET /system/v1/connection``."""

    connection_id: str
    name: str
    mode: ConnectionMode
    feeds: list[FeedGrant]
    limits: SystemLimits


class FeedSchema(TypedDict):
    """``GET /system/v1/feeds/{feed}``: a row's JSON Schema, the file headers and a sample."""

    feed: str
    kind: Literal["korsi", "plugin"]
    names: dict[str, str | None]
    plugin_id: str | None
    record_type: str | None
    visibility: str | None
    source_key: str
    person_fields: dict[str, list[str]]
    upsert: str | None
    row_schema: dict[str, Any]
    headers: dict[str, dict[str, list[str]]]
    refused_fields: list[str]
    sample: dict[str, Any]
    max_rows: int


class FeedCounts(TypedDict):
    created: int
    updated: int
    unchanged: int
    waiting: int
    refused: int


class FeedRunView(TypedDict):
    id: str
    feed: str
    status: RunStatus
    complete: bool
    dry_run: bool
    connection_id: str | None
    by_person: bool
    rows: int
    counts: FeedCounts
    held_reason: str | None
    changes: int | None
    existing: int | None
    missing: int
    created_at: str
    committed_at: str | None
    applied_at: str | None
    applied_by_name: str | None
    expires_at: str | None


class FeedRowOutcome(TypedDict):
    id: str
    position: int
    source_key: str | None
    status: RowStatus
    action: str | None
    reason: str | None
    field: str | None
    member_id: str | None
    record_id: str | None
    display_name: str | None
    notes: list[str]


class FeedRunReport(TypedDict):
    run: FeedRunView
    outcomes: list[FeedRowOutcome]
    next_after: int | None


class BatchReceipt(TypedDict):
    run_id: str
    seq: int
    repeated: bool
    accepted: int
    outcomes: list[FeedRowOutcome]


class FedRow(TypedDict):
    source_key: str
    member_id: str | None
    record_id: str | None
    fields: dict[str, Any]
    updated_at: str | None
    missing_since: str | None


class FedRowResult(TypedDict):
    run: FeedRunView | None
    outcome: FeedRowOutcome


# ---------------------------------------------------------------------------
# Declaring a feed in a plugin's manifest
# ---------------------------------------------------------------------------


class _Header(TypedDict, total=False):
    fa: list[str]
    en: list[str]
    ar: list[str]


def define_feed(
    key: str,
    *,
    names: LocalizedText,
    consent: LocalizedText,
    record_type: str,
    source_key: str,
    fields: Sequence[str],
    person_fields: Mapping[str, Sequence[Literal["source_key", "personnel_number", "email"]]]
    | None = None,
    upsert: Literal["merge", "replace"] = "merge",
    on_missing: Literal["keep", "mark"] = "keep",
    max_rows: int = 5000,
    headers: Mapping[str, _Header] | None = None,
) -> FeedSpec:
    """A manifest's ``feeds`` entry. ``person_fields`` maps each field naming a colleague to how
    Korsi finds them, in order: ``{"assignee": ["email", "personnel_number"]}``."""
    spec: FeedSpec = {
        "key": key,
        "names": names,
        "consent": consent,
        "record_type": record_type,
        "source_key": source_key,
        "fields": list(fields),
        "upsert": upsert,
        "on_missing": on_missing,
        "max_rows": max_rows,
    }
    if person_fields:
        people: list[FeedPersonField] = [
            {"field": name, "match": list(ways)} for name, ways in person_fields.items()
        ]
        spec["person_fields"] = people
    if headers:
        spec["headers"] = {name: dict(words) for name, words in headers.items()}
    return spec


def _types(prop: Mapping[str, Any]) -> set[str]:
    declared = prop.get("type")
    if isinstance(declared, str):
        return {declared} - {"null"}
    if isinstance(declared, list):
        return {str(item) for item in declared} - {"null"}
    return set()


def check_feeds(manifest: Mapping[str, Any]) -> list[str]:
    """What Korsi would refuse in a manifest's ``feeds``, one sentence each; empty when nothing.

    The same rules Korsi applies when it reads the manifest: at most five feeds, each into one of
    the plugin's own record types that the whole organization or only the plugin reads, setting
    properties its schema declares, keyed by a string with a ``maxLength`` of at most 200; a person
    field holds a member id, so a string; and feeds need the ``records.own`` scope.
    """
    feeds = list(manifest.get("feeds") or [])
    if not feeds:
        return []
    problems: list[str] = []
    if len(feeds) > MAX_FEEDS:
        problems.append(f"a plugin declares at most {MAX_FEEDS} feeds")
    scopes = manifest.get("scopes") or {}
    if "records.own" not in {*(scopes.get("required") or []), *(scopes.get("optional") or [])}:
        problems.append("feeds write records, so they need the records.own scope")
    types = {item.get("key"): item for item in manifest.get("record_types") or []}
    keys = [feed.get("key") for feed in feeds]
    if len(set(keys)) != len(keys):
        problems.append("feed keys repeat")
    for feed in feeds:
        key = str(feed.get("key"))
        label = f"feed {key}"
        if not _FEED_KEY.match(key):
            problems.append(f"{label}: a key is lower case, a letter first, at most 40 characters")
        fields = list(feed.get("fields") or [])
        source_key = str(feed.get("source_key"))
        if not fields:
            problems.append(f"{label}: it sets at least one field")
        for name in (*fields, source_key):
            if not _FIELD_NAME.match(name):
                problems.append(f"{label}: {name!r} is not a property name")
        if source_key in fields:
            problems.append(f"{label}: the source key is the record's id, not one of its fields")
        people = [item.get("field") for item in feed.get("person_fields") or []]
        outside = sorted(str(name) for name in set(people) - set(fields))
        if outside:
            problems.append(f"{label}: person fields are fields the feed sets, not {outside}")
        unknown = sorted(set(feed.get("headers") or {}) - {*fields, source_key})
        if unknown:
            problems.append(f"{label}: headers name properties the feed does not carry: {unknown}")
        record = types.get(feed.get("record_type"))
        if record is None:
            problems.append(f"{label} writes {feed.get('record_type')}, a record type not declared")
            continue
        if record.get("visibility") not in _FEEDABLE:
            problems.append(
                f"{label}: a fed type is organization or case_members, "
                f"not {record.get('visibility')}"
            )
        properties = (record.get("schema") or {}).get("properties") or {}
        missing = [name for name in fields if not isinstance(properties.get(name), dict)]
        if missing:
            problems.append(f"{label} sets {missing}, which the schema does not declare")
        key_prop = properties.get(source_key)
        if isinstance(key_prop, dict):
            limit = key_prop.get("maxLength")
            if _types(key_prop) != {"string"}:
                problems.append(f"{label}: its source key {source_key} is a string")
            elif not isinstance(limit, int) or limit > MAX_FEED_SOURCE_KEY:
                problems.append(
                    f"{label}: its source key bounds its length "
                    f"(maxLength <= {MAX_FEED_SOURCE_KEY})"
                )
        for name in people:
            prop = properties.get(name)
            if isinstance(prop, dict) and not _types(prop) <= {"string"}:
                problems.append(f"{label}: person field {name} holds a member id, so a string")
    return problems


# ---------------------------------------------------------------------------
# Reading and checking rows
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ReadRows:
    """Rows read from a file, and what of the file was not read."""

    rows: list[dict[str, Any]]
    #: Columns no field of the feed is called, by their header: not read.
    unknown_columns: list[str] = field(default_factory=list)
    #: Columns of what Korsi never keeps (a national id, a salary): not read, said by name.
    refused_columns: list[str] = field(default_factory=list)


def _fold(word: str) -> str:
    return " ".join(word.replace("﻿", "").replace("‌", " ").split()).casefold()


def header_index(schema: FeedSchema) -> dict[str, str]:
    """Every word a file's header may be, folded, to the field it is."""
    index: dict[str, str] = {}
    properties = (schema.get("row_schema") or {}).get("properties") or {}
    for name in properties:
        index[_fold(name)] = name
    for name, languages in (schema.get("headers") or {}).items():
        for words in languages.values():
            for word in words:
                index.setdefault(_fold(word), name)
    return index


def _property(schema: FeedSchema, name: str) -> dict[str, Any]:
    row = schema.get("row_schema") or {}
    prop = (row.get("properties") or {}).get(name) or {}
    return _resolve(row, prop)


def _resolve(root: Mapping[str, Any], prop: Mapping[str, Any]) -> dict[str, Any]:
    """A property with ``$ref`` and a nullable ``anyOf`` flattened, the way pydantic writes
    optional fields: ``{"anyOf": [{"$ref": "#/$defs/Kind"}, {"type": "null"}]}``."""
    current = dict(prop)
    if "$ref" in current:
        target = str(current.pop("$ref")).rsplit("/", 1)[-1]
        current = {**dict((root.get("$defs") or {}).get(target) or {}), **current}
    options = current.get("anyOf")
    if isinstance(options, list):
        concrete = [item for item in options if item.get("type") != "null"]
        if len(concrete) == 1:
            merged = {key: value for key, value in current.items() if key != "anyOf"}
            current = {**_resolve(root, concrete[0]), **merged}
    return current


def _coerce(value: str, prop: Mapping[str, Any]) -> Any:
    """A cell's text as the property's type: a number for a number, a flag for a flag."""
    kinds = _types(prop)
    text = value.strip()
    if "integer" in kinds and re.fullmatch(r"[+-]?\d+", text):
        return int(text)
    if "number" in kinds and re.fullmatch(r"[+-]?\d+(\.\d+)?", text):
        return float(text)
    if "boolean" in kinds and text.casefold() in ("true", "false", "1", "0", "yes", "no"):
        return text.casefold() in ("true", "1", "yes")
    return text


def _table_rows(
    schema: FeedSchema, header: Sequence[Any], body: Iterable[Sequence[Any]]
) -> ReadRows:
    index = header_index(schema)
    refused = {_fold(name) for name in schema.get("refused_fields") or []}
    columns: list[str | None] = []
    result = ReadRows(rows=[])
    for cell in header:
        word = _fold(str(cell or ""))
        target = index.get(word)
        if target is None and word:
            (result.refused_columns if word in refused else result.unknown_columns).append(
                str(cell)
            )
        columns.append(target)
    for line in body:
        row: dict[str, Any] = {}
        for name, cell in zip(columns, line, strict=False):
            if name is None or cell is None:
                continue
            if isinstance(cell, str):
                if not cell.strip():
                    continue  # an empty cell never erases
                row[name] = _coerce(cell, _property(schema, name))
            elif isinstance(cell, date):
                row[name] = cell.isoformat()[:10]
            else:
                row[name] = cell
        if row:
            result.rows.append(row)
    return result


def read_rows(source: str | Path | io.TextIOBase, schema: FeedSchema) -> ReadRows:
    """Rows from a file in the feed's shape.

    ``.csv`` (UTF-8, a byte-order mark allowed, the first line its headers, comma or semicolon),
    ``.json`` (a list of objects), ``.jsonl``/``.ndjson`` (one object a line), or ``.xlsx`` (the
    first sheet; needs ``openpyxl``). A header is a field's own name or one of the feed's header
    words in any language; other columns are not read and are listed. An empty cell is left out,
    so it erases nothing. ``-`` reads JSON lines or CSV from standard input.
    """
    if isinstance(source, io.TextIOBase):
        text = source.read()
        stripped = text.lstrip()
        if stripped.startswith(("{", "[")):
            return _json_rows(stripped)
        return _csv_rows(schema, text)
    path = Path(source)
    suffix = path.suffix.lower()
    if suffix in (".json", ".jsonl", ".ndjson"):
        return _json_rows(path.read_text(encoding="utf-8-sig"))
    if suffix in (".xlsx", ".xlsm"):
        try:
            from openpyxl import load_workbook  # type: ignore[import-untyped]
        except ImportError as error:  # pragma: no cover - depends on the environment
            msg = "reading .xlsx needs openpyxl (pip install openpyxl), or save the sheet as CSV"
            raise RuntimeError(msg) from error
        book = load_workbook(path, read_only=True, data_only=True)
        sheet = book.worksheets[0]
        lines = list(sheet.iter_rows(values_only=True))
        if not lines:
            return ReadRows(rows=[])
        return _table_rows(schema, lines[0], lines[1:])
    return _csv_rows(schema, path.read_text(encoding="utf-8-sig"))


def _csv_rows(schema: FeedSchema, text: str) -> ReadRows:
    sample = text[:4096]
    try:
        dialect: type[csv.Dialect] | csv.Dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    lines = list(csv.reader(io.StringIO(text), dialect))
    if not lines:
        return ReadRows(rows=[])
    return _table_rows(schema, lines[0], lines[1:])


def _json_rows(text: str) -> ReadRows:
    stripped = text.strip()
    if not stripped:
        return ReadRows(rows=[])
    if stripped.startswith("["):
        loaded = json.loads(stripped)
        rows = [dict(item) for item in loaded if isinstance(item, dict)]
    else:
        rows = [json.loads(line) for line in stripped.splitlines() if line.strip()]
    return ReadRows(rows=[row for row in rows if isinstance(row, dict)])


@dataclass(frozen=True, slots=True)
class RowProblem:
    """Why one row would be refused: its position, its key, the field and the reason."""

    position: int
    source_key: str | None
    field: str
    reason: str


_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _value_problem(value: Any, prop: Mapping[str, Any]) -> str | None:
    if value is None:
        return None
    kinds = _types(prop)
    if kinds:
        fits = (
            ("string" in kinds and isinstance(value, str))
            or ("integer" in kinds and isinstance(value, int) and not isinstance(value, bool))
            or (
                "number" in kinds and isinstance(value, int | float) and not isinstance(value, bool)
            )
            or ("boolean" in kinds and isinstance(value, bool))
            or ("object" in kinds and isinstance(value, dict))
            or ("array" in kinds and isinstance(value, list))
        )
        if not fits:
            return f"is not a {' or '.join(sorted(kinds))}"
    choices = prop.get("enum")
    if isinstance(choices, list) and value not in choices:
        return f"is not one of {choices}"
    if isinstance(value, str):
        if isinstance(prop.get("maxLength"), int) and len(value) > prop["maxLength"]:
            return f"is longer than {prop['maxLength']}"
        if isinstance(prop.get("minLength"), int) and len(value) < prop["minLength"]:
            return f"is shorter than {prop['minLength']}"
        pattern = prop.get("pattern")
        if isinstance(pattern, str) and not re.search(pattern, value):
            return "does not have the expected form"
        if prop.get("format") == "date" and not _DATE.match(value):
            return "is not a day (YYYY-MM-DD)"
    if isinstance(value, int | float) and not isinstance(value, bool):
        if isinstance(prop.get("minimum"), int | float) and value < prop["minimum"]:
            return f"is less than {prop['minimum']}"
        if isinstance(prop.get("maximum"), int | float) and value > prop["maximum"]:
            return f"is more than {prop['maximum']}"
    return None


def check_rows(schema: FeedSchema, rows: Sequence[Mapping[str, Any]]) -> list[RowProblem]:
    """What Korsi would refuse on arrival, without asking it: a field Korsi refuses by name, a
    property the feed does not carry, a missing key, a value not of its kind, the same key twice.
    Korsi checks again, and only Korsi can say who a row is."""
    row_schema = schema.get("row_schema") or {}
    properties: Mapping[str, Any] = row_schema.get("properties") or {}
    required = list(row_schema.get("required") or [])
    refused = set(schema.get("refused_fields") or [])
    key_name = schema.get("source_key") or "source_key"
    problems: list[RowProblem] = []
    seen: set[str] = set()
    for position, row in enumerate(rows):
        raw_key = row.get(key_name)
        key = str(raw_key) if raw_key not in (None, "") else None
        found: tuple[str, str] | None = None
        for name in row:
            if name in refused:
                found = (name, "field_refused")
                break
            if name not in properties:
                found = (name, "field_unknown")
                break
        if found is None:
            for name in required:
                if row.get(name) in (None, ""):
                    found = (name, "required")
                    break
        if found is None:
            for name, value in row.items():
                reason = _value_problem(value, _property(schema, name))
                if reason is not None:
                    found = (name, f"invalid: {reason}")
                    break
        if found is None and key is not None:
            if key in seen:
                found = (key_name, "duplicate_key")
            seen.add(key)
        if found is not None:
            problems.append(RowProblem(position, key, found[0], found[1]))
    return problems


# ---------------------------------------------------------------------------
# The door
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SystemCredentials:
    """A system connection's credential, as the connections page showed it once.

    Read from the environment by :meth:`from_env`; never put the secret in a file you commit."""

    client_id: str
    client_secret: str
    token_endpoint: str
    scope: str
    api_base: str

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> SystemCredentials:
        values = os.environ if env is None else env
        names = (ENV_CLIENT_ID, ENV_CLIENT_SECRET, ENV_TOKEN_ENDPOINT, ENV_SCOPE, ENV_API_BASE)
        missing = [name for name in names if not values.get(name)]
        if missing:
            msg = "set " + ", ".join(missing) + " from the connection's credential"
            raise RuntimeError(msg)
        return cls(
            client_id=values[ENV_CLIENT_ID],
            client_secret=values[ENV_CLIENT_SECRET],
            token_endpoint=values[ENV_TOKEN_ENDPOINT],
            scope=values[ENV_SCOPE],
            api_base=values[ENV_API_BASE].rstrip("/"),
        )


class _Token(TypedDict):
    value: str
    expires: float


class RetryPolicy(TypedDict):
    attempts: int
    max_wait_seconds: float


DEFAULT_RETRY: Final[RetryPolicy] = {"attempts": 5, "max_wait_seconds": 120.0}


class SystemClient:
    """Korsi's machine door, ``/system/v1``, as one system connection.

    The token comes from the issuer with the connection's client credentials and is renewed before
    it expires, and once more when Korsi answers ``401``. A ``429`` waits as long as
    ``Retry-After`` says; a ``5xx`` or a dropped connection is tried again with the same request --
    every write here is idempotent (a run by its key, a batch by its number, a row by its key and
    content).
    """

    def __init__(
        self,
        credentials: SystemCredentials,
        *,
        http: httpx.AsyncClient | None = None,
        retry: RetryPolicy = DEFAULT_RETRY,
        sleep: Any = asyncio.sleep,
    ) -> None:
        self.credentials = credentials
        self._http = http or httpx.AsyncClient(timeout=60.0)
        self._own_http = http is None
        self._token: _Token | None = None
        self._retry = retry
        self._sleep = sleep

    async def aclose(self) -> None:
        if self._own_http:
            await self._http.aclose()

    async def __aenter__(self) -> SystemClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def _bearer(self, *, renew: bool = False) -> str:
        now = time.monotonic()
        if not renew and self._token is not None and self._token["expires"] > now + 60:
            return self._token["value"]
        try:
            answer = await self._http.post(
                self.credentials.token_endpoint,
                data={"grant_type": "client_credentials", "scope": self.credentials.scope},
                auth=(self.credentials.client_id, self.credentials.client_secret),
            )
        except httpx.HTTPError as error:
            raise KorsiUnreachable(f"the token endpoint did not answer: {error}") from error
        if answer.status_code != 200:
            raise KorsiRefused(
                answer.status_code,
                "auth.token_refused",
                "the token endpoint refused the connection's credentials -- check the client id "
                "and secret, or make a new secret on the connections page",
                problem=False,
            )
        body = answer.json()
        self._token = {
            "value": str(body["access_token"]),
            "expires": now + float(body.get("expires_in") or 300),
        }
        return self._token["value"]

    async def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        """One call to the door, retried as the class says. Returns the decoded answer."""
        url = self.credentials.api_base + path
        renewed = False
        for attempt in range(1, self._retry["attempts"] + 1):
            bearer = await self._bearer()
            sent = {
                "Authorization": f"Bearer {bearer}",
                SYSTEM_VERSION_HEADER: SYSTEM_API,
                **(headers or {}),
            }
            try:
                answer = await self._http.request(
                    method,
                    url,
                    json=json_body,
                    params={k: v for k, v in (params or {}).items() if v is not None},
                    headers=sent,
                )
            except httpx.HTTPError as error:
                if attempt == self._retry["attempts"]:
                    raise KorsiUnreachable(f"Korsi did not answer: {error}") from error
                await self._sleep(min(2.0**attempt, self._retry["max_wait_seconds"]))
                continue
            if answer.status_code == 401 and not renewed:
                renewed = True
                await self._bearer(renew=True)
                continue
            if answer.status_code == 429 and attempt < self._retry["attempts"]:
                wait = float(answer.headers.get("retry-after") or 2.0**attempt)
                await self._sleep(min(wait, self._retry["max_wait_seconds"]))
                continue
            if answer.status_code >= 500 and attempt < self._retry["attempts"]:
                await self._sleep(min(2.0**attempt, self._retry["max_wait_seconds"]))
                continue
            if answer.status_code >= 400:
                raise _refusal(answer)
            return answer.json() if answer.content else None
        msg = "unreachable"  # pragma: no cover - the loop always returns or raises
        raise AssertionError(msg)

    async def connection(self) -> SystemSelf:
        result: SystemSelf = await self.request("GET", "/connection")
        return result

    async def feed_schema(self, feed: str) -> FeedSchema:
        result: FeedSchema = await self.request("GET", f"/feeds/{feed}")
        return result

    async def open_run(
        self, feed: str, *, key: str, complete: bool = False, dry_run: bool = False
    ) -> FeedRunView:
        result: FeedRunView = await self.request(
            "POST",
            f"/feeds/{feed}/runs",
            json_body={"complete": complete, "dry_run": dry_run},
            headers={"Idempotency-Key": key},
        )
        return result

    async def add_batch(
        self, feed: str, run_id: str, seq: int, rows: Sequence[Mapping[str, Any]]
    ) -> BatchReceipt:
        result: BatchReceipt = await self.request(
            "POST", f"/feeds/{feed}/runs/{run_id}/batches/{seq}", json_body={"rows": list(rows)}
        )
        return result

    async def commit(self, feed: str, run_id: str) -> FeedRunView:
        result: FeedRunView = await self.request("POST", f"/feeds/{feed}/runs/{run_id}/commit")
        return result

    async def run(
        self, feed: str, run_id: str, *, after: int | None = None, status: str | None = None
    ) -> FeedRunReport:
        result: FeedRunReport = await self.request(
            "GET", f"/feeds/{feed}/runs/{run_id}", params={"after": after, "status": status}
        )
        return result

    async def outcomes(
        self, feed: str, run_id: str, *, status: str | None = None
    ) -> list[FeedRowOutcome]:
        """Every row's outcome, page after page."""
        found: list[FeedRowOutcome] = []
        after: int | None = None
        while True:
            page = await self.run(feed, run_id, after=after, status=status)
            found.extend(page["outcomes"])
            after = page["next_after"]
            if after is None:
                return found

    async def apply(self, feed: str, run_id: str) -> FeedRunView:
        """Apply this connection's own dry run, on a live connection, when it is no large change.
        A run that has become one is held for the connection's owner instead."""
        result: FeedRunView = await self.request("POST", f"/feeds/{feed}/runs/{run_id}/apply")
        return result

    async def put_row(self, feed: str, source_key: str, row: Mapping[str, Any]) -> FedRowResult:
        result: FedRowResult = await self.request(
            "PUT", f"/feeds/{feed}/rows/{source_key}", json_body=dict(row)
        )
        return result

    async def get_row(self, feed: str, source_key: str) -> FedRow:
        result: FedRow = await self.request("GET", f"/feeds/{feed}/rows/{source_key}")
        return result


def _refusal(answer: httpx.Response) -> KorsiRefused:
    try:
        body = answer.json()
    except ValueError:
        body = None
    if isinstance(body, dict) and "code" in body:
        retry = answer.headers.get("retry-after")
        return KorsiRefused(
            answer.status_code,
            str(body["code"]),
            body.get("title") or body.get("detail"),
            params=body.get("params"),
            request_id=body.get("request_id"),
            retry_after=float(retry) if retry else None,
        )
    return KorsiRefused(answer.status_code, f"http.{answer.status_code}", None, problem=False)


def run_key(feed: str, rows: Sequence[Mapping[str, Any]], *, complete: bool, dry_run: bool) -> str:
    """A run's ``Idempotency-Key`` from what it carries: the same rows again are the same run, so a
    job that is retried, or run twice, writes them once."""
    digest = hashlib.sha256()
    digest.update(f"{feed}|{complete}|{dry_run}|".encode())
    for row in rows:
        digest.update(json.dumps(row, sort_keys=True, ensure_ascii=False).encode())
        digest.update(b"\n")
    return f"korsi-feed-{digest.hexdigest()[:40]}"


def batches(rows: Sequence[Mapping[str, Any]]) -> list[list[Mapping[str, Any]]]:
    """Rows split into batches the door takes: at most 500 rows and under a megabyte each."""
    found: list[list[Mapping[str, Any]]] = []
    current: list[Mapping[str, Any]] = []
    size = 20
    for row in rows:
        width = len(json.dumps(row, ensure_ascii=False).encode()) + 1
        if current and (len(current) >= BATCH_MAX_ROWS or size + width > BATCH_MAX_BYTES - 1000):
            found.append(current)
            current, size = [], 20
        current.append(row)
        size += width
    if current:
        found.append(current)
    return found


@dataclass(slots=True)
class PushResult:
    run: FeedRunView
    #: The rows that wait for a person or were refused, with why.
    attention: list[FeedRowOutcome]


async def push(
    client: SystemClient,
    feed: str,
    rows: Sequence[Mapping[str, Any]],
    *,
    complete: bool = False,
    dry_run: bool = False,
    key: str | None = None,
) -> PushResult:
    """Open a run, send ``rows`` in batches, commit it, and read what needs attention.

    The run's key is :func:`run_key` unless given, so pushing the same rows again -- a job retried
    after a network failure -- finds the same run rather than writing twice. A run that was already
    committed is read back as it is.
    """
    idempotency = key or run_key(feed, rows, complete=complete, dry_run=dry_run)
    run = await client.open_run(feed, key=idempotency, complete=complete, dry_run=dry_run)
    if run["status"] == "open":
        for seq, chunk in enumerate(batches(rows)):
            await client.add_batch(feed, run["id"], seq, chunk)
        run = await client.commit(feed, run["id"])
    attention = [
        row
        for row in await client.outcomes(feed, run["id"])
        if row["status"] in ("waiting", "refused")
    ]
    return PushResult(run=run, attention=attention)


__all__ = [
    "BATCH_MAX_BYTES",
    "BATCH_MAX_ROWS",
    "DEFAULT_RETRY",
    "ENV_API_BASE",
    "ENV_CLIENT_ID",
    "ENV_CLIENT_SECRET",
    "ENV_SCOPE",
    "ENV_TOKEN_ENDPOINT",
    "PEOPLE_FEED",
    "SYSTEM_API",
    "SYSTEM_VERSION_HEADER",
    "BatchReceipt",
    "ConnectionMode",
    "FedRow",
    "FedRowResult",
    "FeedCounts",
    "FeedGrant",
    "FeedRowOutcome",
    "FeedRunReport",
    "FeedRunView",
    "FeedSchema",
    "PushResult",
    "ReadRows",
    "RetryPolicy",
    "RowProblem",
    "RowStatus",
    "RunStatus",
    "SystemClient",
    "SystemCredentials",
    "SystemLimits",
    "SystemSelf",
    "batches",
    "check_feeds",
    "check_rows",
    "define_feed",
    "header_index",
    "push",
    "read_rows",
    "run_key",
]
