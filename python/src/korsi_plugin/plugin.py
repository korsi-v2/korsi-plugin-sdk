"""The server side of a plugin, in one object: :class:`KorsiPlugin`.

It does, the same way for every plugin, what each one would otherwise write again -- and get subtly
wrong:

* **the lifecycle** (:meth:`KorsiPlugin.lifecycle`): ``installed`` is verified, the credential is
  confirmed with Korsi (``GET /installation``) before it is kept, and an installation's Korsi cannot
  be changed by a later message; ``removed``, unsigned by design, is believed only once Korsi
  refuses the stored credential;
* **events** (:meth:`KorsiPlugin.event`): verified with the installation's secret, deduplicated,
  and given back to the log when the handler fails, so Korsi's retry runs it again;
* **tool calls** (:meth:`KorsiPlugin.tool_call`): verified, parsed, with the person's handle;
* **action calls** (:meth:`KorsiPlugin.register_action`, :meth:`KorsiPlugin.action_call`): a change
  a person confirmed on a card the plugin's specialist prepared (ADR-0080) -- verified, run once per
  change, its answer kept to Korsi's limits;
* **connection calls** (:meth:`KorsiPlugin.connection_call`): verified, parsed, each answered once;
* **a page's caller** (:meth:`KorsiPlugin.person`): the handle a page sends is checked with Korsi
  before anything is done with it, so a page can never claim to be somebody it is not;
* **the client** (:meth:`KorsiPlugin.client`): the plugin plane as the installation or as a
  person, over one shared connection pool -- through the egress proxy the environment names.

**A plugin that keeps nothing** -- a container with no disk, restarted -- does not know an
installation Korsi calls about. Every delivery kind then raises :class:`Unprovisioned`, a 409 to
answer with ``{"code": "plugin.unprovisioned"}`` in the body, and Korsi gives it the credential
again and asks once more (ADR-0086). Render the code: Korsi reads it, never a bare 409. Korsi
delivers at least once, so handlers are idempotent; what must survive a restart lives in the
plugin's records.

It is framework-free: give it the raw body and the headers; it raises
:class:`~korsi_plugin.RequestRejected` (with the HTTP ``status`` to answer) or Korsi's own errors.
Where the plugin keeps installations is the plugin's business (:class:`InstallationStore`).
"""

from __future__ import annotations

import asyncio
import functools
import hashlib
import re
import time
import uuid
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Collection, Mapping
from dataclasses import dataclass
from typing import Any, Final, Literal, NotRequired, Protocol, Self, TypedDict

import httpx

from korsi_plugin.client import DEFAULT_TIMEOUT_SECONDS, Caller, KorsiClient
from korsi_plugin.dedupe import DEFAULT_LEASE_SECONDS, EventLog, MemoryEventLog
from korsi_plugin.deliveries import (
    ActionCall,
    ConnectionCall,
    Event,
    Installation,
    Installed,
    MalformedRequest,
    RecordRef,
    Removed,
    ToolCall,
    read_json,
)
from korsi_plugin.errors import KorsiError, KorsiRefused, RequestRejected, credential_refused
from korsi_plugin.signature import DEFAULT_TOLERANCE_SECONDS, verify_signature
from korsi_plugin.trust import api_base_problem

#: The header a plugin's page names its installation in, beside ``Authorization: Bearer <handle>``.
#: Korsi does not read it; it is how this SDK's page helpers and server helpers agree.
INSTALLATION_HEADER: Final = "X-Korsi-Installation"


class UnknownInstallation(RequestRejected):
    """A call for an installation this plugin does not have. What this SDK raises is always its
    subclass :class:`Unprovisioned`, so ``except UnknownInstallation`` still catches it."""

    status = 404


class Unprovisioned(UnknownInstallation):
    """A delivery -- an event, a tool or action call, a connection call, a page's call -- for an
    installation this plugin has no credential for: usually a plugin with no disk, restarted.

    409 with ``{"code": "plugin.unprovisioned"}`` in the body: Korsi gives the credential again and
    asks once more (ADR-0086). A page's call comes back through the Bridge, which asks Korsi to do
    so.
    """

    status = 409
    code = "plugin.unprovisioned"


class ActionUnknown(RequestRejected):
    """An action call for a tool this plugin registered no handler for. 404: Korsi marks it
    failed."""

    status = 404


class ActionArgumentsRejected(RequestRejected):
    """Arguments the action's own ``parse`` refused. 422: Korsi marks the change failed."""

    status = 422


class CallReplayed(RequestRejected):
    """A connection call seen before: a signed body sent again within the signature's tolerance."""

    status = 400


class EventInProgress(RequestRejected):
    """The event is being handled by another delivery right now. 503: Korsi comes back later --
    any 4xx but 429 would make it give the event up for good."""

    status = 503


class CredentialMismatch(RequestRejected):
    """``installed`` with a credential Korsi says belongs elsewhere, or from another Korsi."""

    status = 400


class HandleRejected(RequestRejected):
    """A page's caller Korsi does not vouch for: 401 for no handle or one Korsi no longer accepts
    (the page asks the Bridge for a fresh one), 403 for a handle that is not this installation's
    person."""

    status = 403


class InstallationStore(Protocol):
    """Where the plugin keeps its installations. Keep ``token`` and ``signing_secret`` sealed."""

    async def installation(self, installation_id: uuid.UUID) -> Installation | None: ...

    async def save_installation(self, installation: Installation) -> None: ...

    async def remove_installation(self, installation_id: uuid.UUID) -> None: ...


LifecycleStatus = Literal["installed", "removed", "still_installed", "unconfirmed", "unknown"]


@dataclass(frozen=True, slots=True)
class LifecycleResult:
    """What a lifecycle call came to. Answer Korsi ``{"status": result.status}``.

    * ``installed`` -- the credential was confirmed with Korsi and kept;
    * ``removed`` -- Korsi refuses the stored credential, so the installation was forgotten;
    * ``still_installed`` -- a ``removed`` Korsi contradicts: the stored credential still works;
    * ``unconfirmed`` -- a ``removed`` Korsi could not be asked about (down, suspended): kept;
    * ``unknown`` -- a ``removed`` for an installation this plugin never had.
    """

    status: LifecycleStatus
    installation_id: uuid.UUID
    installation: Installation | None = None


EventStatus = Literal["handled", "duplicate"]


@dataclass(frozen=True, slots=True)
class Person:
    """A page's caller, as Korsi confirmed it: the installation, who, and their handle."""

    installation: Installation
    caller: Caller
    handle: str

    @property
    def user_id(self) -> uuid.UUID:
        assert self.caller.user_id is not None  # noqa: S101 - person() refuses otherwise
        return self.caller.user_id


class ActionRefusal(TypedDict):
    """Why a plugin did not make a change. ``code`` is the plugin's own (``position_closed``);
    ``message`` is shown on the card as the plugin's words, in the call's locale."""

    code: str
    message: str


class ActionAnswer(TypedDict):
    """What an action answers Korsi: the change made, or refused and why.

    A refusal is an answer, not an error: ``{"ok": False, "error": {...}}``, and the card shows the
    message beside the change. Raising instead -- or answering late -- tells Korsi only that it
    cannot say whether the change was made. ``summary`` is cut at 300 characters, ``message`` at
    500, ``records`` at 20.
    """

    ok: bool
    summary: NotRequired[str | None]
    records: NotRequired[list[RecordRef]]
    error: NotRequired[ActionRefusal]


@dataclass(frozen=True, slots=True)
class ActionContext:
    """What an action's handler is given."""

    installation: Installation
    call: ActionCall
    #: The arguments the card showed, as the registration's ``parse`` returned them.
    arguments: Any
    #: The person who confirmed the card, as Korsi vouches for them: ``caller.permissions``
    #: included.
    caller: Caller
    #: The plugin plane as that person.
    korsi: KorsiClient
    #: When Korsi stops waiting, on :func:`time.monotonic`'s clock, a little early.
    deadline: float

    def remaining(self) -> float:
        """Seconds left to answer in."""
        return max(self.deadline - time.monotonic(), 0.0)


ActionHandler = Callable[[ActionContext], Awaitable[ActionAnswer]]

#: How long an action's answer is kept for a repeat of the same change, in seconds.
_ACTION_ANSWER_TTL: Final = 3600.0
#: How much sooner than Korsi's deadline the handler's ``deadline`` is, in seconds.
_ACTION_MARGIN: Final = 2.0
#: Korsi's limits on an action's answer (``PluginActionAnswer``).
_SUMMARY_CHARACTERS: Final = 300
_MESSAGE_CHARACTERS: Final = 500
_ANSWER_RECORDS: Final = 20
_REFUSAL_CODE: Final = re.compile(r"^[a-z][a-z0-9_.]{0,63}$")


def _kept_answer(answer: Mapping[str, Any], name: str) -> ActionAnswer:
    """The handler's answer within Korsi's limits, or a :class:`TypeError` naming what no limit
    can fix."""
    if not isinstance(answer, Mapping) or not isinstance(answer.get("ok"), bool):
        msg = f"action {name}: the handler answered no {{'ok'}}"
        raise TypeError(msg)
    kept = ActionAnswer(ok=answer["ok"])
    summary = str(answer.get("summary") or "").strip()[:_SUMMARY_CHARACTERS]
    if summary:
        kept["summary"] = summary
    kept["records"] = [
        RecordRef(type=str(record["type"]), external_id=str(record["external_id"]))
        for record in list(answer.get("records") or [])[:_ANSWER_RECORDS]
    ]
    if kept["ok"]:
        return kept
    error = answer.get("error") or {}
    code = error.get("code")
    message = str(error.get("message") or "").strip()[:_MESSAGE_CHARACTERS]
    if not isinstance(code, str) or not _REFUSAL_CODE.match(code) or not message:
        msg = f"action {name}: a refusal needs a code like {_REFUSAL_CODE.pattern} and a message"
        raise TypeError(msg)
    kept["error"] = ActionRefusal(code=code, message=message)
    return kept


class KorsiPlugin:
    """One plugin's dealings with every Korsi it is installed in. Close it when the server stops."""

    def __init__(
        self,
        installations: InstallationStore,
        *,
        events: EventLog | None = None,
        trusted_api_bases: Collection[str] | None = None,
        allow_http: bool = False,
        tolerance: int = DEFAULT_TOLERANCE_SECONDS,
        handle_cache_seconds: float = 60.0,
        event_lease_seconds: float = DEFAULT_LEASE_SECONDS,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """
        :param installations: where installations are kept.
        :param events: the event log for deduplication; in memory when not given.
        :param trusted_api_bases: the Korsi plugin planes this plugin accepts installations from
            (``https://acme.korsi.ai/plugin/v1``, or ``https://*.korsi.ai/plugin/v1``). ``None``
            accepts any that looks like a plane -- right only for a plugin in a public catalogue,
            which any organization may install (see :mod:`korsi_plugin.trust`).
        :param allow_http: accept a plain-``http`` plane beyond this machine, for development.
        :param tolerance: how old a signature may be, in seconds.
        :param handle_cache_seconds: how long Korsi's word on a page's handle is reused; a
            permission the organization takes back reaches ``Caller.permissions`` that much later.
        :param event_lease_seconds: how long a delivery holds an event before another may take it
            over -- longer than the slowest handler.
        """
        self.installations = installations
        self.event_log: EventLog = events if events is not None else MemoryEventLog()
        self._trusted = None if trusted_api_bases is None else tuple(trusted_api_bases)
        self._allow_http = allow_http
        self._lease = event_lease_seconds
        self._tolerance = tolerance
        self._handle_ttl = handle_cache_seconds
        self._handles: OrderedDict[str, tuple[float, Caller]] = OrderedDict()
        #: Connection calls already answered, for the signature's tolerance and a little more.
        self._calls: OrderedDict[uuid.UUID, float] = OrderedDict()
        self._actions: dict[str, tuple[ActionHandler, Callable[[dict[str, Any]], Any] | None]] = {}
        #: Each change's answer, by installation and idempotency key, while a repeat may come.
        self._answers: OrderedDict[str, tuple[float, asyncio.Task[ActionAnswer]]] = OrderedDict()
        # With no transport of its own, httpx reads HTTPS_PROXY, HTTP_PROXY and NO_PROXY: the
        # egress proxy is the only way out of a container Korsi runs.
        self._http = httpx.AsyncClient(timeout=timeout, transport=transport)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    def client(self, installation: Installation, bearer: str | None = None) -> KorsiClient:
        """The plugin plane as ``bearer`` -- a person's handle -- or, with none, as the installation
        itself. An empty handle is a handle (Korsi refuses it), never the installation's token."""
        token = installation.token if bearer is None else bearer
        return KorsiClient(installation.api_base, token, http=self._http)

    async def _known(self, installation_id: uuid.UUID) -> Installation:
        """The installation, or :class:`Unprovisioned`: Korsi gives its credential again."""
        installation = await self.installations.installation(installation_id)
        if installation is None:
            msg = f"installation {installation_id} has no credentials here"
            raise Unprovisioned(msg)
        return installation

    # -- 1. lifecycle ------------------------------------------------------------------------------

    async def lifecycle(self, body: bytes, signature: str | None) -> LifecycleResult:
        """``POST /korsi/lifecycle``: ``installed`` or ``removed``."""
        payload = read_json(body)
        event = payload.get("event")
        if event == "installed":
            installed = Installed.parse(payload)
            # Signed with the secret it carries, so the signature proves integrity only. What
            # proves the credential is Korsi's is Korsi accepting it, in accept().
            verify_signature(installed.signing_secret, body, signature, tolerance=self._tolerance)
            installation = await self.accept(installed.installation())
            return LifecycleResult("installed", installation.id, installation)
        if event == "removed":
            return await self._removed(Removed.parse(payload))
        msg = f"unknown lifecycle event {event!r}"
        raise MalformedRequest(msg)

    async def accept(self, installation: Installation) -> Installation:
        """Keep a credential once Korsi confirms it is this installation's.

        What ``installed`` does after its signature, and what a *development* installation's
        credential -- read once from Korsi's installation page, because Korsi cannot reach the
        developer's machine -- goes through too (:meth:`register`).
        """
        api_base = installation.api_base.strip().rstrip("/")
        problem = api_base_problem(api_base, self._trusted, allow_http=self._allow_http)
        if problem is not None:
            raise CredentialMismatch(problem)
        known = await self.installations.installation(installation.id)
        if known is not None and known.api_base.rstrip("/") != api_base:
            # A real Korsi never moves an installation; a message that tries is somebody else's.
            msg = "this installation belongs to another Korsi"
            raise CredentialMismatch(msg)
        me = await self.client(installation).whoami()
        if me.installation_id != installation.id or me.authority != "installation":
            msg = "Korsi says the credential belongs to another installation"
            raise CredentialMismatch(msg)
        confirmed = Installation(
            id=installation.id,
            plugin_id=me.plugin_id or installation.plugin_id,
            version=me.version or installation.version,
            api_base=api_base,
            token=installation.token,
            signing_secret=installation.signing_secret,
            scopes=me.scopes,
            settings=dict(me.settings),
        )
        await self.installations.save_installation(confirmed)
        return confirmed

    async def register(
        self, *, installation_id: uuid.UUID | str, token: str, signing_secret: str, api_base: str
    ) -> Installation:
        """Keep a development installation's credential, read from Korsi's installation page."""
        return await self.accept(
            Installation(
                id=uuid.UUID(str(installation_id)),
                plugin_id="",
                version="",
                api_base=api_base,
                token=token,
                signing_secret=signing_secret,
            )
        )

    async def _removed(self, removed: Removed) -> LifecycleResult:
        # Unsigned by design -- the secret is gone on Korsi's side -- so it is believed only once
        # Korsi refuses the stored credential; otherwise anybody could make the plugin forget.
        known = await self.installations.installation(removed.installation_id)
        if known is None:
            return LifecycleResult("unknown", removed.installation_id)
        try:
            await self.client(known).whoami()
        except KorsiRefused as refused:
            if credential_refused(refused):
                await self.installations.remove_installation(known.id)
                self._forget_handles(known.id)
                return LifecycleResult("removed", known.id)
            return LifecycleResult("unconfirmed", known.id, known)
        except KorsiError:
            return LifecycleResult("unconfirmed", known.id, known)
        return LifecycleResult("still_installed", known.id, known)

    # -- 2. events ---------------------------------------------------------------------------------

    async def verified_event(
        self, body: bytes, signature: str | None
    ) -> tuple[Installation, Event]:
        """An event's body, verified with its installation's secret and parsed. No deduplication.

        An installation not known here is :class:`Unprovisioned` (409 ``plugin.unprovisioned``):
        the plugin restarted with nothing kept, or was down when Korsi delivered ``installed``.
        Korsi gives the credential again and delivers once more, and keeps the event's normal
        retries.
        """
        event = Event.parse(read_json(body))
        installation = await self._known(event.installation_id)
        verify_signature(installation.signing_secret, body, signature, tolerance=self._tolerance)
        return installation, event

    async def event(
        self,
        body: bytes,
        signature: str | None,
        handler: Callable[[Installation, Event], Awaitable[object]],
    ) -> EventStatus:
        """``POST /korsi/events``: verify, skip a repeat, run ``handler`` when it is its turn.

        Answer Korsi 2xx for both outcomes. Raises :class:`EventInProgress` (503) while another
        delivery of the same event is still running it, so Korsi comes back rather than taking a
        2xx for done. If ``handler`` raises, the event is given back to the log and the error
        propagates: answer Korsi 5xx and it delivers the event again later.
        """
        installation, event = await self.verified_event(body, signature)
        claimed = await self.event_log.claim(
            installation.id, str(event.id), lease_seconds=self._lease
        )
        if claimed == "done":
            return "duplicate"
        if claimed == "busy":
            msg = f"event {event.id} is being handled; come back later"
            raise EventInProgress(msg)
        try:
            await handler(installation, event)
        except BaseException:
            await self.event_log.forget(installation.id, str(event.id))
            raise
        await self.event_log.finish(installation.id, str(event.id))
        return "handled"

    # -- 3. tools ----------------------------------------------------------------------------------

    async def tool_call(
        self, name: str, body: bytes, signature: str | None
    ) -> tuple[Installation, ToolCall]:
        """``POST /korsi/tools/{name}``: verified and parsed. Read Korsi with
        ``plugin.client(installation, call.handle)`` -- as the person, not as the plugin.
        ``call.permissions`` are the plugin's own permissions the person holds."""
        call = ToolCall.parse(name, read_json(body))
        installation = await self._known(call.installation_id)
        verify_signature(installation.signing_secret, body, signature, tolerance=self._tolerance)
        return installation, call

    # -- 4. actions --------------------------------------------------------------------------------

    def register_action(
        self,
        name: str,
        handler: ActionHandler,
        *,
        parse: Callable[[dict[str, Any]], Any] | None = None,
    ) -> None:
        """What ``POST /korsi/actions/{name}`` runs for one of the manifest's action tools
        (``kind: action``, ADR-0080).

        Korsi calls it only after the person confirmed the card the plugin's specialist prepared,
        with the card's arguments -- their edits included::

            async def create_position(action: ActionContext) -> ActionAnswer:
                case_id = (action.call.earlier.get("case", {}).get("result") or {}).get("case_id")
                position = await positions.create(action.korsi, action.arguments, case_id,
                                                  key=action.call.idempotency_key)
                return {"ok": True, "summary": said(action.call.locale, "position_created"),
                        "records": [{"type": "position", "external_id": position.id}]}

            plugin.register_action(
                "create_position", create_position, parse=Position.model_validate
            )

        ``parse`` is the plugin's own check of the arguments -- a model's ``model_validate``, say --
        and returns what the handler gets as ``arguments``. Korsi checked them against the tool's
        ``input_schema`` already; a raise is :class:`ActionArgumentsRejected` (422).
        """
        self._actions[name] = (handler, parse)

    async def verified_action(
        self, name: str, body: bytes, signature: str | None
    ) -> tuple[Installation, ActionCall]:
        """An action call's body, verified with its installation's secret and parsed, nothing run:
        for a plugin that dispatches actions itself. The body must name the tool the path does --
        the signature does not cover the path."""
        call = ActionCall.parse(name, read_json(body))
        installation = await self._known(call.installation_id)
        verify_signature(installation.signing_secret, body, signature, tolerance=self._tolerance)
        return installation, call

    async def action_call(self, name: str, body: bytes, signature: str | None) -> ActionAnswer:
        """``POST /korsi/actions/{name}``: verify, run the handler registered for ``name`` as the
        person who confirmed the card, and answer Korsi 200 with what it returns -- cut to Korsi's
        limits, so a long summary never turns a change that was made into a failure.

        **Once per change.** A repeat of the same ``idempotency_key`` while this process lives is
        answered what the first was, and the handler does not run again; a handler that raises is
        forgotten, so Korsi's next delivery runs it. After a restart this memory is gone: make the
        change under ``call.idempotency_key`` in the plugin's records, so a repeat finds it made.
        :class:`ActionUnknown` (404) for a name nothing was registered for.
        """
        installation, call = await self.verified_action(name, body, signature)
        registered = self._actions.get(name)
        if registered is None:
            msg = f"no handler is registered for action {name}"
            raise ActionUnknown(msg)
        now = time.monotonic()
        while self._answers and (
            next(iter(self._answers.values()))[0] <= now or len(self._answers) > 10_000
        ):
            self._answers.popitem(last=False)
        key = f"{installation.id}:{call.idempotency_key}"
        seen = self._answers.get(key)
        if seen is not None:
            return await asyncio.shield(seen[1])
        task = asyncio.ensure_future(self._run_action(installation, call, *registered))
        self._answers[key] = (now + _ACTION_ANSWER_TTL, task)
        task.add_done_callback(functools.partial(self._forget_failed, key))
        # Shielded: Korsi hanging up does not stop a change half made; its repeat finds the answer.
        return await asyncio.shield(task)

    def _forget_failed(self, key: str, task: asyncio.Task[ActionAnswer]) -> None:
        """A change that failed is forgotten, so Korsi's next delivery runs it again."""
        if task.cancelled() or task.exception() is not None:
            seen = self._answers.get(key)
            if seen is not None and seen[1] is task:
                del self._answers[key]

    async def _run_action(
        self,
        installation: Installation,
        call: ActionCall,
        handler: ActionHandler,
        parse: Callable[[dict[str, Any]], Any] | None,
    ) -> ActionAnswer:
        deadline = time.monotonic() + max(call.deadline_seconds - _ACTION_MARGIN, 1.0)
        caller = await self._vouch(installation, call.handle)
        if caller.installation_id != installation.id or caller.user_id != call.user_id:
            msg = "that handle is not the person who confirmed the card"
            raise HandleRejected(msg)
        arguments: Any = call.arguments
        if parse is not None:
            try:
                arguments = parse(call.arguments)
            except Exception as error:
                msg = f"action {call.name}: the arguments were refused: {error}"
                raise ActionArgumentsRejected(msg) from error
        context = ActionContext(
            installation=installation,
            call=call,
            arguments=arguments,
            caller=caller,
            korsi=self.client(installation, call.handle),
            deadline=deadline,
        )
        return _kept_answer(await handler(context), call.name)

    # -- 5. connections ---------------------------------------------------------------------------

    async def connection_call(
        self, body: bytes, signature: str | None
    ) -> tuple[Installation, ConnectionCall]:
        """``POST /korsi/connections``: verified, parsed, and refused if it was seen before.

        Dispatch on ``call.call`` (``deliveries.VERIFY``, ``SYNC``, ``CALENDAR``) and answer 200
        with the call's answer -- a refusal by the other system included, as ``{"error": ...}``.
        An installation this plugin does not have is :class:`Unprovisioned` (409): a plugin Korsi
        runs has no disk, and after a restart this is how Korsi learns to give it its credentials
        again, as on every delivery.
        """
        call = ConnectionCall.parse(read_json(body))
        installation = await self._known(call.installation_id)
        verify_signature(installation.signing_secret, body, signature, tolerance=self._tolerance)
        now = time.monotonic()
        while self._calls and next(iter(self._calls.values())) < now - 2 * self._tolerance:
            self._calls.popitem(last=False)
        if call.call_id in self._calls:
            msg = f"call {call.call_id} was answered already"
            raise CallReplayed(msg)
        self._calls[call.call_id] = now
        return installation, call

    # -- 6. a page's caller ------------------------------------------------------------------------

    async def person(self, *, authorization: str | None, installation_id: str | None) -> Person:
        """The person a page's request is for, as Korsi vouches for them.

        ``authorization`` is the request's ``Authorization`` header (``Bearer <handle>``, the handle
        from the Bridge's ``getHandle()``); ``installation_id`` its ``X-Korsi-Installation``.
        Korsi's answer is reused for ``handle_cache_seconds``, so a page's burst of calls asks once.

        An installation this plugin has no credential for is :class:`Unprovisioned`: answer the page
        409 with ``{"code": "plugin.unprovisioned"}``, and ``@korsi/bridge``'s ``createPluginApi``
        asks Korsi to give the credential again and calls once more.
        """
        if not authorization or not authorization.lower().startswith("bearer "):
            msg = "a handle is required"
            raise HandleRejected(msg, status=401)
        handle = authorization.split(" ", 1)[1].strip()
        if not handle:
            msg = "a handle is required"
            raise HandleRejected(msg, status=401)
        try:
            wanted = uuid.UUID(installation_id or "")
        except ValueError as error:
            msg = f"{INSTALLATION_HEADER} is required"
            raise MalformedRequest(msg) from error
        installation = await self._known(wanted)
        caller = await self._vouch(installation, handle)
        if caller.installation_id != installation.id or not caller.is_person:
            msg = "that handle is not a person of this installation"
            raise HandleRejected(msg)
        return Person(installation=installation, caller=caller, handle=handle)

    async def _vouch(self, installation: Installation, handle: str) -> Caller:
        key = hashlib.sha256(f"{installation.id}:{handle}".encode()).hexdigest()
        now = time.monotonic()
        cached = self._handles.get(key)
        if cached and cached[0] > now:
            return cached[1]
        try:
            caller = await self.client(installation, handle).whoami()
        except KorsiRefused as refused:
            if refused.status in (401, 403):
                msg = f"Korsi refused the handle: {refused.code}"
                raise HandleRejected(msg, status=refused.status) from refused
            raise
        self._handles[key] = (now + self._handle_ttl, caller)
        self._handles.move_to_end(key)
        while len(self._handles) > 10_000:
            self._handles.popitem(last=False)
        return caller

    def _forget_handles(self, installation_id: uuid.UUID) -> None:
        for key, (_, caller) in list(self._handles.items()):
            if caller.installation_id == installation_id:
                del self._handles[key]
