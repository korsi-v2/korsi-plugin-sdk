"""Korsi's signature: what makes a call Korsi's and not anybody's.

Every lifecycle call, event and tool call Korsi sends a plugin carries

    Korsi-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">

under the installation's signing secret. The body is signed byte for byte, so verify the raw body
you received, before any JSON parser has touched it. An old signature is refused, so a captured
request cannot be replayed later.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Final

from korsi_plugin.errors import RequestRejected

#: The header Korsi signs with.
SIGNATURE_HEADER: Final = "Korsi-Signature"
#: The event's id, on every event delivery, for deduplication.
EVENT_ID_HEADER: Final = "Korsi-Event-Id"
#: How old a signature may be before it is refused as a replay. Korsi's own guidance: five minutes.
DEFAULT_TOLERANCE_SECONDS: Final = 300


class SignatureInvalid(RequestRejected):
    """A request that does not carry Korsi's signature for this installation."""

    status = 401


def _digest(secret: str, stamp: str, body: bytes) -> str:
    return hmac.new(secret.encode(), f"{stamp}.".encode() + body, hashlib.sha256).hexdigest()


def sign(secret: str, body: bytes, *, now: int | None = None) -> str:
    """The header Korsi would send for ``body``: for tests, and for reading the scheme."""
    stamp = str(now if now is not None else int(time.time()))
    return f"t={stamp},v1={_digest(secret, stamp, body)}"


def verify_signature(
    secret: str,
    body: bytes,
    header: str | None,
    *,
    tolerance: int = DEFAULT_TOLERANCE_SECONDS,
    now: float | None = None,
) -> None:
    """Raise :class:`SignatureInvalid` unless ``header`` is Korsi's signature of ``body``.

    More than one ``v1`` is accepted, and any one matching passes: the shape a signing secret's
    rotation takes, when Korsi signs with the old secret and the new one for a while.
    """
    if not header:
        msg = "missing Korsi-Signature"
        raise SignatureInvalid(msg)
    stamp = ""
    digests: list[str] = []
    for part in header.split(","):
        key, _, value = part.strip().partition("=")
        if key == "t":
            stamp = value
        elif key == "v1" and value:
            digests.append(value)
    current = now if now is not None else time.time()
    if not stamp.isdigit() or abs(current - int(stamp)) > tolerance:
        msg = "stale or malformed signature"
        raise SignatureInvalid(msg)
    expected = _digest(secret, stamp, body)
    # Every candidate is compared, in constant time, so the time taken says nothing about which.
    matched = False
    for digest in digests:
        matched |= hmac.compare_digest(expected, digest)
    if not matched:
        msg = "signature does not match"
        raise SignatureInvalid(msg)
