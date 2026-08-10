"""API key management: Supabase-backed, encrypted at rest, single local user."""

# pyrefly: ignore [missing-import]
import pytest

from app.models import UserApiKey
from app.routes.deps import LOCAL_USER_ID
from app.services.llm_service import UsageInfo
from tests.conftest import auth_headers
from tests.conftest_helpers import TestingSessionLocal


@pytest.fixture
def fake_llm(monkeypatch):
    from app.services import llm_service

    captured = {}

    def _fake(messages, **kwargs):
        captured.update(kwargs)
        usage = UsageInfo(input_tokens=10, output_tokens=5, total_tokens=15)
        return "Hello from the AI!", usage

    monkeypatch.setattr(llm_service, "complete", _fake)
    return captured


@pytest.fixture
def mock_test_key_success(monkeypatch):
    """Mock test_key to return success for all providers."""
    from app.services import api_key_service

    def _mock(provider, api_key):
        return {"valid": True, "message": f"{provider.capitalize()} API key is valid."}

    monkeypatch.setattr(api_key_service, "test_key", _mock)


@pytest.fixture
def mock_test_key_failure(monkeypatch):
    """Mock test_key to return failure for all providers."""
    from app.services import api_key_service

    def _mock(provider, api_key):
        return {"valid": False, "message": "Invalid API key. Please check your key and try again."}

    monkeypatch.setattr(api_key_service, "test_key", _mock)


def _rows(user_id: str):
    db = TestingSessionLocal()
    try:
        return db.query(UserApiKey).filter(UserApiKey.firebase_uid == user_id).all()
    finally:
        db.close()


def test_api_keys_list_and_upsert(client, mock_test_key_success):
    headers = auth_headers(client)
    assert client.get("/api-keys", headers=headers).status_code == 200
    assert (
        client.put("/api-keys", headers=headers, json={"provider": "groq", "api_key": "x"}).status_code
        == 200
    )
    assert client.delete("/api-keys/groq", headers=headers).status_code == 204
    assert (
        client.post("/api-keys/test", headers=headers, json={"provider": "groq", "api_key": "x"}).status_code
        == 200
    )


def test_list_defaults_to_no_keys(client):
    headers = auth_headers(client)
    resp = client.get("/api-keys", headers=headers)
    assert resp.status_code == 200
    assert resp.json() == [
        {"provider": "groq", "has_key": False, "updatedAt": 0},
        {"provider": "gemini", "has_key": False, "updatedAt": 0},
        {"provider": "openrouter", "has_key": False, "updatedAt": 0},
    ]


def test_save_and_list_key_never_returns_raw_value(client, mock_test_key_success):
    headers = auth_headers(client)
    resp = client.put(
        "/api-keys", headers=headers, json={"provider": "groq", "api_key": "sk-very-secret"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["has_key"] is True
    assert "sk-very-secret" not in resp.text

    lst = client.get("/api-keys", headers=headers).json()
    groq = next(item for item in lst if item["provider"] == "groq")
    assert groq["has_key"] is True
    assert groq["updatedAt"] > 0
    assert "sk-very-secret" not in str(lst)


def test_save_replaces_existing_key(client, mock_test_key_success):
    headers = auth_headers(client)
    first = client.put(
        "/api-keys", headers=headers, json={"provider": "gemini", "api_key": "old-key"}
    ).json()
    second = client.put(
        "/api-keys", headers=headers, json={"provider": "gemini", "api_key": "new-key"}
    ).json()
    assert second["has_key"] is True
    assert second["updatedAt"] >= first["updatedAt"]

    # Only one row exists per (user, provider).
    rows = _rows(LOCAL_USER_ID)
    assert [r for r in rows if r.provider == "gemini"]  # exists
    assert len(rows) == 1


def test_key_is_encrypted_at_rest(client, mock_test_key_success):
    headers = auth_headers(client)
    client.put(
        "/api-keys", headers=headers, json={"provider": "groq", "api_key": "raw-groq-key"}
    )

    rows = _rows(LOCAL_USER_ID)
    stored = next(r for r in rows if r.provider == "groq")
    assert "raw-groq-key" not in stored.encrypted_api_key
    assert stored.encrypted_api_key.startswith("gAAAAA")  # Fernet ciphertext


def test_delete_key(client, mock_test_key_success):
    headers = auth_headers(client)
    client.put("/api-keys", headers=headers, json={"provider": "gemini", "api_key": "x"})
    assert client.get("/api-keys", headers=headers).json()[1]["has_key"] is True

    resp = client.delete("/api-keys/gemini", headers=headers)
    assert resp.status_code == 204
    assert client.get("/api-keys", headers=headers).json()[1]["has_key"] is False

    # Deleting again is a 404.
    assert client.delete("/api-keys/gemini", headers=headers).status_code == 404


def test_upsert_rejects_unsupported_provider_and_blank_key(client, mock_test_key_success):
    headers = auth_headers(client)
    assert (
        client.put(
            "/api-keys", headers=headers, json={"provider": "bogus", "api_key": "x"}
        ).status_code
        == 422
    )
    assert (
        client.put(
            "/api-keys", headers=headers, json={"provider": "groq", "api_key": "   "}
        ).status_code
        == 422
    )


def test_delete_rejects_unsupported_provider(client):
    headers = auth_headers(client)
    assert client.delete("/api-keys/bogus", headers=headers).status_code == 422


def test_saved_key_wins_over_server_fallback_for_groq(client, fake_llm, mock_test_key_success):
    headers = auth_headers(client)
    client.put(
        "/api-keys", headers=headers, json={"provider": "groq", "api_key": "user-groq-key"}
    )

    resp = client.post("/chat", headers=headers, json={"message": "hi"})
    assert resp.status_code == 200, resp.text
    # The user's Supabase-stored key is used, not the server's .env key.
    assert fake_llm["api_key"] == "user-groq-key"


# ---- New tests for API key validation ----


def test_test_endpoint_returns_valid_for_mock(client, mock_test_key_success):
    headers = auth_headers(client)
    resp = client.post(
        "/api-keys/test",
        headers=headers,
        json={"provider": "groq", "api_key": "test-key"}
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["valid"] is True
    assert "valid" in data["message"].lower()


def test_test_endpoint_returns_invalid_for_mock(client, mock_test_key_failure):
    headers = auth_headers(client)
    resp = client.post(
        "/api-keys/test",
        headers=headers,
        json={"provider": "groq", "api_key": "bad-key"}
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["valid"] is False
    assert "invalid" in data["message"].lower()


def test_test_endpoint_rejects_unsupported_provider(client):
    headers = auth_headers(client)
    resp = client.post(
        "/api-keys/test",
        headers=headers,
        json={"provider": "bogus", "api_key": "x"}
    )
    assert resp.status_code == 422


def test_test_endpoint_rejects_blank_key(client):
    headers = auth_headers(client)
    resp = client.post(
        "/api-keys/test",
        headers=headers,
        json={"provider": "groq", "api_key": "   "}
    )
    assert resp.status_code == 422


def test_save_rejects_invalid_key(client, mock_test_key_failure):
    headers = auth_headers(client)
    resp = client.put(
        "/api-keys",
        headers=headers,
        json={"provider": "groq", "api_key": "invalid-key"}
    )
    assert resp.status_code == 400
    assert "invalid" in resp.json()["detail"].lower()

    # Key should NOT be saved.
    lst = client.get("/api-keys", headers=headers).json()
    groq = next(item for item in lst if item["provider"] == "groq")
    assert groq["has_key"] is False


def test_save_accepts_valid_key(client, mock_test_key_success):
    headers = auth_headers(client)
    resp = client.put(
        "/api-keys",
        headers=headers,
        json={"provider": "groq", "api_key": "valid-key"}
    )
    assert resp.status_code == 200
    assert resp.json()["has_key"] is True


def test_test_endpoint_does_not_save_key(client, mock_test_key_success):
    headers = auth_headers(client)
    # Test a key without saving it.
    client.post(
        "/api-keys/test",
        headers=headers,
        json={"provider": "groq", "api_key": "tested-but-not-saved"}
    )

    # Verify the key was NOT saved.
    lst = client.get("/api-keys", headers=headers).json()
    groq = next(item for item in lst if item["provider"] == "groq")
    assert groq["has_key"] is False
