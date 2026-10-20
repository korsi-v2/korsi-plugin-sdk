"""The plugin plane, through the client: the shapes Korsi answers, and what it refuses."""

from __future__ import annotations

from decimal import Decimal

import httpx
import pytest

from korsi_plugin import (
    Code,
    KorsiClient,
    KorsiRefused,
    KorsiUnreachable,
    Wallet,
    is_rate_limited,
    is_wallet_insufficient,
)
from tests.fake_korsi import ANA, API_BASE, HANDLE, INSTALLATION, TOKEN, FakeKorsi, transport


@pytest.fixture
def korsi() -> FakeKorsi:
    return FakeKorsi()


def client(korsi: FakeKorsi, bearer: str = TOKEN) -> KorsiClient:
    return KorsiClient(API_BASE, bearer, transport=transport(korsi))


async def test_whoami_reads_ids_as_uuids_and_the_version_header(korsi: FakeKorsi) -> None:
    async with client(korsi, HANDLE) as plane:
        me = await plane.whoami()
        assert plane.plugin_api == "1.0"
    assert me.installation_id == INSTALLATION
    assert me.user_id == ANA
    assert me.is_person
    assert me.scopes == ("records.own",)
    assert me.settings == {"x": 1}


async def test_the_installation_itself_is_not_a_person(korsi: FakeKorsi) -> None:
    async with client(korsi) as plane:
        me = await plane.whoami()
    assert me.authority == "installation"
    assert not me.is_person


async def test_people_leaves_out_the_inactive_unless_asked(korsi: FakeKorsi) -> None:
    async with client(korsi) as plane:
        assert [person["label"] for person in await plane.people()] == ["Ana"]
        assert len(await plane.people(include_inactive=True)) == 2


async def test_a_refusal_carries_korsis_problem(korsi: FakeKorsi) -> None:
    async with client(korsi, "nobody") as plane:
        with pytest.raises(KorsiRefused) as raised:
            await plane.whoami()
    assert raised.value.status == 401
    assert raised.value.code == Code.UNAUTHENTICATED
    assert raised.value.request_id == "req-1"


async def test_a_spent_budget_says_when_to_ask_again(korsi: FakeKorsi) -> None:
    async with client(korsi) as plane:
        with pytest.raises(KorsiRefused) as raised:
            await plane.proposals()
    assert (raised.value.status, raised.value.code) == (429, Code.PLUGIN_RATE_LIMITED)
    assert raised.value.retry_after == 7
    assert is_rate_limited(raised.value)
    assert not is_rate_limited(RuntimeError())


async def test_a_gateway_page_is_unreachable_not_refused(korsi: FakeKorsi) -> None:
    async with client(korsi) as plane:
        with pytest.raises(KorsiUnreachable):
            await plane._call("GET", "/boom")


async def test_a_network_failure_is_unreachable() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    async with KorsiClient(API_BASE, TOKEN, transport=httpx.MockTransport(down)) as plane:
        with pytest.raises(KorsiUnreachable):
            await plane.wallet()


async def test_a_missing_record_is_none_and_ids_travel_quoted(korsi: FakeKorsi) -> None:
    async with client(korsi) as plane:
        assert await plane.record("thread", "a/b c") is None
        written = await plane.put_record(
            "thread", "a/b c", {"subject": "x"}, owner_user_id=ANA, expected_version=3
        )
        assert written["external_id"] == "a%2Fb%20c"
        assert await plane.record("thread", "a/b c") is not None
        await plane.delete_record("thread", "a/b c")
        assert await plane.record("thread", "a/b c") is None
    put = next(call for call in korsi.calls if call[0] == "PUT")
    assert put[2] == {"data": {"subject": "x"}, "owner_user_id": str(ANA), "expected_version": 3}


async def test_iter_records_follows_the_cursor(korsi: FakeKorsi) -> None:
    async with client(korsi) as plane:
        for n in range(5):
            await plane.put_record("thread", f"t{n}", {"n": n})
        seen = [record["external_id"] async for record in plane.iter_records("thread", page_size=2)]
    assert seen == ["t0", "t1", "t2", "t3", "t4"]


async def test_iter_events_reads_the_stream_to_its_end(korsi: FakeKorsi) -> None:
    async with client(korsi) as plane:
        events = [event["sequence"] async for event in plane.iter_events(after=1, page_size=2)]
    assert events == [2, 3, 4, 5]


async def test_consume_sends_an_exact_quantity(korsi: FakeKorsi) -> None:
    async with client(korsi) as plane:
        hold = await plane.consume(
            "message.read", Decimal("1.5"), idempotency_key="k", reference="r"
        )
    assert hold["status"] == "settled"
    assert korsi.calls[-1][2]["quantity"] == "1.5"


async def test_an_empty_wallet_is_told_by_code(korsi: FakeKorsi) -> None:
    async with client(korsi) as plane:
        with pytest.raises(KorsiRefused) as raised:
            await plane.consume("message.read", 1000, idempotency_key="k", reference="r")
    assert raised.value.status == 402
    assert is_wallet_insufficient(raised.value)


async def test_a_reservation_settles_what_was_used(korsi: FakeKorsi) -> None:
    plane = client(korsi)
    async with plane, plane.reserve("pages.ocr", 10, idempotency_key="k", reference="doc") as hold:
        hold.use(4)
    assert hold.hold is not None
    assert hold.hold["status"] == "settled"
    assert hold.hold["quantity"] == "4"


async def test_a_reservation_is_released_when_the_service_fails(korsi: FakeKorsi) -> None:
    async with client(korsi) as plane:
        with pytest.raises(RuntimeError):
            async with plane.reserve("pages.ocr", 10, idempotency_key="k", reference="doc") as hold:
                raise RuntimeError("ocr failed")
    assert hold.hold is not None
    assert hold.hold["status"] == "released"


async def test_the_wallet_reads_exactly(korsi: FakeKorsi) -> None:
    async with client(korsi) as plane:
        wallet = Wallet.of(await plane.wallet())
    assert wallet.available == Decimal("10")
    assert wallet.balance == Decimal("10.5")
    assert wallet.has_plan
    assert wallet.covers("9.99")
    assert not wallet.covers(11)
    assert wallet.period_ends_at is not None


async def test_a_shared_pool_is_not_closed_by_a_client() -> None:
    async with httpx.AsyncClient(transport=transport(FakeKorsi())) as http:
        async with KorsiClient(API_BASE, TOKEN, http=http) as plane:
            await plane.whoami()
        assert not http.is_closed
