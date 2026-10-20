"""The plugin plane (``{api_base}`` = ``https://<korsi>/plugin/v1``), as one bearer.

The bearer is the installation's own token when the plugin acts for itself, or a person's sealed
handle when it acts for them -- in which case Korsi narrows everything to what that person may see
and do. Every route of the plane is here (:data:`ROUTES`); the shapes are generated from Korsi's
OpenAPI document (:mod:`korsi_plugin.models`).

Use one :class:`KorsiClient` per bearer. Alone it owns its connection pool -- close it, or use it as
an ``async with`` block; from :meth:`korsi_plugin.KorsiPlugin.client` it shares the plugin's pool,
and closing it does nothing.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Final, Self, cast
from urllib.parse import quote

import httpx

from korsi_plugin.errors import KorsiRefused, KorsiUnreachable
from korsi_plugin.models import (
    Authority,
    Colleague,
    HoldView,
    InstallationState,
    IntakeResult,
    IntakeSource,
    PeoplePage,
    PluginEventPage,
    PluginEventView,
    PluginSelf,
    ProposalPage,
    ProposalView,
    RecordPage,
    RecordView,
    SubmitProposal,
    WalletView,
)
from korsi_plugin.operations import PlaneOperations
from korsi_plugin.wallet import Reservation

#: Korsi answers a person's page in well under this; a plugin that waits longer looks broken.
DEFAULT_TIMEOUT_SECONDS: Final = 15.0
#: The plane's version, sent by Korsi on every response.
VERSION_HEADER: Final = "Korsi-Plugin-API"
#: The plugin API this SDK was generated for. A Korsi on another major version is not this contract.
PLUGIN_API: Final = "1.0"

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
            settings=view.get("settings") or {},
            locale=view.get("locale") or "fa",
            timezone=view.get("timezone") or "Asia/Tehran",
        )


def _id(value: str | uuid.UUID) -> str:
    return quote(str(value), safe="")


def _amount(value: Quantity) -> str:
    return str(Decimal(value))


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
    ) -> Any:
        query = {key: _query(value) for key, value in (params or {}).items() if value is not None}
        try:
            response = await self._http.request(
                method,
                self.api_base + path,
                json=json,
                params=query,
                headers=self._headers,
                follow_redirects=False,
            )
        except httpx.HTTPError as error:
            msg = f"{method} {path}: {type(error).__name__}"
            raise KorsiUnreachable(msg) from error
        self.plugin_api = response.headers.get(VERSION_HEADER, self.plugin_api)
        if 300 <= response.status_code < 400:
            # The plane does not redirect. Following one would carry the bearer to another host,
            # or arrive without it and read as a refusal; neither is Korsi's answer.
            msg = f"{method} {path}: redirected ({response.status_code}), not followed"
            raise KorsiUnreachable(msg)
        if response.status_code >= 400:
            raise _refusal(response)
        if response.status_code == 204 or not response.content:
            return None
        return response.json()

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
        cursor: str | None = None,
        limit: int = 50,
    ) -> RecordPage:
        """One page of this plugin's records of a type; ``next_cursor`` reads the next."""
        params = {"case_id": str(case_id) if case_id else None, "cursor": cursor, "limit": limit}
        return cast(RecordPage, await self._call("GET", f"/records/{_id(type_key)}", params=params))

    async def iter_records(
        self, type_key: str, *, case_id: str | uuid.UUID | None = None, page_size: int = 200
    ) -> AsyncIterator[RecordView]:
        """Every record of a type, page by page."""
        cursor: str | None = None
        while True:
            page = await self.records(type_key, case_id=case_id, cursor=cursor, limit=page_size)
            for record in page["items"]:
                yield record
            cursor = page.get("next_cursor")
            if not cursor:
                return

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
