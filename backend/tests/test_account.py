"""Self-service account endpoints: profile, export, and deletion."""

import json
import time

import pytest
from fastapi import HTTPException

from app.models import (
    AccountDeletion,
    AuditLog,
    Conversation,
    EmailOTP,
    Feedback,
    Message,
    User,
    UserApiKey,
    UserSettings,
    UsageRecord,
)
from app.routes.account import (
    RECENT_AUTH_MAX_AGE_SECONDS,
    _require_recent_authentication,
)
from app.services import account_deletion, firebase_service
from tests.admin_helpers import make_admin, provision_user
from tests.conftest import auth_headers
from tests.conftest_helpers import TestingSessionLocal

HEADERS_A = {"Authorization": "Bearer test-mock-token-usera"}
HEADERS_B = {"Authorization": "Bearer test-mock-token-userb"}


def _uid(email: str) -> str:
    db = TestingSessionLocal()
    try:
        user = db.query(User).filter(User.email == email).first()
        assert user is not None, f"User {email} not provisioned"
        return user.id
    finally:
        db.close()


def _seed_owned_data(user_id: str, email: str) -> dict:
    """Create every kind of user-owned row the schema supports."""
    db = TestingSessionLocal()
    try:
        conv = Conversation(user_id=user_id, title="Seed chat", provider="groq")
        db.add(conv)
        db.flush()
        db.add(Message(conversation_id=conv.id, role="user", content="hi"))
        existing_settings = (
            db.query(UserSettings).filter(UserSettings.user_id == user_id).first()
        )
        if existing_settings is not None:
            existing_settings.theme = "dark"
            existing_settings.language = "en"
        else:
            db.add(UserSettings(user_id=user_id, theme="dark", language="en"))
        db.add(UserApiKey(firebase_uid=user_id, provider="groq", encrypted_api_key="vault"))
        db.add(
            UsageRecord(
                user_id=user_id,
                provider="groq",
                model="openai/gpt-oss-120b",
                input_tokens=3,
                output_tokens=5,
            )
        )
        db.add(Feedback(user_id=user_id, rating=5, message="nice"))
        db.add(EmailOTP(email=email, otp_hash="hash", expires_at=1))
        db.commit()
        return {"conversation_id": conv.id}
    finally:
        db.close()


def _row_counts(user_id: str, email: str) -> dict:
    db = TestingSessionLocal()
    try:
        return {
            "users": db.query(User).filter(User.id == user_id).count(),
            "conversations": db.query(Conversation).filter(Conversation.user_id == user_id).count(),
            "messages": db.query(Message).count(),
            "settings": db.query(UserSettings).filter(UserSettings.user_id == user_id).count(),
            "api_keys": db.query(UserApiKey).filter(UserApiKey.firebase_uid == user_id).count(),
            "usage": db.query(UsageRecord).filter(UsageRecord.user_id == user_id).count(),
            "feedback": db.query(Feedback).filter(Feedback.user_id == user_id).count(),
            "otps": db.query(EmailOTP).filter(EmailOTP.email == email).count(),
        }
    finally:
        db.close()


@pytest.fixture
def firebase_deleted(monkeypatch):
    """Replace the live Admin-SDK calls with an in-memory double.

    Models a Firebase sign-in account that exists until ``delete_user`` runs,
    so the backend's verification step behaves the way it does in production
    instead of tripping over a missing Firebase app.
    """
    calls: list[str] = []

    def _fake_delete(uid: str) -> None:
        if uid not in calls:
            calls.append(uid)

    def _fake_exists(uid: str) -> bool:
        return uid not in calls

    monkeypatch.setattr(firebase_service, "delete_user", _fake_delete)
    monkeypatch.setattr(firebase_service, "user_exists", _fake_exists)
    return calls


def test_get_account_requires_authentication(client):
    assert client.get("/account").status_code == 401


def test_get_account_returns_provisioned_profile(client):
    headers = auth_headers(client)
    assert client.get("/account", headers=headers).status_code == 200
    body = client.get("/account", headers=headers).json()
    assert body["email"] == "test@example.com"
    assert body["name"] == "Test User"
    assert body["role"] == "user"
    assert body["provider"] == "firebase"
    assert isinstance(body["created_at"], int)
    # No secrets or internal vault material in the profile payload.
    assert "encrypted_api_key" not in json.dumps(body)


def test_export_returns_owned_data_without_secrets(client):
    headers = auth_headers(client)
    provision_user(client, headers)
    user_id = _uid("test@example.com")
    _seed_owned_data(user_id, "test@example.com")

    res = client.get("/account/export", headers=headers)
    assert res.status_code == 200
    body = res.json()

    assert body["account"]["email"] == "test@example.com"
    assert body["settings"]["theme"] == "dark"
    assert body["apiKeys"] == [
        {"provider": "groq", "createdAt": body["apiKeys"][0]["createdAt"], "updatedAt": body["apiKeys"][0]["updatedAt"]}
    ]
    assert len(body["conversations"]) == 1
    assert body["conversations"][0]["messages"][0]["content"] == "hi"
    assert len(body["usageRecords"]) == 1
    assert len(body["feedback"]) == 1
    # The encrypted ciphertext must never leave the server.
    assert "vault" not in res.text
    assert "encrypted_api_key" not in res.text


def test_export_only_returns_the_callers_data(client):
    provision_user(client, HEADERS_A)
    provision_user(client, HEADERS_B)
    _seed_owned_data(_uid("test-mock-token-usera@example.com"), "test-mock-token-usera@example.com")

    body = client.get("/account/export", headers=HEADERS_B).json()
    assert body["conversations"] == []
    assert body["usageRecords"] == []
    assert body["feedback"] == []


def test_delete_requires_exact_confirmation(client, firebase_deleted):
    provision_user(client, HEADERS_A)
    user_id = _uid("test-mock-token-usera@example.com")
    _seed_owned_data(user_id, "test-mock-token-usera@example.com")

    for bad in ["", "delete", "Delete", "DELETE ", "DELETEX"]:
        res = client.post("/account/delete", headers=HEADERS_A, json={"confirmation": bad})
        assert res.status_code == 400, bad

    # Nothing was removed and Firebase was never called.
    counts = _row_counts(user_id, "test-mock-token-usera@example.com")
    assert counts["users"] == 1
    assert counts["conversations"] == 1
    assert counts["messages"] == 1
    assert counts["settings"] == 1
    assert counts["api_keys"] == 1
    assert counts["otps"] == 1
    assert firebase_deleted == []


def test_delete_rejects_unknown_body_fields(client):
    provision_user(client, HEADERS_A)
    res = client.post(
        "/account/delete",
        headers=HEADERS_A,
        json={"confirmation": "DELETE", "user_id": "someone-else"},
    )
    assert res.status_code == 422


def test_delete_requires_authentication(client):
    res = client.post("/account/delete", json={"confirmation": "DELETE"})
    assert res.status_code == 401


def test_delete_removes_user_data_and_auth(client, firebase_deleted):
    headers = HEADERS_A
    provision_user(client, headers)
    user_id = _uid("test-mock-token-usera@example.com")
    email = "test-mock-token-usera@example.com"
    _seed_owned_data(user_id, email)

    res = client.post("/account/delete", headers=headers, json={"confirmation": "DELETE"})
    assert res.status_code == 200
    body = res.json()
    assert body["state"] == "completed"
    assert body["stage"] == "verifying"
    assert body["detail"]

    counts = _row_counts(user_id, email)
    assert counts == {
        "users": 0,
        "conversations": 0,
        "messages": 0,
        "settings": 0,
        "api_keys": 0,
        "usage": 0,
        "feedback": 0,
        "otps": 0,
    }
    # The Firebase authentication user is deleted server-side.
    assert firebase_deleted == [user_id]

    db = TestingSessionLocal()
    try:
        # No operational job row, no audit row: nothing persistent identifies
        # the person after a successful deletion.
        assert db.query(AccountDeletion).count() == 0
        assert db.query(AuditLog).count() == 0
    finally:
        db.close()

    # The ID token no longer resolves to an account, so the API refuses it.
    assert client.get("/settings", headers=headers).status_code == 401
    assert client.get("/account/deletion", headers=headers).status_code == 200
    assert client.get("/account/deletion", headers=headers).json()["state"] == "none"


def test_delete_leaves_other_accounts_untouched(client, firebase_deleted):
    provision_user(client, HEADERS_A)
    provision_user(client, HEADERS_B)
    actor_id = _uid("test-mock-token-usera@example.com")
    other_id = _uid("test-mock-token-userb@example.com")
    _seed_owned_data(other_id, "test-mock-token-userb@example.com")

    res = client.post("/account/delete", headers=HEADERS_A, json={"confirmation": "DELETE"})
    assert res.status_code == 200

    counts = _row_counts(other_id, "test-mock-token-userb@example.com")
    assert counts["users"] == 1
    assert counts["conversations"] == 1
    assert counts["messages"] == 1
    assert firebase_deleted == [actor_id]


def test_delete_forbidden_for_admins(client, firebase_deleted):
    admin_headers = make_admin(client, auth_headers(client))
    admin_id = _uid("test@example.com")

    res = client.post("/account/delete", headers=admin_headers, json={"confirmation": "DELETE"})
    assert res.status_code == 403
    assert _row_counts(admin_id, "test@example.com")["users"] == 1
    assert firebase_deleted == []


def test_delete_schedules_a_retry_when_auth_account_survives(client, monkeypatch):
    """A failed sign-in removal never reports success — it retries with backoff."""
    provision_user(client, HEADERS_A)
    user_id = _uid("test-mock-token-usera@example.com")
    email = "test-mock-token-usera@example.com"
    _seed_owned_data(user_id, email)

    def _boom(uid: str) -> None:
        raise ValueError("Firebase Admin SDK is unavailable.")

    monkeypatch.setattr(firebase_service, "delete_user", _boom)

    res = client.post("/account/delete", headers=HEADERS_A, json={"confirmation": "DELETE"})
    assert res.status_code == 200
    body = res.json()
    assert body["state"] == "retry_wait"
    assert body["stage"] == "removing_auth"
    assert body["attempt"] == 1
    assert body["next_attempt_at"] > 0
    assert "ValueError" in body["last_error"]

    counts = _row_counts(user_id, email)
    assert counts["users"] == 0
    assert counts["conversations"] == 0
    # The partial state stays locked (a job row exists) and nothing was
    # written to the audit log about the failure.
    db = TestingSessionLocal()
    try:
        job = db.query(AccountDeletion).filter(AccountDeletion.firebase_uid == user_id).one()
        assert job.state == "retry_wait"
        assert job.attempt == 1
        assert db.query(AuditLog).count() == 0
    finally:
        db.close()


def test_deleted_account_can_resume_and_finish(client, firebase_deleted, monkeypatch):
    """An explicit retry re-arms an exhausted job and completes the deletion."""
    provision_user(client, HEADERS_A)
    user_id = _uid("test-mock-token-usera@example.com")
    email = "test-mock-token-usera@example.com"

    def _boom(uid: str) -> None:
        raise ValueError("Firebase Admin SDK is unavailable.")

    monkeypatch.setattr(firebase_service, "delete_user", _boom)
    res = client.post("/account/delete", headers=HEADERS_A, json={"confirmation": "DELETE"})
    assert res.json()["state"] == "retry_wait"

    # Exhaust the bounded retry budget without waiting out the backoff.
    db = TestingSessionLocal()
    try:
        job = db.query(AccountDeletion).filter(AccountDeletion.firebase_uid == user_id).one()
        job.attempt = job.max_attempts
        job.state = account_deletion.STATE_RETRY_WAIT
        job.next_attempt_at = 0
        db.commit()
    finally:
        db.close()

    # Background sweeper drives retries: this attempt fails again -> failed.
    sweep_db = TestingSessionLocal()
    try:
        assert account_deletion.run_due_jobs(sweep_db) == 1
    finally:
        sweep_db.close()
    db = TestingSessionLocal()
    try:
        job = db.query(AccountDeletion).filter(AccountDeletion.firebase_uid == user_id).one()
        assert job.state == "failed"
        assert job.attempt == job.max_attempts + 1
    finally:
        db.close()

    # The user may not use the locked account...
    assert client.get("/settings", headers=HEADERS_A).status_code == 423
    # ...but they can retry deletion, which re-arms and finishes the job.
    monkeypatch.setattr(
        firebase_service, "delete_user", lambda uid: firebase_deleted.append(uid)
    )
    res = client.post("/account/delete", headers=HEADERS_A, json={"confirmation": "DELETE"})
    assert res.status_code == 200
    assert res.json()["state"] == "completed"
    assert firebase_deleted == [user_id]
    assert _row_counts(user_id, email)["users"] == 0
    db = TestingSessionLocal()
    try:
        assert db.query(AccountDeletion).count() == 0
    finally:
        db.close()


def test_deletion_job_is_idempotent_and_resumable(client, firebase_deleted):
    """Re-issuing delete while a job is queued never double-runs the work."""
    provision_user(client, HEADERS_A)
    user_id = _uid("test-mock-token-usera@example.com")
    email = "test-mock-token-usera@example.com"
    _seed_owned_data(user_id, email)

    db = TestingSessionLocal()
    try:
        job = account_deletion.start_deletion(db, user_id, email)
        job_id = job.id
        # Queue it into the background instead of running it inline.
        job.state = account_deletion.STATE_QUEUED
        job.next_attempt_at = 0
        db.commit()
    finally:
        db.close()

    # The account is locked while the job sits queued.
    assert client.get("/settings", headers=HEADERS_A).status_code == 423
    status = client.get("/account/deletion", headers=HEADERS_A).json()
    assert status["state"] == "queued"

    res = client.post("/account/delete", headers=HEADERS_A, json={"confirmation": "DELETE"})
    assert res.status_code == 200
    assert res.json()["state"] == "completed"
    assert firebase_deleted == [user_id]

    db = TestingSessionLocal()
    try:
        assert db.query(AccountDeletion).filter(AccountDeletion.id == job_id).count() == 0
        assert db.query(AuditLog).count() == 0
    finally:
        db.close()


def test_delete_requires_a_verified_session(client):
    assert client.get("/account/deletion").status_code == 401
    assert client.post("/account/delete", json={"confirmation": "DELETE"}).status_code == 401


def test_delete_rejects_stale_id_token(client, firebase_deleted):
    """A token issued longer ago than the window must not delete an account."""
    provision_user(client, HEADERS_A)
    user_id = _uid("test-mock-token-usera@example.com")

    with pytest.raises(HTTPException) as exc:
        _require_recent_authentication({"iat": time.time() - RECENT_AUTH_MAX_AGE_SECONDS - 60})
    assert exc.value.status_code == 401

    # Fresh token passes.
    _require_recent_authentication({"iat": time.time()})

    # Mock/test tokens without iat (pytest-only path) are accepted.
    _require_recent_authentication({})
    assert _row_counts(user_id, "test-mock-token-usera@example.com")["users"] == 1


def test_delete_is_rate_limited(client):
    provision_user(client, HEADERS_A)
    for _ in range(5):
        res = client.post("/account/delete", headers=HEADERS_A, json={"confirmation": "nope"})
        assert res.status_code == 400
    res = client.post("/account/delete", headers=HEADERS_A, json={"confirmation": "nope"})
    assert res.status_code == 429


def test_deletion_locks_account_and_password_flows(client, firebase_deleted):
    """While a deletion is in flight nothing may write to this account."""
    provision_user(client, HEADERS_A)
    user_id = _uid("test-mock-token-usera@example.com")
    email = "test-mock-token-usera@example.com"

    db = TestingSessionLocal()
    try:
        account_deletion.start_deletion(db, user_id, email)
    finally:
        db.close()

    # Authenticated app routes are frozen (no new rows can be created)...
    for path in ["/settings", "/account", "/account/export", "/conversations"]:
        assert client.get(path, headers=HEADERS_A).status_code == 423, path

    # ...while the deletion-specific endpoints keep working.
    assert client.get("/account/deletion", headers=HEADERS_A).status_code == 200
    assert client.get("/account/deletion", headers=HEADERS_A).json()["state"] == "queued"

    # Unauthenticated credential flows for the same address are frozen too.
    for path, payload in [
        ("/auth/user-status", {"email": email}),
        ("/auth/otp/send", {"email": email}),
        ("/auth/otp/verify", {"email": email, "otp": "123456"}),
        (
            "/auth/set-password",
            {"email": email, "verification_token": "t", "password": "secret1"},
        ),
        (
            "/auth/reset-password",
            {"email": email, "verification_token": "t", "password": "secret1"},
        ),
    ]:
        res = client.post(path, json=payload)
        assert res.status_code == 423, path

    assert firebase_deleted == []


def test_deletion_email_lookup_is_case_and_whitespace_insensitive():
    """A job started with 'User@Example.com' must lock 'user@example.com'."""
    db = TestingSessionLocal()
    try:
        db.query(AccountDeletion).delete()
        db.commit()
        job = account_deletion.start_deletion(db, "uid-email-norm", "User@Example.com")
        assert job.email == "user@example.com"

        assert account_deletion.get_active_job_by_email(db, "user@example.com") is not None
        assert account_deletion.get_active_job_by_email(db, "USER@EXAMPLE.COM") is not None
        assert account_deletion.get_active_job_by_email(db, "  user@example.com  ") is not None
        assert account_deletion.get_active_job_by_email(db, "  USER@Example.COM\n") is not None
        # A different address must not match.
        assert account_deletion.get_active_job_by_email(db, "other@example.com") is None
        assert account_deletion.get_active_job_by_email(db, "") is None
        assert account_deletion.get_active_job_by_email(db, None) is None
    finally:
        db.query(AccountDeletion).filter(AccountDeletion.firebase_uid == "uid-email-norm").delete()
        db.commit()
        db.close()


def test_start_deletion_heals_legacy_unnormalized_email():
    """Rows stored before normalization still lock, then self-heal."""
    db = TestingSessionLocal()
    try:
        db.query(AccountDeletion).filter(AccountDeletion.firebase_uid == "uid-legacy-email").delete()
        db.commit()
        legacy = AccountDeletion(
            id="legacy-row-1",
            firebase_uid="uid-legacy-email",
            email="Legacy@Example.COM",
            state=account_deletion.STATE_QUEUED,
            stage=account_deletion.STAGE_QUEUED,
            attempt=0,
            max_attempts=account_deletion.MAX_ATTEMPTS,
            next_attempt_at=0,
            created_at=0,
            updated_at=0,
        )
        db.add(legacy)
        db.commit()

        # Case-insensitive lookup finds the legacy row.
        assert account_deletion.get_active_job_by_email(db, "legacy@example.com") is not None

        # Touching the job normalizes the stored value.
        job = account_deletion.start_deletion(db, "uid-legacy-email", "legacy@example.com")
        assert job.email == "legacy@example.com"
    finally:
        db.query(AccountDeletion).filter(AccountDeletion.firebase_uid == "uid-legacy-email").delete()
        db.commit()
        db.close()


def test_start_deletion_concurrent_race_returns_single_job(monkeypatch):
    """Two simultaneous starts resolve to one row with no IntegrityError."""
    db = TestingSessionLocal()
    try:
        db.query(AccountDeletion).filter(AccountDeletion.firebase_uid == "uid-race-1").delete()
        db.commit()
        first = account_deletion.start_deletion(db, "uid-race-1", "race@example.com")

        # Force the next call down the insert path even though the row
        # exists, simulating a second request that selected before the
        # first request committed.
        real_get = account_deletion.get_active_job
        calls: list[str] = []

        def _race_once(db_, uid_):
            if not calls:
                calls.append(uid_)
                return None
            return real_get(db_, uid_)

        monkeypatch.setattr(account_deletion, "get_active_job", _race_once)
        second = account_deletion.start_deletion(db, "uid-race-1", "race@example.com")

        assert second.id == first.id
        assert second.firebase_uid == "uid-race-1"
        assert db.query(AccountDeletion).filter(AccountDeletion.firebase_uid == "uid-race-1").count() == 1

        # Plain idempotent re-entry (no race) also returns the same job.
        monkeypatch.undo()
        third = account_deletion.start_deletion(db, "uid-race-1", "race@example.com")
        assert third.id == first.id
        assert db.query(AccountDeletion).filter(AccountDeletion.firebase_uid == "uid-race-1").count() == 1
    finally:
        db.query(AccountDeletion).filter(AccountDeletion.firebase_uid == "uid-race-1").delete()
        db.commit()
        db.close()
