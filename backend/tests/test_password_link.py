"""Regression tests for the Google-only -> Set Password (OTP) linking flow.

The feature links a password credential to an EXISTING Firebase account so the
Firebase UID never changes: Google login and email/password login resolve to the
same UID. These tests run without a live Firebase (firebase_service is mocked)
and cover provider detection, the OTP lifecycle (single-use, expiry, resend,
never logged/returned), password validation, same-UID linking, and the
no-duplicate-account guarantee.
"""

import logging
import uuid

import pytest

from app.models import EmailOTP
from app.models.models import utc_now_ms
from app.routes.auth import _compute_otp_hash
from tests.conftest_helpers import TestingSessionLocal

EMAIL = "alice@example.com"
UID_A = "uid-google-alice"


@pytest.fixture
def mock_firebase(monkeypatch):
    """Mock the Firebase Admin wrapper used by the auth routes.

    get_user_by_email is configured per-test; update_user_password records its
    calls; create_user fails loudly so the tests prove it is never invoked for
    an existing account (no duplicate Firebase UID is ever created).
    """
    from app.services import firebase_service

    state = {
        "user": None,
        "update_user_password": [],
        "create_user_calls": 0,
    }

    def _get_user_by_email(email):
        return state["user"]

    def _update_user_password(uid, password):
        state["update_user_password"].append((uid, password))

    def _create_user(**kwargs):
        state["create_user_calls"] += 1
        raise AssertionError("create_user must never run for an existing account")

    monkeypatch.setattr(firebase_service, "get_user_by_email", _get_user_by_email)
    monkeypatch.setattr(firebase_service, "update_user_password", _update_user_password)

    import firebase_admin.auth

    monkeypatch.setattr(firebase_admin.auth, "create_user", _create_user)

    return state


@pytest.fixture
def fixed_otp(monkeypatch):
    """Force OTP generation to a deterministic code ("555555")."""
    import app.routes.auth as auth_module

    monkeypatch.setattr(auth_module.secrets, "choice", lambda seq: "5")
    return "555555"


def _insert_otp(db, email, code="123456", *, expires_at=None, used=False, attempts=0):
    now = utc_now_ms()
    record = EmailOTP(
        id=str(uuid.uuid4()),
        email=email.lower().strip(),
        otp_hash=_compute_otp_hash(code, email),
        purpose="link_password",
        expires_at=expires_at if expires_at is not None else now + 10 * 60 * 1000,
        attempts=attempts,
        max_attempts=3,
        resend_available_at=0,
        used=used,
        created_at=now,
    )
    db.add(record)
    db.commit()
    return record


def _google_only_user():
    return {
        "uid": UID_A,
        "email": EMAIL,
        "display_name": "Alice",
        "provider_ids": ["google.com"],
    }


def _google_and_password_user():
    return {
        "uid": UID_A,
        "email": EMAIL,
        "display_name": "Alice",
        "provider_ids": ["google.com", "password"],
    }


# ------------------------------------------------------------- detection


def test_user_status_detects_google_only_account(client, mock_firebase):
    mock_firebase["user"] = _google_only_user()
    res = client.post("/auth/user-status", json={"email": EMAIL})
    assert res.status_code == 200
    assert res.json() == {
        "exists": True,
        "providers": ["google.com"],
        "has_password": False,
    }


def test_user_status_normal_password_account(client, mock_firebase):
    mock_firebase["user"] = {
        "uid": "u2",
        "email": EMAIL,
        "display_name": "Alice",
        "provider_ids": ["password"],
    }
    body = client.post("/auth/user-status", json={"email": EMAIL}).json()
    assert body["exists"] is True
    assert body["has_password"] is True
    assert "google.com" not in body["providers"]


def test_user_status_google_and_password_account(client, mock_firebase):
    mock_firebase["user"] = _google_and_password_user()
    body = client.post("/auth/user-status", json={"email": EMAIL}).json()
    assert body["exists"] is True
    assert body["has_password"] is True
    assert "google.com" in body["providers"]


def test_user_status_nonexistent_email(client, mock_firebase):
    mock_firebase["user"] = None
    body = client.post("/auth/user-status", json={"email": "nobody@example.com"}).json()
    assert body == {"exists": False, "providers": [], "has_password": False}


def test_user_status_does_not_leak_uid_or_credentials(client, mock_firebase):
    mock_firebase["user"] = _google_only_user()
    res = client.post("/auth/user-status", json={"email": EMAIL})
    assert set(res.json().keys()) == {"exists", "providers", "has_password"}
    assert UID_A not in res.text


# ------------------------------------------------------------- OTP lifecycle


def test_otp_sent_stores_hash_and_never_returns_code(client, fixed_otp):
    res = client.post("/auth/otp/send", json={"email": EMAIL})
    assert res.status_code == 200
    assert "555555" not in res.text

    db = TestingSessionLocal()
    try:
        record = db.query(EmailOTP).filter(EmailOTP.email == EMAIL).first()
    finally:
        db.close()
    assert record is not None
    assert record.purpose == "link_password"
    assert record.used is False
    assert record.attempts == 0
    assert record.expires_at > utc_now_ms()
    # Only a salted hash is persisted, never the plaintext code.
    assert record.otp_hash != "555555"
    assert "555555" not in record.otp_hash


def test_otp_never_logged(client, caplog, fixed_otp):
    with caplog.at_level(logging.INFO):
        res = client.post("/auth/otp/send", json={"email": EMAIL})
    assert res.status_code == 200
    assert "555555" not in caplog.text
    assert "555555" not in res.text


def test_correct_otp_accepted(client, fixed_otp):
    client.post("/auth/otp/send", json={"email": EMAIL})
    res = client.post("/auth/otp/verify", json={"email": EMAIL, "otp": "555555"})
    assert res.status_code == 200
    body = res.json()
    assert body["verified"] is True
    assert body["verification_token"]


def test_wrong_otp_rejected(client, fixed_otp):
    client.post("/auth/otp/send", json={"email": EMAIL})
    res = client.post("/auth/otp/verify", json={"email": EMAIL, "otp": "000000"})
    assert res.status_code == 400
    assert "Invalid verification code" in res.json()["detail"]


def test_expired_otp_rejected(client):
    db = TestingSessionLocal()
    try:
        _insert_otp(db, EMAIL, code="123456", expires_at=utc_now_ms() - 1000)
    finally:
        db.close()
    res = client.post("/auth/otp/verify", json={"email": EMAIL, "otp": "123456"})
    assert res.status_code == 400
    assert "expired" in res.json()["detail"].lower()


def test_used_otp_rejected(client):
    db = TestingSessionLocal()
    try:
        _insert_otp(db, EMAIL, code="123456", used=True)
    finally:
        db.close()
    res = client.post("/auth/otp/verify", json={"email": EMAIL, "otp": "123456"})
    assert res.status_code == 400


def test_otp_is_single_use(client, fixed_otp):
    client.post("/auth/otp/send", json={"email": EMAIL})
    first = client.post("/auth/otp/verify", json={"email": EMAIL, "otp": "555555"})
    assert first.status_code == 200
    second = client.post("/auth/otp/verify", json={"email": EMAIL, "otp": "555555"})
    assert second.status_code == 400


def test_otp_resend_cooldown(client, fixed_otp):
    client.post("/auth/otp/send", json={"email": EMAIL})
    res = client.post("/auth/otp/send", json={"email": EMAIL})
    assert res.status_code == 429
    assert "Please wait" in res.json()["detail"]


# ------------------------------------------------------------- set password


def test_set_password_links_to_existing_uid(client, mock_firebase, fixed_otp):
    mock_firebase["user"] = _google_only_user()
    client.post("/auth/otp/send", json={"email": EMAIL})
    token = client.post(
        "/auth/otp/verify", json={"email": EMAIL, "otp": "555555"}
    ).json()["verification_token"]

    res = client.post(
        "/auth/set-password",
        json={"email": EMAIL, "verification_token": token, "password": "new-secret-1"},
    )
    assert res.status_code == 200
    # The password is linked onto the EXISTING UID; a new account is never made.
    assert mock_firebase["update_user_password"] == [(UID_A, "new-secret-1")]
    assert mock_firebase["create_user_calls"] == 0


def test_set_password_never_creates_duplicate_account(client, mock_firebase, fixed_otp):
    mock_firebase["user"] = _google_and_password_user()
    client.post("/auth/otp/send", json={"email": EMAIL})
    token = client.post(
        "/auth/otp/verify", json={"email": EMAIL, "otp": "555555"}
    ).json()["verification_token"]

    res = client.post(
        "/auth/set-password",
        json={"email": EMAIL, "verification_token": token, "password": "another-secret"},
    )
    assert res.status_code == 200
    assert mock_firebase["update_user_password"][0][0] == UID_A
    assert mock_firebase["create_user_calls"] == 0


def test_set_password_rejects_invalid_verification_token(client, mock_firebase):
    mock_firebase["user"] = _google_only_user()
    res = client.post(
        "/auth/set-password",
        json={"email": EMAIL, "verification_token": "garbage", "password": "validpass1"},
    )
    assert res.status_code == 401
    assert mock_firebase["update_user_password"] == []


def test_set_password_rejects_token_issued_for_another_email(client, mock_firebase, fixed_otp):
    mock_firebase["user"] = _google_only_user()
    client.post("/auth/otp/send", json={"email": EMAIL})
    token = client.post(
        "/auth/otp/verify", json={"email": EMAIL, "otp": "555555"}
    ).json()["verification_token"]

    res = client.post(
        "/auth/set-password",
        json={
            "email": "mallory@example.com",
            "verification_token": token,
            "password": "validpass1",
        },
    )
    assert res.status_code == 401
    assert mock_firebase["update_user_password"] == []


def test_set_password_rejects_short_password(client, mock_firebase):
    res = client.post(
        "/auth/set-password",
        json={"email": EMAIL, "verification_token": "x", "password": "123"},
    )
    assert res.status_code == 422


def test_critical_flow_google_to_password_keeps_same_uid(client, mock_firebase, fixed_otp):
    """End-to-end regression for the critical scenario:

    Google login -> UID A -> logout -> Set Password via OTP -> email/password
    login still resolves to UID A, and Google login still resolves to UID A.

    Backend-side this is verified by asserting the password is linked onto the
    existing UID (update_user_password) and that no new account (UID B) is ever
    created.
    """
    mock_firebase["user"] = _google_only_user()

    # 1. Google-only account detected.
    status = client.post("/auth/user-status", json={"email": EMAIL}).json()
    assert status["exists"] is True
    assert status["has_password"] is False
    assert "google.com" in status["providers"]

    # 2. OTP sent and verified.
    assert client.post("/auth/otp/send", json={"email": EMAIL}).status_code == 200
    token = client.post(
        "/auth/otp/verify", json={"email": EMAIL, "otp": "555555"}
    ).json()["verification_token"]

    # 3. Password linked to the EXISTING UID A - never a new UID B.
    res = client.post(
        "/auth/set-password",
        json={"email": EMAIL, "verification_token": token, "password": "critical-pass"},
    )
    assert res.status_code == 200
    assert mock_firebase["update_user_password"] == [(UID_A, "critical-pass")]
    assert mock_firebase["create_user_calls"] == 0

    # 4. After linking the account has both providers but the SAME UID A, so
    #    email/password and Google logins resolve to the same identity.
    mock_firebase["user"] = _google_and_password_user()
    after = client.post("/auth/user-status", json={"email": EMAIL}).json()
    assert after["has_password"] is True
    assert mock_firebase["user"]["uid"] == UID_A
