"""The installation's wallet: MU an organization bought for this plugin, spent per service.

**Korsi prices, the plugin counts.** The plugin says which service (declared in its manifest's
``services``) and how many; Korsi computes MU from the active plan's rate. A plugin never sends an
amount of money.

**Reserve, then settle** -- or, for a service done the moment it is asked for, consume in one call.
:class:`Reservation` is the pair as one ``async with`` block, so a service that fails releases what
it reserved instead of leaving it held until the hold expires.

**Amounts are exact.** Korsi sends MU as decimal strings; :class:`Wallet` reads them as
:class:`~decimal.Decimal`, never as floats.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Self

from korsi_plugin.errors import Code, KorsiError, KorsiRefused
from korsi_plugin.models import HoldView, PlanPeriod, WalletView

if TYPE_CHECKING:
    from korsi_plugin.client import KorsiClient, Quantity

logger = logging.getLogger(__name__)


def is_wallet_insufficient(error: BaseException) -> bool:
    """Whether ``error`` is Korsi saying the wallet cannot cover a service (402).

    The answer to show the person is "your organization needs a plan for this plugin" -- only Korsi
    sells one -- never a retry.
    """
    return isinstance(error, KorsiRefused) and error.code == Code.WALLET_INSUFFICIENT


def is_no_active_plan(error: BaseException) -> bool:
    """Whether ``error`` is Korsi saying the organization has no active plan for this plugin."""
    return isinstance(error, KorsiRefused) and error.code == Code.NO_ACTIVE_PLAN


@dataclass(frozen=True, slots=True)
class Wallet:
    """A wallet's amounts, exact."""

    balance: Decimal
    reserved: Decimal
    #: What can be reserved now: the balance less what is reserved.
    available: Decimal
    consumed_this_period: Decimal
    credited_this_period: Decimal
    plan_key: str | None
    plan_period: PlanPeriod | None
    period_ends_at: datetime | None

    @classmethod
    def of(cls, view: WalletView) -> Self:
        ends = view.get("period_ends_at")
        return cls(
            balance=Decimal(view["balance"]),
            reserved=Decimal(view["reserved"]),
            available=Decimal(view["available"]),
            consumed_this_period=Decimal(view["consumed_this_period"]),
            credited_this_period=Decimal(view["credited_this_period"]),
            plan_key=view.get("plan_key"),
            plan_period=view.get("plan_period"),
            period_ends_at=datetime.fromisoformat(ends) if ends else None,
        )

    @property
    def has_plan(self) -> bool:
        return self.plan_key is not None

    def covers(self, amount_mu: Decimal | int | str) -> bool:
        """Whether ``amount_mu`` MU could be reserved now. Korsi decides; this only predicts."""
        return self.available >= Decimal(amount_mu)


class Reservation:
    """A hold opened on entering and settled -- or released -- on leaving. See
    :meth:`korsi_plugin.KorsiClient.reserve`."""

    def __init__(
        self,
        client: KorsiClient,
        service: str,
        quantity: Quantity,
        *,
        idempotency_key: str,
        reference: str,
    ) -> None:
        self._client = client
        self.service = service
        self.quantity = quantity
        self.idempotency_key = idempotency_key
        self.reference = reference
        self._used: Quantity | None = None
        #: The hold as Korsi opened it; then as it was settled or released.
        self.hold: HoldView | None = None

    def use(self, quantity: Quantity) -> None:
        """Settle for ``quantity`` rather than everything reserved: the service used less."""
        self._used = quantity

    async def __aenter__(self) -> Self:
        self.hold = await self._client.open_hold(
            self.service, self.quantity, idempotency_key=self.idempotency_key
        )
        return self

    async def __aexit__(self, kind: type[BaseException] | None, *_: object) -> None:
        if self.hold is None:
            return
        if kind is None:
            self.hold = await self._client.settle_hold(
                self.hold["id"], reference=self.reference, quantity=self._used
            )
            return
        try:
            self.hold = await self._client.release_hold(self.hold["id"])
        except KorsiError:
            # The service's own failure is the error worth raising; an unreleased hold expires.
            logger.warning("korsi hold %s not released", self.hold["id"], exc_info=True)
