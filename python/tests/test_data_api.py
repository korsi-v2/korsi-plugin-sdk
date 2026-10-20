"""The organization's data (ADR-0062), through the methods generated from Korsi's document.

Nothing here was written by hand in the client: these are the generated ``list_cases``,
``iter_cases``, ``read_calendar`` and ``search_memory``, called the way a plugin calls them.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import httpx

from korsi_plugin import ROUTES, KorsiClient


async def test_the_data_api_is_generated_methods_of_the_client() -> None:
    requests: list[httpx.Request] = []

    def korsi(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path.removeprefix("/plugin/v1")
        if path == "/cases":
            last = request.url.params.get("cursor") == "p2"
            return httpx.Response(
                200,
                json={
                    "items": [{"id": "2" if last else "1"}],
                    "next_cursor": None if last else "p2",
                },
            )
        if path == "/calendar":
            return httpx.Response(200, json={"items": [], "window_start": "x", "window_end": "y"})
        if path == "/memory/search":
            return httpx.Response(200, json={"answer": "…"})
        return httpx.Response(404)

    async with KorsiClient(
        "https://korsi.test/plugin/v1", "kph_ana", transport=httpx.MockTransport(korsi)
    ) as client:
        cases = [case["id"] async for case in client.iter_cases(status=["open", "draft"], limit=50)]
        await client.read_calendar(
            start=datetime(2026, 10, 1, tzinfo=UTC), end=datetime(2026, 11, 1, tzinfo=UTC)
        )
        await client.search_memory({"query": "the support contract"})

    assert cases == ["1", "2"]
    first, second, calendar, search = requests
    assert first.url.params.get_list("status") == ["open", "draft"]
    assert first.url.params.get("limit") == "50"
    assert second.url.params.get("cursor") == "p2"
    assert calendar.url.params.get("start") == "2026-10-01T00:00:00+00:00"
    assert (search.method, json.loads(search.content)) == (
        "POST",
        {"query": "the support contract"},
    )


def test_every_data_route_has_its_method() -> None:
    expected = {
        ("GET", "/org"): "get_organization",
        ("GET", "/org/people"): "list_organization_people",
        ("GET", "/cases"): "list_cases",
        ("GET", "/cases/{case_id}"): "get_case",
        ("GET", "/cases/{case_id}/activity"): "list_case_activity",
        ("GET", "/actions"): "list_actions",
        ("GET", "/actions/{action_id}"): "get_action",
        ("GET", "/decisions"): "list_decisions",
        ("GET", "/decisions/{decision_id}"): "get_decision",
        ("GET", "/meetings"): "list_meetings",
        ("GET", "/meetings/{meeting_id}"): "get_meeting",
        ("GET", "/meetings/{meeting_id}/transcript"): "get_meeting_transcript",
        ("GET", "/documents"): "list_documents",
        ("GET", "/documents/{document_id}"): "get_document",
        ("GET", "/documents/{document_id}/text"): "get_document_text",
        ("GET", "/calendar"): "read_calendar",
        ("POST", "/memory/search"): "search_memory",
    }
    for route, name in expected.items():
        assert ROUTES[route] == name
        assert callable(getattr(KorsiClient, name))
