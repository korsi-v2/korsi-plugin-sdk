"""The plugin plane (``{api_base}`` = ``https://<korsi>/plugin/v1``), as one bearer.

The bearer is the installation's own token when the plugin acts for itself, or a person's sealed
handle when it acts for them -- in which case Korsi narrows everything to what that person may see
and do. Every route of the plane is here (:data:`ROUTES`); the shapes are generated from Korsi's
OpenAPI document (:mod:`korsi_plugin.models`).

Use one :class:`KorsiClient` per bearer. Alone it owns its connection pool -- close it, or use it as
an ``async with`` block; from :meth:`korsi_plugin.KorsiPlugin.client` it shares the plugin's pool,
and closing it does nothing.

Korsi is reached through the egress proxy the environment names (``HTTPS_PROXY``, ``HTTP_PROXY``,
``NO_PROXY``), as ``httpx`` reads them when no ``transport`` is given: a plugin Korsi runs has no
other way out of its container.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Final, Self, cast
from urllib.parse import quote

import httpx

from korsi_plugin.errors import (
    Code,
    KorsiRefused,
    KorsiUnreachable,
    is_text_pending,
    text_pending_seconds,
)
from korsi_plugin.models import (
    Authority,
    Colleague,
    FindFreeSlots,
    FreeSlotPage,
    HoldView,
    HostMeeting,
    InstallationState,
    IntakeResult,
    IntakeSource,
    LiveTranscript,
    MeetingDetail,
    ModelCompletion,
    PeoplePage,
    PluginEventPage,
    PluginEventView,
    PluginFile,
    PluginFileText,
    PluginModel,
    PluginModelPage,
    PluginSelf,
    ProposalPage,
    ProposalView,
    QueryRecords,
    RecordPage,
    RecordView,
    RequestCompletion,
    SubmitProposal,
    WalletView,
)
from korsi_plugin.operations import PlaneOperations
from korsi_plugin.wallet import Reservation

#: Korsi answers a person's page in well under this; a plugin that waits longer looks broken.
DEFAULT_TIMEOUT_SECONDS: Final = 15.0
#: How long a model completion may take: more than Korsi gives the model (180 seconds), so the
#: answer -- or Korsi's own refusal -- arrives rather than this SDK giving up first.
MODEL_TIMEOUT_SECONDS: Final = 210.0
#: How long a file's bytes may take to arrive.
CONTENT_TIMEOUT_SECONDS: Final = 120.0
#: How long ``file_text(..., wait=True)`` waits for a scan to be read, by default.
TEXT_WAIT_SECONDS: Final = 600.0
#: The plane's version, sent by Korsi on every response.
VERSION_HEADER: Final = "Korsi-Plugin-API"
#: The plugin API this SDK was generated for. A Korsi on another major version is not this contract.
PLUGIN_API: Final = "1.2"

#: Backoff before each repeat of a model completion, in seconds.
_COMPLETE_BACKOFF: Final = (1.0, 4.0, 10.0)

#: A quantity of a service: exact, never a float.
Quantity = Decimal | int | str

#: Korsi's codes for a status, when something in front of Korsi answered without a problem.
_STATUS_CODES: Final[Mapping[int, str]] = {
    400: "request.invalid",
    401: "auth.unauthenticated",
    403: "auth.forbidden",
    404: "resource.not_found",
    409: "resource.conflict",
    422: "request.invalid",
    429: "request.rate_limited",
}


@dataclass(frozen=True, slots=True)
class Caller:
    """Who Korsi says a bearer is (``GET /installation``), with ids as :class:`uuid.UUID`."""

    installation_id: uuid.UUID
    plugin_id: str
    version: str
    state: InstallationState
    #: A stable label for the organization, the same for this plugin every time; never its name.
    tenant_ref: str
    #: ``installation`` -- the plugin itself -- or ``delegated``: a person, through their handle.
    authority: Authority
    user_id: uuid.UUID | None
    scopes: tuple[str, ...]
    #: The plugin's own permissions (ADR-0082) the person holds in this installation, by their bare
    #: keys (``see_compensation``); empty for the installation itself. Korsi enforces them where it
    #: shows the plugin's things; inside the plugin's own routes the plugin does, by this. A page's
    #: caller is reused for ``handle_cache_seconds`` (60 by default), so a revoke reaches the plugin
    #: that much later; set it lower where that matters.
    permissions: tuple[str, ...] = ()
    settings: Mapping[str, Any] = field(default_factory=dict)
    locale: str = "fa"
    timezone: str = "Asia/Tehran"

    @property
    def is_person(self) -> bool:
        """Whether the bearer is a person's handle rather than the installation's own token."""
        return self.authority == "delegated" and self.user_id is not None

    @classmethod
    def from_view(cls, view: PluginSelf) -> Caller:
        user = view.get("user_id")
        return cls(
            installation_id=uuid.UUID(view["installation_id"]),
            plugin_id=view["plugin_id"],
            version=view["version"],
            state=view["state"],
            tenant_ref=view["tenant_ref"],
            authority=view["authority"],
            user_id=uuid.UUID(user) if user else None,
            scopes=tuple(view.get("scopes") or ()),
            permissions=tuple(view.get("permissions") or ()),
            settings=view.get("settings") or {},
            locale=view.get("locale") or "fa",
            timezone=view.get("timezone") or "Asia/Tehran",
        )


def _id(value: str | uuid.UUID) -> str:
    return quote(str(value), safe="")


def _amount(value: Quantity) -> str:
    return str(Decimal(value))


def _completion_retryable(error: Exception) -> bool:
    """Whether a completion that failed this way is worth asking again with the same key."""
    if isinstance(error, KorsiUnreachable):
        return True
    return (
        isinstance(error, KorsiRefused)
        and error.problem
        and error.code in (Code.SERVICE_UNAVAILABLE, Code.PROVIDER_UNREACHABLE)
    )


def _query(value: Any) -> Any:
    """A query value as Korsi reads it: ``true``, ISO times, ids as text, lists repeated."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, uuid.UUID | Decimal):
        return str(value)
    if isinstance(value, list | tuple):
        return [_query(item) for item in value]
    return value


class KorsiClient(PlaneOperations):
    """The plugin plane, as one bearer.

    The routes Korsi added after the first ones are generated (:mod:`korsi_plugin.operations`):
    each is a method named after the function Korsi serves it with, and :data:`ROUTES` names the
    method of every route.
    """

    def __init__(
        self,
        api_base: str,
        bearer: str,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        transport: httpx.AsyncBaseTransport | None = None,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self._headers = {"authorization": f"Bearer {bearer}"}
        self._owned = http is None
        self._http = http or httpx.AsyncClient(timeout=timeout, transport=transport)
        #: The plane's version Korsi last reported (``Korsi-Plugin-API``), once anything was asked.
        self.plugin_api: str | None = None

    async def aclose(self) -> None:
        if self._owned:
            await self._http.aclose()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def _call(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Mapping[str, Any] | None = None,
        timeout: float | None = None,
    ) -> Any:
        request = self._request(method, path, json=json, params=params, timeout=timeout)
        try:
            response = await self._http.send(request, follow_redirects=False)
        except httpx.HTTPError as error:
            msg = f"{method} {path}: {type(error).__name__}"
            raise KorsiUnreachable(msg) from error
        self._answered(method, path, response)
        if response.status_code == 204 or not response.content:
            return None
        return response.json()

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: Mapping[str, Any] | None = None,
        timeout: float | None = None,
    ) -> httpx.Request:
        query = {key: _query(value) for key, value in (params or {}).items() if value is not None}
        return self._http.build_request(
            method,
            self.api_base + path,
            json=json,
            params=query,
            headers=self._headers,
            timeout=httpx.USE_CLIENT_DEFAULT if timeout is None else timeout,
        )

    def _answered(self, method: str, path: str, response: httpx.Response) -> None:
        """Korsi's version, and its answer unless it is a redirect or a refusal (read already)."""
        self.plugin_api = response.headers.get(VERSION_HEADER, self.plugin_api)
        if 300 <= response.status_code < 400:
            # The plane does not redirect. Following one would carry the bearer to another host,
            # or arrive without it and read as a refusal; neither is Korsi's answer.
            msg = f"{method} {path}: redirected ({response.status_code}), not followed"
            raise KorsiUnreachable(msg)
        if response.status_code >= 400:
            raise _refusal(response)

    # -- who ---------------------------------------------------------------------------------------

    async def whoami(self) -> Caller:
        """Who this bearer is, and what it may do. The way to check a credential or a handle."""
        return Caller.from_view(cast(PluginSelf, await self._call("GET", "/installation")))

    async def people(self, *, include_inactive: bool = False) -> list[Colleague]:
        """Colleagues a proposal may be addressed to. Only active ones unless asked otherwise."""
        page = cast(PeoplePage, await self._call("GET", "/people"))
        return [
            person
            for person in page["items"]
            if include_inactive or person.get("status", "active") == "active"
        ]

    # -- the plugin's own records ------------------------------------------------------------------

    async def records(
        self,
        type_key: str,
        *,
        case_id: str | uuid.UUID | None = None,
        query: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> RecordPage:
        """One page of this plugin's records of a type, newest first; ``next_cursor`` reads the
        next. ``query`` keeps those with these words in their title."""
        params = {
            "case_id": str(case_id) if case_id else None,
            "query": query,
            "cursor": cursor,
            "limit": limit,
        }
        return cast(RecordPage, await self._call("GET", f"/records/{_id(type_key)}", params=params))

    async def iter_records(
        self,
        type_key: str,
        *,
        case_id: str | uuid.UUID | None = None,
        query: str | None = None,
        page_size: int = 200,
    ) -> AsyncIterator[RecordView]:
        """Every record of a type, page by page."""
        cursor: str | None = None
        while True:
            page = await self.records(
                type_key, case_id=case_id, query=query, cursor=cursor, limit=page_size
            )
            for record in page["items"]:
                yield record
            cursor = page.get("next_cursor")
            if not cursor:
                return

    async def query_records(self, type_key: str, query: QueryRecords | None = None) -> RecordPage:
        """This plugin's records of a type, by the fields the type declares (ADR-0085)::

            await korsi.query_records("application", {
                "where": [{"field": "stage", "op": "in", "value": ["screening", "interview"]},
                          {"field": "fit", "op": "gte", "value": 70}],
                "order_by": {"field": "received_at", "dir": "desc"},
            })

        Up to five conditions, all of which must hold; operators ``eq``, ``in``, ``gt``, ``gte``,
        ``lt``, ``lte``, ``prefix``, ``exists``. Read through the same visibility as
        :meth:`records`: on a person's behalf, only what that person may see. A field the type does
        not declare is ``422 plugin.record_field_unknown``. Pass ``next_cursor`` back as
        ``cursor``, with the same order.
        """
        path = f"/records/{_id(type_key)}/query"
        return cast(RecordPage, await self._call("POST", path, json=dict(query or {})))

    async def iter_query_records(
        self, type_key: str, query: QueryRecords | None = None, *, page_size: int = 200
    ) -> AsyncIterator[RecordView]:
        """Every record a query finds, page by page."""
        body = cast(QueryRecords, {**(query or {}), "limit": page_size})
        while True:
            page = await self.query_records(type_key, body)
            for record in page["items"]:
                yield record
            cursor = page.get("next_cursor")
            if not cursor:
                return
            body = cast(QueryRecords, {**body, "cursor": cursor})

    async def record(self, type_key: str, external_id: str) -> RecordView | None:
        """One of this plugin's records, or ``None`` when there is none by that id."""
        try:
            found = await self._call("GET", f"/records/{_id(type_key)}/{_id(external_id)}")
        except KorsiRefused as refused:
            if refused.status == 404:
                return None
            raise
        return cast(RecordView, found)

    async def put_record(
        self,
        type_key: str,
        external_id: str,
        data: Mapping[str, Any],
        *,
        case_id: str | uuid.UUID | None = None,
        owner_user_id: str | uuid.UUID | None = None,
        expected_version: int | None = None,
    ) -> RecordView:
        """Create or replace one of this plugin's records, keyed by the plugin's own id for it.

        ``expected_version`` makes the write conditional: Korsi refuses it with
        ``plugin.record_version_conflict`` if somebody wrote the record since.
        """
        body: dict[str, Any] = {"data": dict(data)}
        if case_id is not None:
            body["case_id"] = str(case_id)
        if owner_user_id is not None:
            body["owner_user_id"] = str(owner_user_id)
        if expected_version is not None:
            body["expected_version"] = expected_version
        path = f"/records/{_id(type_key)}/{_id(external_id)}"
        return cast(RecordView, await self._call("PUT", path, json=body))

    async def delete_record(self, type_key: str, external_id: str) -> None:
        await self._call("DELETE", f"/records/{_id(type_key)}/{_id(external_id)}")

    # -- into Korsi's own records: proposals and sources -------------------------------------------

    async def propose(self, proposal: SubmitProposal) -> ProposalView:
        """Propose a change to one of Korsi's records. A person -- or the organization's rule for
        a low-risk type -- applies it; the verdict comes back as ``plugin.proposal.settled``."""
        return cast(ProposalView, await self._call("POST", "/proposals", json=dict(proposal)))

    async def proposals(self) -> list[ProposalView]:
        page = cast(ProposalPage, await self._call("GET", "/proposals"))
        return list(page["items"])

    async def proposal(self, proposal_id: str | uuid.UUID) -> ProposalView:
        return cast(ProposalView, await self._call("GET", f"/proposals/{_id(proposal_id)}"))

    async def bring_in(self, source: IntakeSource) -> IntakeResult:
        """Bring a message or a document in. It waits for a person's review; the same
        ``external_id`` twice is the same source (``created`` is false the second time)."""
        return cast(IntakeResult, await self._call("POST", "/sources", json=dict(source)))

    # -- the wallet --------------------------------------------------------------------------------

    async def wallet(self) -> WalletView:
        """This installation's wallet. :meth:`korsi_plugin.Wallet.of` reads its amounts exactly."""
        return cast(WalletView, await self._call("GET", "/wallet"))

    async def open_hold(
        self, service: str, quantity: Quantity, *, idempotency_key: str
    ) -> HoldView:
        """Reserve MU before a service, at the active plan's rate. Prefer :meth:`reserve`."""
        body = {
            "service": service,
            "quantity": _amount(quantity),
            "idempotency_key": idempotency_key,
        }
        return cast(HoldView, await self._call("POST", "/wallet/holds", json=body))

    async def settle_hold(
        self, hold_id: str | uuid.UUID, *, reference: str, quantity: Quantity | None = None
    ) -> HoldView:
        """Spend a reservation: all of it, or ``quantity`` of what was reserved."""
        body: dict[str, Any] = {"reference": reference}
        if quantity is not None:
            body["quantity"] = _amount(quantity)
        path = f"/wallet/holds/{_id(hold_id)}/settle"
        return cast(HoldView, await self._call("POST", path, json=body))

    async def release_hold(self, hold_id: str | uuid.UUID) -> HoldView:
        """Give a reservation back: the service was not done."""
        path = f"/wallet/holds/{_id(hold_id)}/release"
        return cast(HoldView, await self._call("POST", path))

    async def consume(
        self, service: str, quantity: Quantity, *, idempotency_key: str, reference: str
    ) -> HoldView:
        """Reserve and spend in one call, for a service that is done the moment it is asked for.

        Korsi prices ``service`` from the active plan's rate. The same ``idempotency_key`` twice is
        charged once. Raises :class:`~korsi_plugin.KorsiRefused` with
        ``plugin.wallet_insufficient`` (402) when the wallet cannot cover it: the organization has
        to buy a plan, which only Korsi can sell.
        """
        body = {
            "service": service,
            "quantity": _amount(quantity),
            "idempotency_key": idempotency_key,
            "reference": reference,
        }
        return cast(HoldView, await self._call("POST", "/wallet/consume", json=body))

    def reserve(
        self, service: str, quantity: Quantity, *, idempotency_key: str, reference: str
    ) -> Reservation:
        """Reserve before a service and settle after it, as one ``async with`` block.

        The hold is opened on entering. Leaving the block normally settles it -- for what
        :meth:`Reservation.use` said was used, or all of it; leaving it with an exception releases
        it, so a service that failed costs nothing::

            async with korsi.reserve("pages.ocr", 10, idempotency_key=key, reference=doc) as hold:
                pages = await ocr(document)
                hold.use(len(pages))
        """
        return Reservation(
            self, service, quantity, idempotency_key=idempotency_key, reference=reference
        )

    # -- files a person handed the plugin ----------------------------------------------------------

    async def file(self, file_id: str | uuid.UUID) -> PluginFile:
        """A file a person handed this installation in Korsi's own picker (the Bridge's
        ``pickFile``, ``files.read``). Any other is ``404 plugin.file_not_granted``. Read on their
        behalf or, for work done later, as the installation itself."""
        return cast(PluginFile, await self._call("GET", f"/files/{_id(file_id)}"))

    async def file_content(
        self, file_id: str | uuid.UUID, *, timeout: float = CONTENT_TIMEOUT_SECONDS
    ) -> bytes:
        """The file's bytes as the person gave them, all at once; :meth:`iter_file_content`
        streams them. :meth:`file`'s ``media_type`` is what Korsi read them as: for showing,
        never for trusting."""
        return b"".join([chunk async for chunk in self.iter_file_content(file_id, timeout=timeout)])

    async def iter_file_content(
        self,
        file_id: str | uuid.UUID,
        *,
        timeout: float = CONTENT_TIMEOUT_SECONDS,
        chunk_size: int = 65_536,
    ) -> AsyncIterator[bytes]:
        """The file's bytes, streamed, as they arrive."""
        path = f"/files/{_id(file_id)}/content"
        request = self._request("GET", path, timeout=timeout)
        try:
            response = await self._http.send(request, follow_redirects=False, stream=True)
        except httpx.HTTPError as error:
            msg = f"GET {path}: {type(error).__name__}"
            raise KorsiUnreachable(msg) from error
        try:
            if response.status_code >= 300:
                await response.aread()
            self._answered("GET", path, response)
            async for chunk in response.aiter_bytes(chunk_size):
                yield chunk
        except httpx.HTTPError as error:
            msg = f"GET {path}: {type(error).__name__}"
            raise KorsiUnreachable(msg) from error
        finally:
            await response.aclose()

    async def file_text(
        self,
        file_id: str | uuid.UUID,
        *,
        wait: bool = False,
        wait_seconds: float = TEXT_WAIT_SECONDS,
    ) -> PluginFileText:
        """The text Korsi read out of the file: plain text, Word, Excel, OpenDocument, PowerPoint
        and a PDF's own text layer (``extraction: local``), at no cost.

        A scan is read by OCR, a paid service only with ``models.use``, billed to the publisher
        once: the first ask queues it and is refused ``409 plugin.text_pending``
        (:func:`~korsi_plugin.is_text_pending`, :func:`~korsi_plugin.text_pending_seconds`); once
        read, every ask answers its text (``extraction: ocr``). With ``wait=True`` this asks again
        when Korsi says, until the text is there or ``wait_seconds`` ran out -- then it raises the
        last refusal. Without ``models.use``, or for a file Korsi does not read, it is ``409
        plugin.text_unavailable`` with ``params["reason"]``: ``scan``, ``ocr_unavailable``,
        ``archive``, ``kind``, ``too_large`` or ``unreadable``. ``402 plugin.publisher_funds``
        while the publisher's paid services are paused.
        """
        until = time.monotonic() + wait_seconds
        while True:
            try:
                found = await self._call("GET", f"/files/{_id(file_id)}/text")
            except KorsiRefused as refused:
                if not wait or not is_text_pending(refused):
                    raise
                pause = text_pending_seconds(refused)
                if time.monotonic() + pause > until:
                    raise
                await asyncio.sleep(pause)
                continue
            return cast(PluginFileText, found)

    # -- Korsi's language models (models.use, a trusted scope) -------------------------------------

    async def models(self) -> list[PluginModel]:
        """The models Korsi lends this plugin, with their price per million tokens in dollars."""
        page = cast(PluginModelPage, await self._call("GET", "/models"))
        return list(page["items"])

    async def complete(
        self,
        request: RequestCompletion,
        *,
        timeout: float = MODEL_TIMEOUT_SECONDS,
        retries: int = 2,
    ) -> ModelCompletion:
        """One answer from one of Korsi's models, at the publisher's cost (ADR-0081).

        Korsi calls the model for the plugin, so the plugin brings no key and the organization's
        data goes nowhere Korsi's own does not. ``usd_cost`` is what Korsi charged the publisher,
        as an exact decimal string; ``finish_reason`` ``length`` is an answer cut at
        ``max_tokens``::

            answer = await korsi.complete({
                "model": model,  # one of models()
                "max_tokens": 800,
                "purpose": "cv_extract",  # shown in the publisher's ledger
                "idempotency_key": f"cv:{file_id}:v1",
                "messages": [{"role": "system", "content": PROMPT},
                             {"role": "user", "content": text}],
                "response_format": {"type": "json_object"},
            })

        The same ``idempotency_key`` is answered with the first answer for an hour, at no cost,
        and a retry that arrives while the first attempt still runs waits for it -- so this asks
        again with it, up to ``retries`` times, when Korsi did not answer or said to try again
        (``503 service.unavailable``, ``502 provider.unreachable``). Refusals to branch on:
        ``402 plugin.publisher_funds`` (:func:`~korsi_plugin.is_publisher_funds`: the publisher's
        paid services are paused), ``422 plugin.model_not_allowed``, ``429 plugin.rate_limited``
        (the ``models`` budget; ``retry_after``), and ``422 request.invalid`` for a key used for
        another request.
        """
        attempt = 0
        while True:
            try:
                answer = await self._call(
                    "POST", "/models/complete", json=dict(request), timeout=timeout
                )
            except (KorsiRefused, KorsiUnreachable) as error:
                if attempt >= retries or not _completion_retryable(error):
                    raise
                await asyncio.sleep(_COMPLETE_BACKOFF[min(attempt, len(_COMPLETE_BACKOFF) - 1)])
                attempt += 1
                continue
            return cast(ModelCompletion, answer)

    # -- the calendar and meetings -----------------------------------------------------------------

    async def free_slots(self, search: FindFreeSlots) -> FreeSlotPage:
        """When every one of these people -- active members, at most 20 -- is free for
        ``duration_minutes``, from day ``from`` to day ``to`` (``2026-11-02``, at most 31 days),
        inside the organization's working hours unless ``within_hours`` is false (ADR-0085).

        Times only, never what fills anybody's time; nothing is booked. On a person's behalf
        only, under ``calendar.read``.
        """
        found = await self._call("POST", "/calendar/free-slots", json=dict(search))
        return cast(FreeSlotPage, found)

    async def host_meeting(self, meeting: HostMeeting) -> MeetingDetail:
        """Host a meeting for the person in front of the plugin (``meetings.host``, a trusted
        scope; ADR-0083).

        They create it, and must be able to open ``case_id``. The same ``external_id`` answers the
        meeting already made. Its attendees are ``participant_user_ids`` (members, the person in
        front of the plugin too when named) and ``guests``, people with no account by ``{"name"}``
        alone (at most 10, 50 people in all): a guest's name grants nothing. A ``restricted``
        meeting is seen only by its participants, the people in its case and this installation,
        and never enters the organization's memory. With ``recording.consent`` ``required`` (the
        default) Korsi asks for consent before it records.
        The room is Korsi's own page: the plugin's page opens it with the Bridge's
        ``showInKorsi({kind: "meeting", id})``.
        """
        return cast(MeetingDetail, await self._call("POST", "/meetings", json=dict(meeting)))

    async def live_transcript(
        self, meeting_id: str | uuid.UUID, *, since: str | datetime | None = None
    ) -> LiveTranscript:
        """What is being said in a meeting this installation hosts (``meetings.live.read``, a
        trusted scope): a preview, not the record -- the transcript read from the recording is,
        announced by ``meeting.transcript_ready``.

        Poll it, passing ``covered_through`` back as ``since`` for what came after.
        ``speaker_key`` stays the same for one voice, so earlier lines can take a name it is given
        later. Any other meeting is ``404 plugin.meeting_not_hosted``.
        """
        path = f"/meetings/{_id(meeting_id)}/live/transcript"
        return cast(LiveTranscript, await self._call("GET", path, params={"since": since}))

    # -- events, by polling ------------------------------------------------------------------------

    async def events(self, *, after: int = 0, limit: int = 100) -> PluginEventPage:
        """This installation's events after a sequence number; ``next_after`` reads on."""
        params = {"after": after, "limit": limit}
        return cast(PluginEventPage, await self._call("GET", "/events", params=params))

    async def iter_events(
        self, *, after: int = 0, page_size: int = 100
    ) -> AsyncIterator[PluginEventView]:
        """Every event after ``after``, until the stream is read to its end.

        For a plugin Korsi cannot reach: remember the last ``sequence`` handled and start from it
        next time. Delivery by webhook and polling read the same stream, so a plugin may do both.
        """
        while True:
            page = await self.events(after=after, limit=page_size)
            for event in page["items"]:
                yield event
            if not page["items"] or page["next_after"] <= after:
                return
            after = page["next_after"]


def _retry_after(response: httpx.Response) -> float | None:
    try:
        return max(float(response.headers.get("retry-after", "")), 0.0)
    except ValueError:
        return None


def _refusal(response: httpx.Response) -> KorsiRefused | KorsiUnreachable:
    status = response.status_code
    if response.headers.get("content-type", "").startswith("application/problem+json"):
        try:
            problem = response.json()
        except ValueError:
            problem = None
        if isinstance(problem, dict):
            return KorsiRefused(
                status,
                str(problem.get("code") or _STATUS_CODES.get(status, f"http.{status}")),
                problem.get("title") or problem.get("detail"),
                params=problem.get("params") or {},
                request_id=problem.get("request_id"),
                errors=problem.get("errors") or [],
                retry_after=_retry_after(response),
            )
    if status >= 500:
        # Not Korsi's problem document: a proxy or a gateway in front of it. Nothing was refused.
        return KorsiUnreachable(f"HTTP {status} without a problem document")
    return KorsiRefused(
        status,
        _STATUS_CODES.get(status, f"http.{status}"),
        response.text[:300],
        retry_after=_retry_after(response),
        problem=False,
    )
