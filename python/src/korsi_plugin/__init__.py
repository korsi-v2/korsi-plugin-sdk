"""The server side of a Korsi plugin.

* :class:`KorsiPlugin` -- the lifecycle, events, tool calls and a page's caller, verified;
* :class:`KorsiClient` -- the plugin plane (``/plugin/v1``), typed from Korsi's OpenAPI document;
* :func:`verify_signature` -- ``Korsi-Signature``, for a server that wants only that;
* :class:`Wallet` and :meth:`KorsiClient.reserve` -- MU, exactly, and reserve-then-settle.

The design behind every rule here is Korsi's plugin architecture (ADR-0058); the developer guide is
at ``developers.korsi.ai``.
"""

from korsi_plugin.client import PLUGIN_API, VERSION_HEADER, Caller, KorsiClient, Quantity
from korsi_plugin.dedupe import (
    DEFAULT_LEASE_SECONDS,
    ClaimStatus,
    EventLog,
    MemoryEventLog,
    SQLiteEventLog,
)
from korsi_plugin.deliveries import (
    CALENDAR,
    CONNECTIONS_PATH,
    EVENTS_PATH,
    LIFECYCLE_PATH,
    SYNC,
    TOOLS_PATH,
    VERIFY,
    ConnectionCall,
    Event,
    Installation,
    Installed,
    MalformedRequest,
    Removed,
    ToolCall,
    Topic,
)
from korsi_plugin.errors import (
    Code,
    KorsiError,
    KorsiRefused,
    KorsiUnreachable,
    RequestRejected,
    credential_refused,
    is_rate_limited,
)
from korsi_plugin.operations import ROUTES, PlaneOperations
from korsi_plugin.plugin import (
    INSTALLATION_HEADER,
    CallReplayed,
    CredentialMismatch,
    EventInProgress,
    EventStatus,
    HandleRejected,
    InstallationStore,
    KorsiPlugin,
    LifecycleResult,
    LifecycleStatus,
    Person,
    UnknownInstallation,
    Unprovisioned,
)
from korsi_plugin.signature import (
    DEFAULT_TOLERANCE_SECONDS,
    EVENT_ID_HEADER,
    SIGNATURE_HEADER,
    SignatureInvalid,
    SignatureStale,
    sign,
    verify_signature,
)
from korsi_plugin.trust import api_base_problem
from korsi_plugin.wallet import Reservation, Wallet, is_no_active_plan, is_wallet_insufficient

__version__ = "0.1.0"

__all__ = [
    "CALENDAR",
    "CONNECTIONS_PATH",
    "DEFAULT_LEASE_SECONDS",
    "DEFAULT_TOLERANCE_SECONDS",
    "EVENTS_PATH",
    "EVENT_ID_HEADER",
    "INSTALLATION_HEADER",
    "LIFECYCLE_PATH",
    "PLUGIN_API",
    "ROUTES",
    "SIGNATURE_HEADER",
    "SYNC",
    "TOOLS_PATH",
    "VERIFY",
    "VERSION_HEADER",
    "CallReplayed",
    "Caller",
    "ClaimStatus",
    "Code",
    "ConnectionCall",
    "CredentialMismatch",
    "Event",
    "EventInProgress",
    "EventLog",
    "EventStatus",
    "HandleRejected",
    "Installation",
    "InstallationStore",
    "Installed",
    "KorsiClient",
    "KorsiError",
    "KorsiPlugin",
    "KorsiRefused",
    "KorsiUnreachable",
    "LifecycleResult",
    "LifecycleStatus",
    "MalformedRequest",
    "MemoryEventLog",
    "Person",
    "PlaneOperations",
    "Quantity",
    "Removed",
    "RequestRejected",
    "Reservation",
    "SQLiteEventLog",
    "SignatureInvalid",
    "SignatureStale",
    "ToolCall",
    "Topic",
    "UnknownInstallation",
    "Unprovisioned",
    "Wallet",
    "__version__",
    "api_base_problem",
    "credential_refused",
    "is_no_active_plan",
    "is_rate_limited",
    "is_wallet_insufficient",
    "sign",
    "verify_signature",
]
