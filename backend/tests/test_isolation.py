"""Cross-account isolation regression tests.

User A and User B are two distinct provisioned users (distinct Firebase UIDs
under the mock-token scheme). These tests assert that A can never read,
modify, or delete B's data through any backend resource, and that forged
user identifiers in request bodies are rejected outright rather than trusted.
"""

import time

import pytest

from app.models import UserApiKey
from tests.conftest_helpers import TestingSessionLocal

HEADERS_A = {"Authorization": "Bearer test-mock-token-usera"}
HEADERS_B = {"Authorization": "Bearer test-mock-token-userb"}


@pytest.fixture
def mock_test_key_success(monkeypatch):
    """Mock API key validation so tests can save fake keys."""
    from app.services import api_key_service

    def _mock(provider, api_key):
        return {"valid": True, "message": f"{provider.capitalize()} API key is valid."}

    monkeypatch.setattr(api_key_service, "test_key", _mock)


def _now():
    return int(time.time() * 1000)


# ------------------------------------------------------------- API keys


def test_api_key_isolation_user_b_cannot_see_or_delete_a_keys(client, mock_test_key_success):
    """User B must not see or be able to delete a key User A saved."""
    assert (
        client.put("/api-keys", headers=HEADERS_A, json={"provider": "groq", "api_key": "a-secret"}).status_code
        == 200
    )

    b_keys = client.get("/api-keys", headers=HEADERS_B).json()
    assert all(k["has_key"] is False for k in b_keys)

    # B has no key for the provider, so deletion is a 404 (never A's key).
    assert client.delete("/api-keys/groq", headers=HEADERS_B).status_code == 404

    a_keys = client.get("/api-keys", headers=HEADERS_A).json()
    groq = next(k for k in a_keys if k["provider"] == "groq")
    assert groq["has_key"] is True


def test_api_key_save_is_scoped_per_user(client, mock_test_key_success):
    """Saving a key as User B must not overwrite or alter User A's key."""
    a_save = client.put(
        "/api-keys", headers=HEADERS_A, json={"provider": "gemini", "api_key": "a-key"}
    ).json()
    b_save = client.put(
        "/api-keys", headers=HEADERS_B, json={"provider": "gemini", "api_key": "b-key"}
    ).json()
    assert b_save["has_key"] is True

    a_keys = client.get("/api-keys", headers=HEADERS_A).json()
    a_gemini = next(k for k in a_keys if k["provider"] == "gemini")
    assert a_gemini["has_key"] is True
    assert a_gemini["updatedAt"] == a_save["updatedAt"]

    db = TestingSessionLocal()
    try:
        rows = db.query(UserApiKey).filter(UserApiKey.provider == "gemini").all()
    finally:
        db.close()
    # One row per user, never shared or collapsed.
    assert len(rows) == 2
    assert rows[0].firebase_uid != rows[1].firebase_uid


# -------------------------------------------------------- conversations


def test_conversation_rest_isolation_user_b_cannot_access_a_conversation(client):
    created = client.post(
        "/conversations", headers=HEADERS_A, json={"title": "A's private chat"}
    ).json()
    conv_id = created["id"]

    # B cannot read, rename, or delete A's conversation (404, never 403/200).
    assert client.get(f"/conversations/{conv_id}", headers=HEADERS_B).status_code == 404
    assert (
        client.patch(f"/conversations/{conv_id}", headers=HEADERS_B, json={"title": "hijacked"}).status_code
        == 404
    )
    assert client.delete(f"/conversations/{conv_id}", headers=HEADERS_B).status_code == 404

    # B's list is empty; A still owns it, unchanged.
    assert client.get("/conversations", headers=HEADERS_B).json() == []
    detail = client.get(f"/conversations/{conv_id}", headers=HEADERS_A).json()
    assert detail["conversation"]["title"] == "A's private chat"


# ----------------------------------------------------------------- sync


def test_sync_pull_isolation_user_b_cannot_read_a_messages(client):
    now = _now()
    push_a = client.post(
        "/sync/push",
        headers=HEADERS_A,
        json={
            "conversations": [
                {"id": "iso-conv", "title": "private", "provider": "groq",
                 "createdAt": now, "updatedAt": now}
            ],
            "messages": [
                {"id": "iso-msg", "chatId": "iso-conv", "role": "user",
                 "content": "top secret", "timestamp": now}
            ],
            "deletedConversations": [],
            "deletedMessages": [],
        },
    )
    assert push_a.status_code == 200

    # B pulls nothing at all.
    pull_b = client.get("/sync/pull?since=0", headers=HEADERS_B).json()
    assert pull_b["conversations"] == []
    assert pull_b["messages"] == []

    # B cannot inject a message into A's conversation.
    client.post(
        "/sync/push",
        headers=HEADERS_B,
        json={
            "conversations": [],
            "messages": [
                {"id": "b-msg", "chatId": "iso-conv", "role": "assistant",
                 "content": "spoofed", "timestamp": now + 1}
            ],
            "deletedConversations": [],
            "deletedMessages": [],
        },
    )
    pull_b = client.get("/sync/pull?since=0", headers=HEADERS_B).json()
    assert pull_b["messages"] == []

    pull_a = client.get("/sync/pull?since=0", headers=HEADERS_A).json()
    assert {m["id"] for m in pull_a["messages"]} == {"iso-msg"}
    assert {c["id"] for c in pull_a["conversations"]} == {"iso-conv"}


# ------------------------------------------------------- forged identity


def test_forged_user_id_in_body_is_rejected(client):
    """A user identifier in a request body must be rejected outright (422),
    never trusted to steer the query toward another user's data."""
    assert (
        client.put("/settings", headers=HEADERS_A, json={"theme": "dark", "userId": "x"}).status_code
        == 422
    )
    assert (
        client.put("/settings", headers=HEADERS_A, json={"theme": "dark", "user_id": "x"}).status_code
        == 422
    )
    assert (
        client.put(
            "/api-keys", headers=HEADERS_A,
            json={"provider": "groq", "api_key": "k", "user_id": "x"},
        ).status_code
        == 422
    )
    assert (
        client.post("/conversations", headers=HEADERS_A, json={"title": "t", "userId": "x"}).status_code
        == 422
    )
    assert (
        client.post("/chat", headers=HEADERS_A, json={"message": "hi", "userId": "x"}).status_code
        == 422
    )
    assert (
        client.post(
            "/sync/push",
            headers=HEADERS_A,
            json={
                "conversations": [], "messages": [],
                "deletedConversations": [], "deletedMessages": [], "user_id": "x",
            },
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/sync/push",
            headers=HEADERS_A,
            json={
                "conversations": [
                    {"id": "c", "title": "t", "provider": None,
                     "createdAt": 1, "updatedAt": 1, "userId": "x"}
                ],
                "messages": [], "deletedConversations": [], "deletedMessages": [],
            },
        ).status_code
        == 422
    )

    # None of the rejected requests mutated A's own data.
    assert client.get("/settings", headers=HEADERS_A).json()["theme"] == "light"
    assert client.get("/conversations", headers=HEADERS_A).json() == []


def test_garbage_token_rejected(client):
    """A Bearer token that is neither a valid Firebase token nor a mock token
    must never be mapped to a user."""
    res = client.get(
        "/settings", headers={"Authorization": "Bearer totally-bogus-token"}
    )
    assert res.status_code == 401
