"""What can go wrong talking to Korsi, as exceptions a plugin branches on.

**Korsi's refusals are problem documents** (``application/problem+json``) with a stable ``code``,
such as ``plugin.wallet_insufficient``. :class:`KorsiRefused` carries it, so callers decide by code,
never by message text: ``title`` is written for a person, in the caller's language, and changes.

**Korsi not answering is a different thing** (:class:`KorsiUnreachable`): the network, a timeout,
a proxy. Nothing about the plugin's standing follows from it -- in particular, not that an
installation was removed.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final


class RequestRejected(Exception):
    """A request *to the plugin* that it must refuse; ``status`` is the HTTP answer to give.

    Raised by :class:`korsi_plugin.KorsiPlugin` for a call that is not Korsi's (a bad signature), is
    for an installation the plugin does not know, or carries a handle Korsi does not vouch for. A
    web framework maps the whole family to ``status`` in one handler.
    """

    status: int = 400

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        if status is not None:
            self.status = status


class KorsiError(Exception):
    """Anything this SDK raises about Korsi."""


class KorsiUnreachable(KorsiError):
    """Korsi did not answer: the network, a timeout. Try again later; conclude nothing."""


class KorsiRefused(KorsiError):
    """Korsi answered with a problem. ``code`` is the contract; ``title`` is for people and logs."""

    def __init__(
        self,
        status: int,
        code: str,
        title: str | None = None,
        *,
        params: Mapping[str, Any] | None = None,
        request_id: str | None = None,
        errors: list[dict[str, Any]] | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(f"{status} {code}: {title or ''}".rstrip(": "))
        self.status = status
        self.code = code
        self.title = title
        self.params: Mapping[str, Any] = params or {}
        self.request_id = request_id
        self.errors = errors or []
        #: Seconds to wait before asking again, when Korsi said (``429 plugin.rate_limited``: the
        #: installation spent one of its budgets -- reads, writes, sources, proposals).
        self.retry_after = retry_after

    @property
    def detail(self) -> str | None:
        """The problem's sentence, for a log line or an error shown to a developer."""
        return self.title


class Code:
    """Korsi's stable codes a plugin most often branches on. The full list is Korsi's catalog."""

    UNAUTHENTICATED: Final = "auth.unauthenticated"
    FORBIDDEN: Final = "auth.forbidden"
    NOT_FOUND: Final = "resource.not_found"
    INVALID: Final = "request.invalid"
    RATE_LIMITED: Final = "request.rate_limited"
    #: One of the installation's budgets (reads, writes, sources, proposals) is spent: ``429``,
    #: with ``Retry-After``.
    PLUGIN_RATE_LIMITED: Final = "plugin.rate_limited"

    NOT_A_PLUGIN: Final = "plugin.not_a_plugin"
    INSTALLATION_NOT_FOUND: Final = "plugin.installation_not_found"
    INSTALLATION_INACTIVE: Final = "plugin.installation_inactive"
    HANDLE_INVALID: Final = "plugin.handle_invalid"
    PLUGIN_NOT_VISIBLE: Final = "plugin.not_visible"
    SCOPE_MISSING: Final = "plugin.scope_missing"

    RECORD_TYPE_UNKNOWN: Final = "plugin.record_type_unknown"
    RECORD_INVALID: Final = "plugin.record_invalid"
    RECORD_NOT_FOUND: Final = "plugin.record_not_found"
    RECORD_VERSION_CONFLICT: Final = "plugin.record_version_conflict"
    RECORD_READ_ONLY: Final = "plugin.record_read_only"

    PROPOSAL_INVALID: Final = "plugin.proposal_invalid"
    PROPOSAL_TYPE_NOT_DECLARED: Final = "plugin.proposal_type_not_declared"
    INTAKE_KIND_NOT_DECLARED: Final = "plugin.intake_kind_not_declared"
    PERSONAL_NEEDS_PERSON: Final = "plugin.personal_needs_person"

    NO_ACTIVE_PLAN: Final = "plugin.no_active_plan"
    SERVICE_UNKNOWN: Final = "plugin.service_unknown"
    WALLET_INSUFFICIENT: Final = "plugin.wallet_insufficient"
    HOLD_NOT_FOUND: Final = "plugin.hold_not_found"
    HOLD_SETTLED: Final = "plugin.hold_settled"


def is_rate_limited(error: BaseException) -> bool:
    """Whether ``error`` is Korsi asking the plugin to slow down; ``retry_after`` says how long."""
    return isinstance(error, KorsiRefused) and (
        error.status == 429 or error.code in (Code.PLUGIN_RATE_LIMITED, Code.RATE_LIMITED)
    )


def credential_refused(error: KorsiRefused) -> bool:
    """Whether Korsi's refusal means *this credential no longer belongs to an installation*.

    The only evidence a plugin should accept that it was removed: an unsigned ``removed`` message
    could come from anybody, so a plugin believes it only once Korsi itself refuses the stored
    token. That is a 401 (the machine user is switched off), ``plugin.not_a_plugin`` (the token no
    longer maps to a live installation), ``plugin.installation_not_found``, or
    ``plugin.installation_inactive`` *with state removed*. A suspended installation is refused too,
    and comes back; a 5xx says nothing at all.
    """
    if error.status == 401:
        return True
    if error.code in (Code.NOT_A_PLUGIN, Code.INSTALLATION_NOT_FOUND):
        return True
    return error.code == Code.INSTALLATION_INACTIVE and error.params.get("state") == "removed"
