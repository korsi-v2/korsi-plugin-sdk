"""Korsi's signature: what makes a call Korsi's and not anybody's."""

from __future__ import annotations

import pytest

from korsi_plugin import RequestRejected, SignatureInvalid, sign, verify_signature

SECRET = "s3cret"
BODY = b'{"topic":"plugin.proposal.settled"}'


def test_korsis_own_signature_passes() -> None:
    verify_signature(SECRET, BODY, sign(SECRET, BODY, now=1000), now=1010)


def test_the_scheme_is_hmac_of_stamp_dot_body() -> None:
    # HMAC-SHA256("k", "1.{}"), pinned; the TypeScript SDK's tests pin the same value.
    assert sign("k", b"{}", now=1) == (
        "t=1,v1=3dd49b2593d0f9a349e9e71c4bde3e2b862c2be4003fe9b4ba81332029310158"
    )


def test_another_body_fails() -> None:
    with pytest.raises(SignatureInvalid, match="match"):
        verify_signature(SECRET, BODY + b" ", sign(SECRET, BODY, now=1000), now=1010)


def test_another_secret_fails() -> None:
    with pytest.raises(SignatureInvalid):
        verify_signature("other", BODY, sign(SECRET, BODY, now=1000), now=1010)


def test_an_old_signature_is_a_replay() -> None:
    with pytest.raises(SignatureInvalid, match="stale"):
        verify_signature(SECRET, BODY, sign(SECRET, BODY, now=1000), now=1000 + 301)


def test_a_signature_from_the_future_is_refused_too() -> None:
    with pytest.raises(SignatureInvalid, match="stale"):
        verify_signature(SECRET, BODY, sign(SECRET, BODY, now=2000), now=1000)


def test_no_signature_fails_and_answers_401() -> None:
    with pytest.raises(SignatureInvalid, match="missing") as raised:
        verify_signature(SECRET, BODY, None)
    assert isinstance(raised.value, RequestRejected)
    assert raised.value.status == 401


@pytest.mark.parametrize("header", ["garbage", "t=abc,v1=00", "v1=00", "t=1000"])
def test_malformed_headers_fail(header: str) -> None:
    with pytest.raises(SignatureInvalid):
        verify_signature(SECRET, BODY, header, now=1000)


def test_any_one_of_several_v1_passes_for_a_rotation() -> None:
    old = sign("old-secret", BODY, now=1000).split(",")[1]
    new = sign(SECRET, BODY, now=1000)
    verify_signature(SECRET, BODY, f"{new},{old}", now=1000)
    verify_signature("old-secret", BODY, f"{new},{old}", now=1000)
