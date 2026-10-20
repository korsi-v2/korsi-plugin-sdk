"""Which addresses an ``installed`` message may make the plugin call."""

from __future__ import annotations

import pytest

from korsi_plugin import api_base_problem


@pytest.mark.parametrize(
    "api_base",
    [
        "https://acme.korsi.ai/plugin/v1",
        "https://acme.korsi.ai/plugin/v1/",
        "https://korsi.example/base/plugin/v1",
        "http://localhost:8000/plugin/v1",
        "http://127.0.0.1:8000/plugin/v1",
        "http://api.korsi.localhost/plugin/v1",
    ],
)
def test_a_plane_is_accepted(api_base: str) -> None:
    assert api_base_problem(api_base) is None


@pytest.mark.parametrize(
    ("api_base", "why"),
    [
        ("http://10.0.0.5/plugin/v1", "https"),
        ("https://evil.test/plugin/v1?x=/admin", "query"),
        ("https://user:pass@evil.test/plugin/v1", "user"),
        ("https://evil.test/admin", "plugin plane"),
        ("not a url", "not an address"),
        ("https://evil.test:99999/plugin/v1", "not an address"),
    ],
)
def test_anything_else_is_not_called(api_base: str, why: str) -> None:
    problem = api_base_problem(api_base)
    assert problem is not None
    assert why in problem


def test_plain_http_beyond_this_machine_only_when_allowed() -> None:
    assert api_base_problem("http://10.0.0.5:8000/plugin/v1", allow_http=True) is None


def test_trusted_korsis_by_name_or_pattern() -> None:
    trusted = ["https://*.korsi.ai/plugin/v1", "https://korsi.acme.ir/plugin/v1/"]
    assert api_base_problem("https://acme.korsi.ai/plugin/v1", trusted) is None
    assert api_base_problem("https://a.b.korsi.ai/plugin/v1", trusted) is None
    assert api_base_problem("https://korsi.acme.ir/plugin/v1", trusted) is None
    assert api_base_problem("https://korsi.ai/plugin/v1", trusted) is not None
    assert api_base_problem("https://evilkorsi.ai/plugin/v1", trusted) is not None
    assert api_base_problem("https://acme.korsi.ai:8443/plugin/v1", trusted) is not None
