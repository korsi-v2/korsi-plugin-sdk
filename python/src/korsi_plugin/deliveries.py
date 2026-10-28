"""What Korsi sends a plugin's server, read into typed values.

Korsi calls five addresses under the plugin's ``base_url``, each signed
(:mod:`korsi_plugin.signature`):

* ``POST /korsi/lifecycle`` -- :class:`Installed` (with the credential) or :class:`Removed`;
* ``POST /korsi/events`` -- an :class:`Event`, at least once;
* ``POST /korsi/tools/{name}`` -- a :class:`ToolCall`: Korsyar asks on a person's behalf, with
  that person's sealed handle;
* ``POST /korsi/actions/{name}`` -- an :class:`ActionCall`: make one change a person confirmed on a
  card the plugin's specialist prepared (ADR-0080), with their sealed handle, at least once;
* ``POST /korsi/connections`` -- a :class:`ConnectionCall` about a person's connected account:
  check these credentials, tell me what changed, act on their calendar (ADR-0067). The person's
  secrets are in it, for this call only.

Any of them may be answered ``409 {"code": "plugin.unprovisioned"}`` by a plugin that has no
credential for the installation -- a container with no disk, restarted: Korsi gives it the
credential again and asks once more (ADR-0086).

These parse a body that has already been verified; :class:`korsi_plugin.KorsiPlugin` does both.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Final, Literal, NotRequired, TypedDict, cast

from korsi_plugin.errors import RequestRejected

#: Where Korsi calls, under the plugin's ``base_url``.
LIFECYCLE_PATH: Final = "/korsi/lifecycle"
EVENTS_PATH: Final = "/korsi/events"
TOOLS_PATH: Final = "/korsi/tools/"
ACTIONS_PATH: Final = "/korsi/actions/"
CONNECTIONS_PATH: Final = "/korsi/connections"

#: How long Korsi waits for an action's answer, unless the call says otherwise: 30 seconds.
ACTION_DEADLINE_SECONDS: Final = 30

#: The kinds of connection call, as ``ConnectionCall.call`` names them.
VERIFY: Final = "connection.verify"
SYNC: Final = "connection.sync"
CALENDAR: Final = "connection.calendar"


class Topic:
    """Topics of the plugin's own life, always delivered. Others are those its manifest asks for."""

    PROPOSAL_SETTLED: Final = "plugin.proposal.settled"
    INSTALLATION_UPDATED: Final = "plugin.installation.updated"
    INSTALLATION_REMOVED: Final = "plugin.installation.removed"
    WALLET_LOW: Final = "plugin.wallet.low"
    PLAN_CHANGED: Final = "plugin.plan.changed"
    SOURCE_REVIEWED: Final = "plugin.source.reviewed"
    #: A message arrived in the mail of a person who turned this plugin on for it (ADR-0067).
    #: Delivered with ``Event.handle``: read it as them with ``GET /mail/{subject_id}``.
    MAIL_RECEIVED: Final = "source.message.received"
    #: Their mailbox no longer has a message. Korsi keeps it; it may be filed or cited.
    MAIL_DELETED: Final = "source.message.deleted"
    #: Under ``meetings.read`` (ADR-0083); a restricted meeting's go only to the installation
    #: hosting it.
    MEETING_STARTED: Final = "meeting.started"
    MEETING_ENDED: Final = "meeting.ended"
    #: The transcript read from the recording is ready: the record, where the live text was a
    #: preview.
    MEETING_TRANSCRIPT_READY: Final = "meeting.transcript_ready"
    #: Under ``cases.read`` (ADR-0084): a case changed stage, whoever moved it.
    CASE_STAGE_MOVED: Final = "operation.case.stage_moved"


class MalformedRequest(RequestRejected):
    """A body that is not what Korsi sends."""

    status = 400


def read_json(body: bytes) -> dict[str, Any]:
    try:
        parsed = json.loads(body)
    except ValueError as error:
        msg = "the body is not JSON"
        raise MalformedRequest(msg) from error
    if not isinstance(parsed, dict):
        msg = "the body is not a JSON object"
        raise MalformedRequest(msg)
    return parsed


def _uuid(payload: Mapping[str, Any], key: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(payload[key]))
    except (KeyError, ValueError) as error:
        msg = f"{key} is missing or not an id"
        raise MalformedRequest(msg) from error


def _text(payload: Mapping[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        msg = f"{key} is missing"
        raise MalformedRequest(msg)
    return value


def _keys(payload: Mapping[str, Any], key: str) -> tuple[str, ...]:
    value = payload.get(key) or []
    if not isinstance(value, list):
        msg = f"{key} is not a list"
        raise MalformedRequest(msg)
    return tuple(str(item) for item in value)


def _object(payload: Mapping[str, Any], key: str) -> dict[str, Any]:
    value = payload.get(key) or {}
    if not isinstance(value, dict):
        msg = f"{key} is not an object"
        raise MalformedRequest(msg)
    return value


@dataclass(frozen=True, slots=True)
class Installation:
    """What a plugin keeps about one installation: Korsi's address for it and its credential.

    ``token`` and ``signing_secret`` are secrets: keep them encrypted at rest.
    """

    id: uuid.UUID
    plugin_id: str
    version: str
    #: The plugin plane of the Korsi this installation is in: ``https://<korsi>/plugin/v1``.
    api_base: str
    #: The installation's own credential, for ``/plugin/v1`` and Korsi's MCP server.
    token: str
    #: What Korsi signs every call it makes to this installation with.
    signing_secret: str
    scopes: tuple[str, ...] = ()
    settings: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Installed:
    """``installed``: the installation's credential, delivered once Korsi registered it."""

    installation_id: uuid.UUID
    plugin_id: str
    version: str
    plugin_api: str | None
    api_base: str
    token: str
    token_expires_at: str | None
    signing_secret: str
    scopes: tuple[str, ...]
    settings: dict[str, Any]

    @classmethod
    def parse(cls, payload: Mapping[str, Any]) -> Installed:
        return cls(
            installation_id=_uuid(payload, "installation_id"),
            plugin_id=_text(payload, "plugin_id"),
            version=_text(payload, "version"),
            plugin_api=payload.get("plugin_api"),
            api_base=_text(payload, "api_base").rstrip("/"),
            token=_text(payload, "token"),
            token_expires_at=payload.get("token_expires_at"),
            signing_secret=_text(payload, "signing_secret"),
            scopes=tuple(payload.get("scopes") or ()),
            settings=dict(payload.get("settings") or {}),
        )

    def installation(self) -> Installation:
        return Installation(
            id=self.installation_id,
            plugin_id=self.plugin_id,
            version=self.version,
            api_base=self.api_base,
            token=self.token,
            signing_secret=self.signing_secret,
            scopes=self.scopes,
            settings=self.settings,
        )


@dataclass(frozen=True, slots=True)
class Removed:
    """``removed``: *claimed*, unsigned -- Korsi no longer holds the secret to sign it with."""

    installation_id: uuid.UUID

    @classmethod
    def parse(cls, payload: Mapping[str, Any]) -> Removed:
        return cls(installation_id=_uuid(payload, "installation_id"))


@dataclass(frozen=True, slots=True)
class Event:
    """One event in the installation's stream: thin -- a topic, ids, a little data, no content.

    Delivered at least once: the same ``id`` may arrive again, and is the same event.
    """

    id: uuid.UUID
    sequence: int
    topic: str
    installation_id: uuid.UUID
    subject_id: uuid.UUID | None
    data: dict[str, Any]
    occurred_at: datetime
    #: A person's event, for the connection they turned on (ADR-0067): whose it is, and a handle to
    #: read with as them -- minted for this delivery, good for five minutes, and only while the
    #: connection is on. ``None`` for the installation's own events.
    connection_id: uuid.UUID | None = None
    user_id: uuid.UUID | None = None
    handle: str | None = field(default=None, repr=False)

    @classmethod
    def parse(cls, payload: Mapping[str, Any]) -> Event:
        subject = payload.get("subject_id")
        try:
            occurred = datetime.fromisoformat(_text(payload, "occurred_at"))
            sequence = int(payload.get("sequence") or 0)
        except ValueError as error:
            msg = "occurred_at or sequence is malformed"
            raise MalformedRequest(msg) from error
        return cls(
            id=_uuid(payload, "id"),
            sequence=sequence,
            topic=_text(payload, "topic"),
            installation_id=_uuid(payload, "installation_id"),
            subject_id=uuid.UUID(str(subject)) if subject else None,
            data=dict(payload.get("data") or {}),
            occurred_at=occurred,
            connection_id=_uuid(payload, "connection_id") if payload.get("connection_id") else None,
            user_id=_uuid(payload, "user_id") if payload.get("user_id") else None,
            handle=str(payload["handle"]) if payload.get("handle") else None,
        )


@dataclass(frozen=True, slots=True)
class ToolCall:
    """Korsyar asking one of the plugin's read tools, for a person.

    Read Korsi with ``handle``: it is that person, narrowed to this installation's scopes, for five
    minutes -- so whatever the tool reads is what the person may read. Answer ``{"content": ...}``
    within ten seconds, and change nothing: a tool that wants a change sends a proposal, or is an
    action tool.
    """

    name: str
    installation_id: uuid.UUID
    user_id: uuid.UUID
    arguments: dict[str, Any]
    handle: str
    locale: str | None
    #: The plugin's own permissions the person holds in this installation, by their bare keys
    #: (``see_compensation``, ADR-0082). Inside the plugin, enforcing them is the plugin's job.
    permissions: tuple[str, ...] = ()

    @classmethod
    def parse(cls, name: str, payload: Mapping[str, Any]) -> ToolCall:
        return cls(
            name=name,
            installation_id=_uuid(payload, "installation_id"),
            user_id=_uuid(payload, "user_id"),
            arguments=_object(payload, "arguments"),
            handle=_text(payload, "handle"),
            locale=payload.get("locale"),
            permissions=_keys(payload, "permissions"),
        )


class RecordRef(TypedDict):
    """One of the plugin's own records, by the plugin's own keys for it."""

    type: str
    external_id: str


class ChangeOutcome(TypedDict):
    """What became of an earlier change on the same card, as Korsi sends it: the case a
    ``case.create`` made (``result["case_id"]``), the records an action wrote."""

    key: str
    status: Literal["applied", "failed", "skipped"]
    skipped_because: NotRequired[Literal["unticked", "earlier_not_applied"] | None]
    #: An action's: what the plugin said it did, and the records it wrote.
    summary: NotRequired[str | None]
    records: NotRequired[list[RecordRef]]
    #: A proposal's: the proposal Korsi recorded for it, and what applying it produced.
    proposal_id: NotRequired[str | None]
    result: NotRequired[dict[str, Any] | None]
    error_code: NotRequired[str | None]
    error_params: NotRequired[dict[str, Any] | None]


@dataclass(frozen=True, slots=True)
class ActionCall:
    """Korsi making one change a person confirmed (ADR-0080).

    The plugin's specialist used one of its *action* tools in Korsyar's conversation; that prepared
    a card and nothing else; the person confirmed it -- maybe after editing it -- and now Korsi
    calls ``POST /korsi/actions/{name}`` with exactly the arguments the card showed, checked
    against the tool's ``input_schema`` again.

    * Read and write Korsi with ``handle``: it is that person, narrowed to this installation's
      scopes.
    * **At least once.** ``idempotency_key`` (``<card_id>:<change_key>``) is the same on every
      delivery of this change: make the change under it, so a second delivery -- after a restart,
      the process's memory gone -- finds it made and answers the same.
    * ``earlier`` holds what the changes it builds on produced, by their keys: a position created
      under the case the card's ``case.create`` made reads ``earlier["case"]["result"]["case_id"]``.
    * Answer within ``deadline_seconds``, with ``{"ok": True, "summary", "records"}`` or, refusing,
      ``{"ok": False, "error": {"code", "message"}}`` in ``locale``: the card shows it as the
      plugin's words.
    """

    name: str
    installation_id: uuid.UUID
    #: The person who confirmed the card, whom ``handle`` stands for.
    user_id: uuid.UUID
    arguments: dict[str, Any]
    handle: str
    #: The plugin plane's address, as the installation's own.
    api_base: str
    locale: str
    #: The plugin's own permissions the person holds, by their bare keys, as a tool call has them.
    permissions: tuple[str, ...]
    card_id: uuid.UUID
    change_key: str
    idempotency_key: str
    earlier: dict[str, ChangeOutcome]
    deadline_seconds: int

    @classmethod
    def parse(cls, name: str, payload: Mapping[str, Any]) -> ActionCall:
        """Refuses a body naming another tool than the address: the signature does not cover the
        path."""
        tool = _text(payload, "tool")
        if tool != name:
            msg = f"the body is for {tool}, not {name}"
            raise MalformedRequest(msg)
        try:
            deadline = int(payload.get("deadline_seconds", ACTION_DEADLINE_SECONDS))
        except (TypeError, ValueError) as error:
            msg = "deadline_seconds is not readable"
            raise MalformedRequest(msg) from error
        if deadline < 1:
            msg = "deadline_seconds is not readable"
            raise MalformedRequest(msg)
        return cls(
            name=name,
            installation_id=_uuid(payload, "installation_id"),
            user_id=_uuid(payload, "user_id"),
            arguments=_object(payload, "arguments"),
            handle=_text(payload, "handle"),
            api_base=_text(payload, "api_base").rstrip("/"),
            locale=str(payload.get("locale") or "fa"),
            permissions=_keys(payload, "permissions"),
            card_id=_uuid(payload, "card_id"),
            change_key=_text(payload, "change_key"),
            idempotency_key=_text(payload, "idempotency_key"),
            earlier=cast(dict[str, ChangeOutcome], _object(payload, "earlier")),
            deadline_seconds=deadline,
        )


@dataclass(frozen=True, slots=True)
class ConnectionCall:
    """Korsi asking about one person's connection (ADR-0067).

    ``call`` is :data:`VERIFY` (are these credentials an account? answer ``{"ok": true, "account":
    {"subject", "label", "address", "host"}}`` or ``{"ok": false, "error": {"code":
    "auth_failed", "message"}}``), :data:`SYNC` (what changed since ``state``? answer
    ``{"changes", "state", "more", "skipped"}``) or :data:`CALENDAR` (``op`` with ``args``; answer
    ``{"result"}``). The shapes are published as ``korsi-connection-calls.schema.json``.

    ``secrets`` are the person's, opened by Korsi for this call only: never log them, never keep
    them. Answer within ``deadline_seconds`` -- stop early and say ``more`` rather than run over.
    """

    call: str
    call_id: uuid.UUID
    installation_id: uuid.UUID
    connection_id: uuid.UUID
    connection_key: str
    user_id: uuid.UUID
    locale: str
    timezone: str
    values: dict[str, str]
    secrets: dict[str, str] = field(repr=False)
    settings: dict[str, Any]
    deadline_seconds: int
    issued_at: datetime
    #: A sync's: what this plugin answered as ``state`` last time, or ``None`` on a first sync.
    state: dict[str, Any] | None = None
    #: A sync's: ``max_items``, ``max_bytes``, ``backfill_days``.
    limits: dict[str, Any] = field(default_factory=dict)
    #: A calendar call's operation and its arguments.
    op: str | None = None
    args: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def parse(cls, payload: Mapping[str, Any]) -> ConnectionCall:
        call = _text(payload, "call")
        if call not in (VERIFY, SYNC, CALENDAR):
            msg = f"not a connection call: {call!r}"
            raise MalformedRequest(msg)
        for key in ("values", "secrets", "settings"):
            if not isinstance(payload.get(key, {}), dict):
                msg = f"{key} is not an object"
                raise MalformedRequest(msg)
        state = payload.get("state")
        if state is not None and not isinstance(state, dict):
            msg = "state is not an object"
            raise MalformedRequest(msg)
        try:
            issued_at = datetime.fromisoformat(_text(payload, "issued_at"))
            deadline = int(payload.get("deadline_seconds", 0))
        except ValueError as error:
            msg = "issued_at or deadline_seconds is not readable"
            raise MalformedRequest(msg) from error
        return cls(
            call=call,
            call_id=_uuid(payload, "call_id"),
            installation_id=_uuid(payload, "installation_id"),
            connection_id=_uuid(payload, "connection_id"),
            connection_key=_text(payload, "connection_key"),
            user_id=_uuid(payload, "user_id"),
            locale=str(payload.get("locale") or "fa"),
            timezone=str(payload.get("timezone") or "UTC"),
            values={str(k): str(v) for k, v in (payload.get("values") or {}).items()},
            secrets={str(k): str(v) for k, v in (payload.get("secrets") or {}).items()},
            settings=dict(payload.get("settings") or {}),
            deadline_seconds=deadline,
            issued_at=issued_at,
            state=state,
            limits=dict(payload.get("limits") or {}),
            op=payload.get("op"),
            args=dict(payload.get("args") or {}),
        )
