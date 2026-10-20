"""A plugin's life through :class:`KorsiPlugin`: installed, events, a tool, a page, removed."""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import pytest

from korsi_plugin import (
    CredentialMismatch,
    Event,
    HandleRejected,
    Installation,
    KorsiPlugin,
    KorsiRefused,
    MalformedRequest,
    SignatureInvalid,
    SQLiteEventLog,
    UnknownInstallation,
    sign,
)
from tests.fake_korsi import (
    ANA,
    API_BASE,
    FOREIGN_HANDLE,
    HANDLE,
    INSTALLATION,
    SECRET,
    TOKEN,
    FakeKorsi,
    problem,
    transport,
)


class Store:
    """An installation store, the shape the plugin's own database gives it."""

    def __init__(self) -> None:
        self.rows: dict[uuid.UUID, Installation] = {}

    async def installation(self, installation_id: uuid.UUID) -> Installation | None:
        return self.rows.get(installation_id)

    async def save_installation(self, installation: Installation) -> None:
        self.rows[installation.id] = installation

    async def remove_installation(self, installation_id: uuid.UUID) -> None:
        self.rows.pop(installation_id, None)


def body(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, separators=(",", ":")).encode()


def installed(**overrides: Any) -> dict[str, Any]:
    return {
        "event": "installed",
        "installation_id": str(INSTALLATION),
        "plugin_id": "ir.acme.sample",
        "version": "1.2.0",
        "plugin_api": "1.0",
        "api_base": API_BASE,
        "token": TOKEN,
        "token_expires_at": None,
        "signing_secret": SECRET,
        "scopes": ["records.own"],
        "settings": {},
        **overrides,
    }


def event(**overrides: Any) -> dict[str, Any]:
    return {
        "id": str(uuid.UUID(int=7)),
        "sequence": 7,
        "topic": "plugin.proposal.settled",
        "installation_id": str(INSTALLATION),
        "subject_id": None,
        "data": {"external_id": "m1#1", "status": "applied"},
        "occurred_at": "2026-10-20T10:00:00+00:00",
        **overrides,
    }


@pytest.fixture
def korsi() -> FakeKorsi:
    return FakeKorsi()


@pytest.fixture
def store() -> Store:
    return Store()


@pytest.fixture
async def plugin(korsi: FakeKorsi, store: Store) -> AsyncIterator[KorsiPlugin]:
    async with KorsiPlugin(store, transport=transport(korsi)) as made:
        yield made


async def install(plugin: KorsiPlugin) -> None:
    raw = body(installed())
    result = await plugin.lifecycle(raw, sign(SECRET, raw))
    assert result.status == "installed"


# -- installed ------------------------------------------------------------------------------------


async def test_installed_is_confirmed_with_korsi_then_kept(
    plugin: KorsiPlugin, store: Store, korsi: FakeKorsi
) -> None:
    await install(plugin)
    kept = store.rows[INSTALLATION]
    assert kept.token == TOKEN
    assert kept.signing_secret == SECRET
    # What Korsi says, not what the message says: scopes and settings come from GET /installation.
    assert kept.settings == {"x": 1}
    assert korsi.count("GET", "/installation") == 1


async def test_installed_with_a_bad_signature_is_refused(plugin: KorsiPlugin, store: Store) -> None:
    raw = body(installed())
    with pytest.raises(SignatureInvalid):
        await plugin.lifecycle(raw, sign("another", raw))
    assert not store.rows


async def test_installed_for_another_installation_is_refused(
    plugin: KorsiPlugin, store: Store
) -> None:
    raw = body(installed(installation_id=str(uuid.uuid4())))
    with pytest.raises(CredentialMismatch):
        await plugin.lifecycle(raw, sign(SECRET, raw))
    assert not store.rows


async def test_a_known_installation_cannot_be_moved_to_another_korsi(
    plugin: KorsiPlugin, store: Store
) -> None:
    await install(plugin)
    raw = body(installed(api_base="https://evil.test/plugin/v1", signing_secret="evil"))
    with pytest.raises(CredentialMismatch, match="another Korsi"):
        await plugin.lifecycle(raw, sign("evil", raw))
    assert store.rows[INSTALLATION].api_base == API_BASE


async def test_only_trusted_korsis_when_the_plugin_names_them(
    korsi: FakeKorsi, store: Store
) -> None:
    async with KorsiPlugin(
        store, trusted_api_bases=["https://acme.korsi.ai/plugin/v1/"], transport=transport(korsi)
    ) as plugin:
        raw = body(installed())
        with pytest.raises(CredentialMismatch, match="not a Korsi"):
            await plugin.lifecycle(raw, sign(SECRET, raw))


async def test_a_credential_korsi_refuses_is_not_kept(
    plugin: KorsiPlugin, store: Store, korsi: FakeKorsi
) -> None:
    korsi.token_answer = problem(401, "auth.unauthenticated")
    raw = body(installed())
    with pytest.raises(KorsiRefused, match=r"auth\.unauthenticated"):
        await plugin.lifecycle(raw, sign(SECRET, raw))
    assert not store.rows


async def test_a_development_credential_is_registered_the_same_way(
    plugin: KorsiPlugin, store: Store
) -> None:
    kept = await plugin.register(
        installation_id=INSTALLATION, token=TOKEN, signing_secret=SECRET, api_base=API_BASE + "/"
    )
    assert kept.plugin_id == "ir.acme.sample"
    assert kept.api_base == API_BASE
    assert store.rows[INSTALLATION] == kept


async def test_garbage_is_malformed(plugin: KorsiPlugin) -> None:
    with pytest.raises(MalformedRequest):
        await plugin.lifecycle(b"not json", None)
    with pytest.raises(MalformedRequest):
        await plugin.lifecycle(body({"event": "upgraded"}), None)


# -- removed --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("answer", "status"),
    [
        (None, "still_installed"),
        (problem(401, "auth.unauthenticated"), "removed"),
        (problem(403, "plugin.not_a_plugin"), "removed"),
        (problem(403, "plugin.installation_inactive", state="removed"), "removed"),
        (problem(403, "plugin.installation_inactive", state="suspended"), "unconfirmed"),
        (problem(503, "service.unavailable"), "unconfirmed"),
    ],
)
async def test_removed_is_believed_only_when_korsi_refuses_the_credential(
    plugin: KorsiPlugin, store: Store, korsi: FakeKorsi, answer: Any, status: str
) -> None:
    await install(plugin)
    korsi.token_answer = answer
    result = await plugin.lifecycle(
        body({"event": "removed", "installation_id": str(INSTALLATION)}), None
    )
    assert result.status == status
    assert (INSTALLATION in store.rows) == (status != "removed")


async def test_removed_for_a_stranger_is_unknown(plugin: KorsiPlugin) -> None:
    result = await plugin.lifecycle(
        body({"event": "removed", "installation_id": str(uuid.uuid4())}), None
    )
    assert result.status == "unknown"


# -- events ---------------------------------------------------------------------------------------


async def test_an_event_is_handled_once(plugin: KorsiPlugin) -> None:
    await install(plugin)
    handled: list[Event] = []

    async def handler(_: Installation, received: Event) -> None:
        handled.append(received)

    raw = body(event())
    assert await plugin.event(raw, sign(SECRET, raw), handler) == "handled"
    assert await plugin.event(raw, sign(SECRET, raw), handler) == "duplicate"
    assert len(handled) == 1
    assert handled[0].data["status"] == "applied"
    assert handled[0].sequence == 7


async def test_a_failed_handler_lets_korsis_retry_run_it_again(plugin: KorsiPlugin) -> None:
    await install(plugin)
    attempts: list[int] = []

    async def flaky(_: Installation, __: Event) -> None:
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("database down")

    raw = body(event())
    with pytest.raises(RuntimeError):
        await plugin.event(raw, sign(SECRET, raw), flaky)
    assert await plugin.event(raw, sign(SECRET, raw), flaky) == "handled"
    assert len(attempts) == 2


async def test_an_event_signed_with_another_secret_is_refused(plugin: KorsiPlugin) -> None:
    await install(plugin)

    async def handler(_: Installation, __: Event) -> None:
        raise AssertionError("must not run")

    raw = body(event())
    with pytest.raises(SignatureInvalid):
        await plugin.event(raw, sign("not-it", raw), handler)


async def test_an_event_for_a_stranger_is_404(plugin: KorsiPlugin) -> None:
    raw = body(event(installation_id=str(uuid.uuid4())))
    with pytest.raises(UnknownInstallation) as raised:
        await plugin.verified_event(raw, sign(SECRET, raw))
    assert raised.value.status == 404


async def test_a_durable_event_log_survives_a_restart(
    korsi: FakeKorsi, store: Store, tmp_path: Path
) -> None:
    raw = body(event())

    async def handler(_: Installation, __: Event) -> None:
        return None

    for expected in ("handled", "duplicate"):
        log = SQLiteEventLog(tmp_path / "events.db")
        async with KorsiPlugin(store, events=log, transport=transport(korsi)) as plugin:
            if expected == "handled":
                await install(plugin)
            assert await plugin.event(raw, sign(SECRET, raw), handler) == expected


# -- tools ----------------------------------------------------------------------------------------


async def test_a_tool_call_is_verified_and_reads_korsi_as_the_person(plugin: KorsiPlugin) -> None:
    await install(plugin)
    raw = body(
        {
            "installation_id": str(INSTALLATION),
            "user_id": str(ANA),
            "arguments": {"q": "x"},
            "handle": HANDLE,
            "api_base": API_BASE,
            "locale": "fa",
        }
    )
    installation, call = await plugin.tool_call("find", raw, sign(SECRET, raw))
    assert call.arguments == {"q": "x"}
    assert call.user_id == ANA
    me = await plugin.client(installation, call.handle).whoami()
    assert me.user_id == ANA


# -- a page's caller ------------------------------------------------------------------------------


async def test_a_page_handle_is_vouched_for_by_korsi_once(
    plugin: KorsiPlugin, korsi: FakeKorsi
) -> None:
    await install(plugin)
    before = korsi.count("GET", "/installation")
    for _ in range(3):
        who = await plugin.person(
            authorization=f"Bearer {HANDLE}", installation_id=str(INSTALLATION)
        )
    assert who.user_id == ANA
    assert korsi.count("GET", "/installation") == before + 1


@pytest.mark.parametrize(
    ("authorization", "status"),
    [
        (None, 401),
        ("Basic abc", 401),
        ("Bearer nobody", 401),
        (f"Bearer {FOREIGN_HANDLE}", 403),
        (f"Bearer {TOKEN}", 403),
    ],
)
async def test_a_page_cannot_claim_to_be_anybody(
    plugin: KorsiPlugin, authorization: str | None, status: int
) -> None:
    await install(plugin)
    with pytest.raises(HandleRejected) as raised:
        await plugin.person(authorization=authorization, installation_id=str(INSTALLATION))
    assert raised.value.status == status


async def test_a_page_names_its_installation(plugin: KorsiPlugin) -> None:
    await install(plugin)
    with pytest.raises(MalformedRequest):
        await plugin.person(authorization=f"Bearer {HANDLE}", installation_id=None)
    with pytest.raises(UnknownInstallation):
        await plugin.person(authorization=f"Bearer {HANDLE}", installation_id=str(uuid.uuid4()))
