"""Routes Korsi adds reach the client by generation alone.

``openapi/testdata/org-api.patch.json`` holds routes in FastAPI's shape -- pages, a path id, a
query named ``from``, a boolean, a body -- merged into the plane's real document. The generated
module must type-check, and on the real :class:`KorsiClient` its methods must call Korsi the way
the routes say.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from typing import Any

import httpx
import pytest

from korsi_plugin import KorsiClient

ROOT = Path(__file__).resolve().parents[2]
GENERATOR = ROOT / "scripts" / "generate_models.py"
CASE = uuid.UUID("cccccccc-cccc-4ccc-8ccc-cccccccccccc")


def merged_document(**changes: Any) -> dict[str, Any]:
    document: dict[str, Any] = json.loads(
        (ROOT / "openapi" / "plugin-v1.json").read_text(encoding="utf-8")
    )
    patch = json.loads(
        (ROOT / "openapi" / "testdata" / "org-api.patch.json").read_text(encoding="utf-8")
    )
    document["paths"].update(patch["paths"])
    document["components"]["schemas"].update(patch["schemas"])
    for path, value in changes.items():
        if value is None:
            document["paths"].pop(path)
        else:
            document["paths"][path] = value
    return document


def generate(tmp_path: Path, document: dict[str, Any]) -> subprocess.CompletedProcess[str]:
    source = tmp_path / "document.json"
    source.write_text(json.dumps(document), encoding="utf-8")
    package = tmp_path / "plane_next"
    package.mkdir(exist_ok=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    return subprocess.run(  # noqa: S603 - our own script, fixed arguments
        [
            sys.executable,
            str(GENERATOR),
            "--document",
            str(source),
            "--python-out",
            str(package),
            "--ts-out",
            str(tmp_path / "ts"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.fixture
def operations(tmp_path: Path) -> Iterator[ModuleType]:
    result = generate(tmp_path, merged_document())
    assert result.returncode == 0, result.stderr
    spec = importlib.util.spec_from_file_location(
        "plane_next", tmp_path / "plane_next" / "__init__.py"
    )
    assert spec and spec.loader
    package = importlib.util.module_from_spec(spec)
    sys.modules["plane_next"] = package
    spec.loader.exec_module(package)
    module = importlib.import_module("plane_next.operations")
    yield module
    for name in [name for name in sys.modules if name.startswith("plane_next")]:
        del sys.modules[name]


class FakeOrgApi:
    """Korsi answering the patch's routes, recording each request."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path.removeprefix("/plugin/v1")
        if path == "/cases":
            cursor = request.url.params.get("cursor")
            if cursor is None:
                return httpx.Response(200, json={"items": [{"id": "1"}], "next_cursor": "p2"})
            return httpx.Response(200, json={"items": [{"id": "2"}], "next_cursor": None})
        if path == f"/cases/{CASE}":
            return httpx.Response(200, json={"id": str(CASE), "title": "x", "status": "open"})
        if path == "/calendar":
            return httpx.Response(200, json={"items": []})
        if path == "/memory/search":
            return httpx.Response(200, json={"items": [{"text": "found", "score": 0.9}]})
        return httpx.Response(404)


def test_the_generated_module_type_checks(tmp_path: Path) -> None:
    result = generate(tmp_path, merged_document())
    assert result.returncode == 0, result.stderr
    checked = subprocess.run(
        [sys.executable, "-m", "mypy", "--strict", "--no-incremental", "plane_next"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
    )
    assert checked.returncode == 0, checked.stdout


async def test_new_routes_are_methods_of_the_client(operations: ModuleType) -> None:
    korsi = FakeOrgApi()
    client_class = type("NextClient", (operations.PlaneOperations, KorsiClient), {})
    client: Any = client_class(
        "https://korsi.test/plugin/v1", "token", transport=httpx.MockTransport(korsi)
    )
    async with client:
        since = datetime(2026, 10, 1, tzinfo=UTC)
        cases = [case["id"] async for case in client.iter_cases(status="open", updated_since=since)]
        assert cases == ["1", "2"]
        assert (await client.get_case(CASE))["status"] == "open"
        await client.calendar(from_=since, to="2026-10-31T00:00:00Z", include_declined=True)
        hits = await client.search_memory({"query": "contract"})
        assert hits["items"][0]["text"] == "found"

    first, second, case, calendar, search = korsi.requests
    assert first.url.params.get("status") == "open"
    assert first.url.params.get("updated_since") == "2026-10-01T00:00:00+00:00"
    assert "cursor" not in first.url.params
    assert second.url.params.get("cursor") == "p2"
    assert case.url.path == f"/plugin/v1/cases/{CASE}"
    assert calendar.url.params.get("from") == "2026-10-01T00:00:00+00:00"
    assert calendar.url.params.get("include_declined") == "true"
    assert search.method == "POST"
    assert json.loads(search.content) == {"query": "contract"}
    assert operations.ROUTES[("GET", "/cases/{case_id}/activity")] == "case_activity"
    assert operations.ROUTES[("GET", "/installation")] == "whoami"


def test_a_name_the_client_already_has_is_refused(tmp_path: Path) -> None:
    taken = merged_document()["paths"]["/plugin/v1/cases"]["get"] | {
        "operationId": "reserve_plugin_v1_reserve_get"
    }
    result = generate(tmp_path, merged_document(**{"/plugin/v1/reserve": {"get": taken}}))
    assert result.returncode == 2
    assert "reserve() is taken" in result.stderr or "is taken" in result.stderr


def test_a_hand_written_route_korsi_dropped_is_refused(tmp_path: Path) -> None:
    result = generate(tmp_path, merged_document(**{"/plugin/v1/wallet": None}))
    assert result.returncode == 2
    assert "GET /wallet" in result.stderr
