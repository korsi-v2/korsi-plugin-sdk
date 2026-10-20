"""The server side of a Korsi plugin.

* :class:`KorsiPlugin` -- the lifecycle, events, tool calls and a page's caller, verified;
* :class:`KorsiClient` -- the plugin plane (``/plugin/v1``), typed from Korsi's OpenAPI document;
* :func:`verify_signature` -- ``Korsi-Signature``, for a server that wants only that;
* :class:`Wallet` and :meth:`KorsiClient.reserve` -- MU, exactly, and reserve-then-settle.

The design behind every rule here is Korsi's plugin architecture (ADR-0058); the developer guide is
at ``developers.korsi.ai``.
"""

from korsi_plugin.client import PLUGIN_API, VERSION_HEADER, Caller, KorsiClient, Quantity
from korsi_plugin.dedupe import EventLog, MemoryEventLog, SQLiteEventLog
from korsi_plugin.deliveries import (
    EVENTS_PATH,
    LIFECYCLE_PATH,
    TOOLS_PATH,
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
    CredentialMismatch,
    EventStatus,
    HandleRejected,
    InstallationStore,
    KorsiPlugin,
    LifecycleResult,
    LifecycleStatus,
    Person,
    UnknownInstallation,
)
from korsi_plugin.signature import (
    DEFAULT_TOLERANCE_SECONDS,
    EVENT_ID_HEADER,
    SIGNATURE_HEADER,
    SignatureInvalid,
    sign,
    verify_signature,
)
from korsi_plugin.wallet import Reservation, Wallet, is_no_active_plan, is_wallet_insufficient

__version__ = "0.1.0"

__all__ = [
    "DEFAULT_TOLERANCE_SECONDS",
    "EVENTS_PATH",
    "EVENT_ID_HEADER",
    "INSTALLATION_HEADER",
    "LIFECYCLE_PATH",
    "PLUGIN_API",
    "ROUTES",
    "SIGNATURE_HEADER",
    "TOOLS_PATH",
    "VERSION_HEADER",
    "Caller",
    "Code",
    "CredentialMismatch",
    "Event",
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
    "ToolCall",
    "Topic",
    "UnknownInstallation",
    "Wallet",
    "__version__",
    "credential_refused",
    "is_no_active_plan",
    "is_rate_limited",
    "is_wallet_insufficient",
    "sign",
    "verify_signature",
]
