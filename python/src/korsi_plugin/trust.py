"""Which Korsi a plugin believes: the address an ``installed`` message names.

``installed`` is signed with the secret it carries, so anybody can send one. The plugin confirms the
credential by calling the address in it (``GET {api_base}/installation``) -- and that call is the
risk: an address the sender chose, fetched from the plugin's network. So the address must look like
a Korsi plugin plane before it is called at all:

* ``https``, except on this machine (``localhost``, ``127.0.0.1``, ``[::1]``, ``*.localhost``), or
  anywhere when the plugin allows plain ``http`` for development;
* no user, no query, no fragment, and a path ending in ``/plugin/v1``;
* when the plugin names the Korsis it serves (``trusted_api_bases``), one of them. A pattern may
  start its host with ``*.``: ``https://*.korsi.ai/plugin/v1`` is every organization on korsi.ai.

A plugin listed in a public catalogue can be installed by any Korsi and may leave the list out;
every other plugin should give it -- it also stops a stranger who learned an installation id from
claiming it first with an address of their own.
"""

from __future__ import annotations

from collections.abc import Iterable
from urllib.parse import SplitResult, urlsplit

PLANE_PATH = "/plugin/v1"
_LOOPBACK = frozenset({"localhost", "127.0.0.1", "::1"})


def _parts(address: str) -> SplitResult | None:
    try:
        parts = urlsplit(address.strip())
        _ = parts.port  # raises on a malformed port
    except ValueError:
        return None
    return parts


def _host_matches(host: str, pattern: str) -> bool:
    if pattern.startswith("*."):
        suffix = pattern[1:]
        return host.endswith(suffix) and len(host) > len(suffix)
    return host == pattern


def api_base_problem(
    api_base: str, trusted: Iterable[str] | None = None, *, allow_http: bool = False
) -> str | None:
    """Why ``api_base`` is not a plane this plugin may call, or ``None`` when it is."""
    parts = _parts(api_base)
    if parts is None or not parts.hostname:
        return f"{api_base!r} is not an address"
    host = parts.hostname.lower()
    local = host in _LOOPBACK or host.endswith(".localhost")
    if parts.scheme != "https" and not (parts.scheme == "http" and (local or allow_http)):
        return f"{api_base} is not https"
    if parts.username or parts.password or parts.query or parts.fragment:
        return f"{api_base} carries a user, a query or a fragment"
    if parts.path.rstrip("/") != PLANE_PATH and not parts.path.rstrip("/").endswith(PLANE_PATH):
        return f"{api_base} is not a plugin plane (…{PLANE_PATH})"
    if trusted is None:
        return None
    for pattern in trusted:
        wanted = _parts(pattern.replace("*.", "wildcard-placeholder.", 1))
        if wanted is None or not wanted.hostname:
            continue
        wanted_host = wanted.hostname.lower().replace("wildcard-placeholder.", "*.", 1)
        if (
            wanted.scheme == parts.scheme
            and wanted.port == parts.port
            and wanted.path.rstrip("/") == parts.path.rstrip("/")
            and _host_matches(host, wanted_host)
        ):
            return None
    return f"{api_base} is not a Korsi this plugin accepts installations from"
