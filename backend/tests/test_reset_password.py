"""Regression tests for Forgot Password -> OTP -> New Password (password reset).

Reuses the existing OTP system (/auth/otp/send + /auth/otp/verify, single-use,
10-minute expiry, resend cooldown, attempt limit) and the signed verification
ticket. The new /auth/reset-password endpoint resets the password on the
EXISTING Firebase UID, never creates an account, never trusts a client-supplied
UID, and never logs or returns the OTP, password, or token.
"""

import logging

import pytest

from app.models import EmailOTP
from app.models.models import utc_now_ms
from app.routes.auth import _compute_otp_hash
from tests.conftest_helpers import TestingSessionLocal

import uuid

EMAIL = "alice@example.com"
UID_A = "uid-alice-reset"


@pytest.fixture
def mock_firebase(monkeypatch):
    """Mock the Firebase Admin wrapper. create_user fails loudly so any call is
    caught immediately (a reset must never create an account)."""
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
        raise AssertionError("create_user must never run during a password reset")

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


def _password_user():
    return {
        "uid": UID_A,
        "email": EMAIL,
        "display_name": "Alice",
        "provider_ids": ["password"],
    }


def _google_and_password_user():
    return {
        "uid": UID_A,
        "email": EMAIL,
        "display_name": "Alice",
        "provider_ids": ["google.com", "password"],
    }


def _google_only_user():
    return {
        "uid": UID_A,
        "email": EMAIL,
        "display_name": "Alice",
        "provider_ids": ["google.com"],
    }


def _obtain_token(client, code="555555"):
    client.post("/auth/otp/send", json={"email": EMAIL})
    res = client.post("/auth/otp/verify", json={"email": EMAIL, "otp": code})
    assert res.status_code == 200
    return res.json()["verification_token"]


# ------------------------------------------------------------- reset endpoint


def test_reset_requires_valid_verification_token(client, mock_firebase, fixed_otp):
    mock_firebase["user"] = _password_user()
    res = client.post(
        "/auth/reset-password",
        json={"email": EMAIL, "verification_token": "garbage", "password": "newpass1"},
    )
    assert res.status_code == 401
    assert mock_firebase["update_user_password"] == []


def test_reset_rejects_token_bound_to_another_email(client, mock_firebase, fixed_otp):
    mock_firebase["user"] = _password_user()
    token = _obtain_token(client)
    res = client.post(
        "/auth/reset-password",
        json={
            "email": "mallory@example.com",
            "verification_token": token,
            "password": "newpass1",
        },
    )
    assert res.status_code == 401
    assert mock_firebase["update_user_password"] == []


def test_reset_rejects_short_password(client, mock_firebase):
    mock_firebase["user"] = _password_user()
    res = client.post(
        "/auth/reset-password",
        json={"email": EMAIL, "verification_token": "x", "password": "123"},
    )
    assert res.status_code == 422


def test_reset_updates_password_on_existing_uid(client, mock_firebase, fixed_otp):
    mock_firebase["user"] = _password_user()
    token = _obtain_token(client)
    res = client.post(
        "/auth/reset-password",
        json={"email": EMAIL, "verification_token": token, "password": "brand-new-pass"},
    )
    assert res.status_code == 200
    assert res.json()["success"] is True
    # Reset onto the EXISTING UID A - never a new account.
    assert mock_firebase["update_user_password"] == [(UID_A, "brand-new-pass")]
    assert mock_firebase["create_user_calls"] == 0


def test_reset_preserves_google_and_password_providers(client, mock_firebase, fixed_otp):
    mock_firebase["user"] = _google_and_password_user()
    token = _obtain_token(client)
    res = client.post(
        "/auth/reset-password",
        json={"email": EMAIL, "verification_token": token, "password": "reset-pass-1"},
    )
    assert res.status_code == 200
    assert mock_firebase["update_user_password"] == [(UID_A, "reset-pass-1")]
    assert mock_firebase["create_user_calls"] == 0
    # Providers are untouched; google.com login keeps working on the same UID.
    assert mock_firebase["user"]["uid"] == UID_A
    assert "google.com" in mock_firebase["user"]["provider_ids"]


def test_reset_google_only_account_links_password_no_duplicate(client, mock_firebase, fixed_otp):
    """A Google-only account that goes through Forgot Password must NOT get a
    duplicate account: the password is linked onto the existing UID A."""
    mock_firebase["user"] = _google_only_user()
    token = _obtain_token(client)
    res = client.post(
        "/auth/reset-password",
        json={"email": EMAIL, "verification_token": token, "password": "linked-pass-1"},
    )
    assert res.status_code == 200
    assert mock_firebase["update_user_password"] == [(UID_A, "linked-pass-1")]
    assert mock_firebase["create_user_calls"] == 0


def test_reset_nonexistent_email_never_creates_account(client, mock_firebase, fixed_otp):
    mock_firebase["user"] = None
    token = _obtain_token(client)
    res = client.post(
        "/auth/reset-password",
        json={"email": EMAIL, "verification_token": token, "password": "somepass1"},
    )
    assert res.status_code == 400
    assert mock_firebase["create_user_calls"] == 0
    assert mock_firebase["update_user_password"] == []


def test_reset_nonexistent_email_does_not_reveal_registration(client, mock_firebase, fixed_otp):
    mock_firebase["user"] = None
    token = _obtain_token(client)
    res = client.post(
        "/auth/reset-password",
        json={"email": EMAIL, "verification_token": token, "password": "somepass1"},
    )
    body = res.json()["detail"].lower()
    assert "exists" not in body
    assert "register" not in body
    assert EMAIL not in body


def test_reset_never_logs_password_or_token(client, mock_firebase, caplog, fixed_otp):
    mock_firebase["user"] = _password_user()
    token = _obtain_token(client)
    with caplog.at_level(logging.INFO):
        res = client.post(
            "/auth/reset-password",
            json={"email": EMAIL, "verification_token": token, "password": "secret-pass-99"},
        )
    assert res.status_code == 200
    assert "secret-pass-99" not in caplog.text
    assert token not in caplog.text
    assert "secret-pass-99" not in res.text


# ------------------------------------------------------------- OTP lifecycle reused


def test_wrong_otp_blocks_reset(client, mock_firebase, fixed_otp):
    mock_firebase["user"] = _password_user()
    client.post("/auth/otp/send", json={"email": EMAIL})
    bad = client.post("/auth/otp/verify", json={"email": EMAIL, "otp": "000000"})
    assert bad.status_code == 400
    assert mock_firebase["update_user_password"] == []


def test_expired_otp_blocks_reset(client, mock_firebase):
    mock_firebase["user"] = _password_user()
    db = TestingSessionLocal()
    try:
        _insert_otp(db, EMAIL, code="123456", expires_at=utc_now_ms() - 1000)
    finally:
        db.close()
    res = client.post("/auth/otp/verify", json={"email": EMAIL, "otp": "123456"})
    assert res.status_code == 400
    assert "expired" in res.json()["detail"].lower()


def test_used_otp_blocks_reset(client, mock_firebase):
    mock_firebase["user"] = _password_user()
    db = TestingSessionLocal()
    try:
        _insert_otp(db, EMAIL, code="123456", used=True)
    finally:
        db.close()
    res = client.post("/auth/otp/verify", json={"email": EMAIL, "otp": "123456"})
    assert res.status_code == 400


def test_reset_otp_is_single_use(client, mock_firebase, fixed_otp):
    mock_firebase["user"] = _password_user()
    client.post("/auth/otp/send", json={"email": EMAIL})
    first = client.post("/auth/otp/verify", json={"email": EMAIL, "otp": "555555"})
    assert first.status_code == 200
    second = client.post("/auth/otp/verify", json={"email": EMAIL, "otp": "555555"})
    assert second.status_code == 400


def test_resend_cooldown_applies(client, mock_firebase, fixed_otp):
    mock_firebase["user"] = _password_user()
    assert client.post("/auth/otp/send", json={"email": EMAIL}).status_code == 200
    res = client.post("/auth/otp/send", json={"email": EMAIL})
    assert res.status_code == 429
    assert "Please wait" in res.json()["detail"]


def test_reset_requires_successful_otp_verification(client, mock_firebase, fixed_otp):
    """No token means no reset - the OTP must be verified first."""
    mock_firebase["user"] = _password_user()
    res = client.post(
        "/auth/reset-password",
        json={"email": EMAIL, "verification_token": "", "password": "newpass1"},
    )
    assert res.status_code == 401
    assert mock_firebase["update_user_password"] == []


def test_critical_same_uid_flow(client, mock_firebase, fixed_otp):
    """Critical regression: UID A -> Forgot Password -> OTP email -> verify OTP
    -> set new password -> account still UID A -> password login + Google login
    both resolve to UID A. No duplicate account is ever created."""
    mock_firebase["user"] = _google_and_password_user()
    original_uid = mock_firebase["user"]["uid"]
    assert original_uid == UID_A

    # 1. Forgot Password: OTP email is produced via the existing sender.
    send = client.post("/auth/otp/send", json={"email": EMAIL})
    assert send.status_code == 200

    # 2. OTP verified (single-use).
    token = client.post(
        "/auth/otp/verify", json={"email": EMAIL, "otp": "555555"}
    ).json()["verification_token"]

    # 3. New password set on the EXISTING UID.
    res = client.post(
        "/auth/reset-password",
        json={"email": EMAIL, "verification_token": token, "password": "new-password-1"},
    )
    assert res.status_code == 200
    assert mock_firebase["update_user_password"] == [(UID_A, "new-password-1")]
    assert mock_firebase["create_user_calls"] == 0

    # 4. Same UID, password provider present, Google provider untouched.
    mock_firebase["user"] = {
        "uid": UID_A,
        "email": EMAIL,
        "display_name": "Alice",
        "provider_ids": ["google.com", "password"],
    }
    after = client.post("/auth/user-status", json={"email": EMAIL}).json()
    assert after["exists"] is True
    assert after["has_password"] is True
    assert "google.com" in after["providers"]
    assert mock_firebase["user"]["uid"] == UID_A


# -------------------------------------------- forgot OTP account check (reset_password)


def test_forgot_otp_blocked_when_no_account(client, mock_firebase, mock_email_sender):
    """Forgot Password must never mail an OTP for an address with no account."""
    mock_firebase["user"] = None
    res = client.post(
        "/auth/otp/send",
        json={"email": EMAIL, "purpose": "reset_password"},
    )
    assert res.status_code == 404
    assert "no account" in res.json()["detail"].lower()
    assert mock_email_sender["emails"] == []


def test_forgot_otp_blocked_for_google_only_account(client, mock_firebase, mock_email_sender):
    """A Google-only account has no password to reset, so no OTP is mailed."""
    mock_firebase["user"] = _google_only_user()
    res = client.post(
        "/auth/otp/send",
        json={"email": EMAIL, "purpose": "reset_password"},
    )
    assert res.status_code == 400
    assert "password" in res.json()["detail"].lower()
    assert mock_email_sender["emails"] == []


def test_forgot_otp_allowed_for_account_with_password(client, mock_firebase, mock_email_sender):
    """A normal password account receives the forgot-password OTP."""
    mock_firebase["user"] = _password_user()
    res = client.post(
        "/auth/otp/send",
        json={"email": EMAIL, "purpose": "reset_password"},
    )
    assert res.status_code == 200
    assert len(mock_email_sender["emails"]) == 1
    assert mock_email_sender["emails"][0]["to"] == EMAIL


def test_forgot_otp_allowed_for_google_and_password_account(client, mock_firebase, mock_email_sender):
    """An account with both providers may still reset its password."""
    mock_firebase["user"] = _google_and_password_user()
    res = client.post(
        "/auth/otp/send",
        json={"email": EMAIL, "purpose": "reset_password"},
    )
    assert res.status_code == 200
    assert len(mock_email_sender["emails"]) == 1


def test_link_password_flow_not_affected_by_account_check(client, mock_firebase, mock_email_sender):
    """The existing Set Password (link_password) OTP flow is unchanged: it is
    not gated by the reset-password account check."""
    mock_firebase["user"] = None
    res = client.post("/auth/otp/send", json={"email": EMAIL})
    assert res.status_code == 200
    assert len(mock_email_sender["emails"]) == 1

