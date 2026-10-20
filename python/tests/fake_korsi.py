"""A Korsi plugin plane, faked: it answers the way Korsi does, and records what it was asked.

Bearers are what Korsi would see: the installation's token, a person's handle, or something it
refuses with a problem document -- the same shape as Korsi's, so the client's error path is the
real one.
"""

from __future__ import annotations

import json
import uuid
from decimal import Decimal
from typing import Any

import httpx

INSTALLATION = uuid.UUID("11111111-1111-4111-8111-111111111111")
OTHER_INSTALLATION = uuid.UUID("22222222-2222-4222-8222-222222222222")
ANA = uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
BEN = uuid.UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
TOKEN = "machine-token"
HANDLE = "kph_ana"
FOREIGN_HANDLE = "kph_foreign"
SECRET = "signing-secret"
API_BASE = "https://korsi.test/plugin/v1"


def problem(
    status: int, code: str, *, headers: dict[str, str] | None = None, **params: Any
) -> httpx.Response:
    return httpx.Response(
        status,
        json={
            "type": "about:blank",
            "title": code,
            "status": status,
            "code": code,
            "params": params,
            "request_id": "req-1",
        },
        headers={"content-type": "application/problem+json", **(headers or {})},
    )


class FakeKorsi:
    def __init__(self) -> None:
        #: What the installation's token is answered with: None works; a response refuses.
        self.token_answer: httpx.Response | None = None
        self.calls: list[tuple[str, str, Any]] = []
        self.records: dict[str, dict[str, Any]] = {}
        self.holds: dict[str, dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = [
            {
                "sequence": n,
                "id": str(uuid.UUID(int=n)),
                "topic": "plugin.wallet.low",
                "subject_id": None,
                "data": {},
                "occurred_at": "2026-10-20T10:00:00+00:00",
            }
            for n in range(1, 6)
        ]

    def count(self, method: str, path: str) -> int:
        return sum(1 for call in self.calls if call[0] == method and call[1] == path)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        bearer = request.headers.get("authorization", "").removeprefix("Bearer ")
        path = request.url.path.removeprefix("/plugin/v1")
        body: Any = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path, body))
        if bearer == TOKEN:
            if self.token_answer is not None:
                return self.token_answer
            who: dict[str, Any] = {
                "installation_id": str(INSTALLATION),
                "authority": "installation",
                "user_id": None,
            }
        elif bearer == HANDLE:
            who = {
                "installation_id": str(INSTALLATION),
                "authority": "delegated",
                "user_id": str(ANA),
            }
        elif bearer == FOREIGN_HANDLE:
            who = {
                "installation_id": str(OTHER_INSTALLATION),
                "authority": "delegated",
                "user_id": str(BEN),
            }
        else:
            return problem(401, "auth.unauthenticated")
        headers = {"korsi-plugin-api": "1.0"}

        if path == "/installation":
            return httpx.Response(
                200,
                headers=headers,
                json={
                    "plugin_id": "ir.acme.sample",
                    "version": "1.2.0",
                    "state": "active",
                    "tenant_ref": "t-1",
                    "scopes": ["records.own"],
                    "settings": {"x": 1},
                    "locale": "fa",
                    "timezone": "Asia/Tehran",
                    **who,
                },
            )
        if path == "/people":
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "user_id": str(ANA),
                            "label": "Ana",
                            "email": "ana@acme.ir",
                            "status": "active",
                            "avatar_url": None,
                        },
                        {
                            "user_id": str(BEN),
                            "label": "Ben",
                            "email": None,
                            "status": "suspended",
                            "avatar_url": None,
                        },
                    ]
                },
            )
        if path.startswith("/records/"):
            return self._records(request, path, body)
        if path == "/wallet":
            return httpx.Response(
                200,
                json={
                    "installation_id": str(INSTALLATION),
                    "plan_key": "pro",
                    "plan_period": "monthly",
                    "period_ends_at": "2026-11-01T00:00:00+00:00",
                    "balance": "10.5000",
                    "reserved": "0.5",
                    "available": "10.0000",
                    "consumed_this_period": "2",
                    "credited_this_period": "12.5",
                },
            )
        if path in ("/wallet/consume", "/wallet/holds"):
            quantity = Decimal(body["quantity"])
            if quantity > 100:
                return problem(402, "plugin.wallet_insufficient")
            hold = {
                "id": str(uuid.uuid4()),
                "service": body["service"],
                "quantity": str(quantity),
                "amount_mu": str(quantity / 2),
                "status": "settled" if path.endswith("consume") else "open",
                "expires_at": "2026-10-20T11:00:00+00:00",
                "reference": body.get("reference"),
            }
            self.holds[hold["id"]] = hold
            return httpx.Response(201 if path.endswith("holds") else 200, json=hold)
        if path.startswith("/wallet/holds/"):
            hold_id, action = path.removeprefix("/wallet/holds/").split("/")
            hold = self.holds[hold_id]
            hold["status"] = "settled" if action == "settle" else "released"
            if action == "settle" and body.get("quantity") is not None:
                hold["quantity"] = body["quantity"]
            return httpx.Response(200, json=hold)
        if path == "/events":
            after = int(request.url.params.get("after", 0))
            limit = int(request.url.params.get("limit", 100))
            page = [event for event in self.events if event["sequence"] > after][:limit]
            return httpx.Response(
                200,
                json={
                    "items": page,
                    "next_after": page[-1]["sequence"] if page else after,
                },
            )
        if path == "/sources":
            return httpx.Response(201, json={"source_id": str(uuid.uuid4()), "created": True})
        if path == "/proposals" and request.method == "POST":
            return httpx.Response(201, json={"id": str(uuid.uuid4()), **body, "status": "pending"})
        if path == "/boom":
            return httpx.Response(502, text="<html>bad gateway</html>")
        if path == "/proposals" and request.method == "GET":
            return problem(429, "plugin.rate_limited", headers={"retry-after": "7"})
        return problem(404, "resource.not_found")

    def _records(self, request: httpx.Request, path: str, body: Any) -> httpx.Response:
        parts = path.removeprefix("/records/").split("/", 1)
        if len(parts) == 1:
            items = sorted(self.records.values(), key=lambda record: record["external_id"])
            cursor = request.url.params.get("cursor")
            start = int(cursor) if cursor else 0
            limit = int(request.url.params.get("limit", 50))
            page = items[start : start + limit]
            following = start + limit
            return httpx.Response(
                200,
                json={
                    "items": page,
                    "next_cursor": str(following) if following < len(items) else None,
                },
            )
        # The raw path, so a test can see the id arrived quoted, as Korsi would read it.
        external_id = request.url.raw_path.decode().rsplit("/", 1)[1]
        if request.method == "GET":
            found = self.records.get(external_id)
            return (
                httpx.Response(200, json=found)
                if found
                else problem(404, "plugin.record_not_found")
            )
        if request.method == "DELETE":
            self.records.pop(external_id, None)
            return httpx.Response(204)
        record = {"external_id": external_id, "type_key": parts[0], "version": 1, **body}
        self.records[external_id] = record
        return httpx.Response(201, json=record)


def transport(korsi: FakeKorsi) -> httpx.MockTransport:
    return httpx.MockTransport(korsi)
