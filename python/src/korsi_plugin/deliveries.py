"""What Korsi sends a plugin's server, read into typed values.

Korsi calls three addresses under the plugin's ``base_url``, each signed
(:mod:`korsi_plugin.signature`):

* ``POST /korsi/lifecycle`` -- :class:`Installed` (with the credential) or :class:`Removed`;
* ``POST /korsi/events`` -- an :class:`Event`, at least once;
* ``POST /korsi/tools/{name}`` -- a :class:`ToolCall`: Korsyar asks on a person's behalf, with
  that person's sealed handle.

These parse a body that has already been verified; :class:`korsi_plugin.KorsiPlugin` does both.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Final

from korsi_plugin.errors import RequestRejected

#: Where Korsi calls, under the plugin's ``base_url``.
LIFECYCLE_PATH: Final = "/korsi/lifecycle"
EVENTS_PATH: Final = "/korsi/events"
TOOLS_PATH: Final = "/korsi/tools/"


class Topic:
    """Topics of the plugin's own life, always delivered. Others are those its manifest asks for."""

    PROPOSAL_SETTLED: Final = "plugin.proposal.settled"
    INSTALLATION_UPDATED: Final = "plugin.installation.updated"
    INSTALLATION_REMOVED: Final = "plugin.installation.removed"
    WALLET_LOW: Final = "plugin.wallet.low"
    PLAN_CHANGED: Final = "plugin.plan.changed"
    SOURCE_REVIEWED: Final = "plugin.source.reviewed"


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
    #: What Korsi signs every event and tool call for this installation with.
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
        )


@dataclass(frozen=True, slots=True)
class ToolCall:
    """Korsyar asking one of the plugin's tools, for a person.

    Read Korsi with ``handle``: it is that person, narrowed to this installation's scopes, for five
    minutes -- so whatever the tool reads is what the person may read. Answer ``{"content": ...}``
    within ten seconds, and change nothing: a tool that wants a change sends a proposal.
    """

    name: str
    installation_id: uuid.UUID
    user_id: uuid.UUID
    arguments: dict[str, Any]
    handle: str
    locale: str | None

    @classmethod
    def parse(cls, name: str, payload: Mapping[str, Any]) -> ToolCall:
        arguments = payload.get("arguments") or {}
        if not isinstance(arguments, dict):
            msg = "arguments is not an object"
            raise MalformedRequest(msg)
        return cls(
            name=name,
            installation_id=_uuid(payload, "installation_id"),
            user_id=_uuid(payload, "user_id"),
            arguments=arguments,
            handle=_text(payload, "handle"),
            locale=payload.get("locale"),
        )
