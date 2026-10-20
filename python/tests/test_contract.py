"""The SDK against Korsi's own contract: every route of the plane, and types that are current."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from korsi_plugin import ROUTES, KorsiClient

ROOT = Path(__file__).resolve().parents[2]
DOCUMENT = json.loads((ROOT / "openapi" / "plugin-v1.json").read_text(encoding="utf-8"))
PREFIX = "/plugin/v1"


def test_every_route_of_the_plane_has_a_method_and_nothing_else_does() -> None:
    routes = {
        (method.upper(), path.removeprefix(PREFIX))
        for path, operations in DOCUMENT["paths"].items()
        for method in operations
    }
    assert set(ROUTES) == routes
    for name in ROUTES.values():
        assert callable(getattr(KorsiClient, name)), name


def test_the_generated_types_are_what_the_document_says() -> None:
    result = subprocess.run(  # noqa: S603 - our own script, a fixed argument list
        [sys.executable, str(ROOT / "scripts" / "generate_models.py"), "--check"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
