"""Usage ingestion: /chat persists real usage metadata into usage_records.

Covers successful attempts, failed attempts, fallback chains, request types,
duplicate protection, and — critically — that usage persistence failures never
fail the chat request.
"""

# pyrefly: ignore [missing-import]
import pytest

from app.models import UsageRecord
from app.services import llm_service, usage_service
from app.services.llm_service import UsageInfo
from tests.conftest import auth_headers
from tests.conftest_helpers import TestingSessionLocal


@pytest.fixture
def db_foundation_session():
    from app.models import User

    db = TestingSessionLocal()
    user = User(email="usage-unit@example.com", name="Usage Unit")
    db.add(user)
    db.commit()
    yield {"session": db, "user": user}
    db.close()


@pytest.fixture
def fake_llm(monkeypatch):
    """Replace llm_service.complete with a deterministic fake."""
    calls = []
    script = {}

    def _set(provider, outcome):
        script[provider] = outcome

    def _fake(messages, **kwargs):
        provider = kwargs["provider"]
        calls.append({**kwargs, "messages": messages})
        outcome = script.get(provider)
        if outcome is None:
            usage = UsageInfo(input_tokens=10, output_tokens=5, total_tokens=15)
            return "Hello from the AI!", usage
        kind = outcome[0]
        if kind == "ok":
            return outcome[1], UsageInfo(input_tokens=10, output_tokens=5, total_tokens=15)
        if kind == "raise":
            raise outcome[1]
        if kind == "raise_status":
            raise llm_service._map_error(outcome[1])
        raise AssertionError(f"unknown script outcome {kind}")

    monkeypatch.setattr(llm_service, "complete", _fake)
    return {"calls": calls, "script": _set}


@pytest.fixture(autouse=True)
def mock_test_key(monkeypatch):
    """Allow saving fake API keys for any provider (no network calls)."""
    from app.services import api_key_service

    def _mock(provider, api_key):
        return {"valid": True, "message": f"{provider.capitalize()} API key is valid."}

    monkeypatch.setattr(api_key_service, "test_key", _mock)


def _save_key(client, provider, key="key-123"):
    headers = auth_headers(client)
    resp = client.put(
        "/api-keys", headers=headers, json={"provider": provider, "api_key": key}
    )
    assert resp.status_code == 200, resp.text


def _all_usage():
    db = TestingSessionLocal()
    try:
        return db.query(UsageRecord).order_by(UsageRecord.attempt).all()
    finally:
        db.close()


def test_chat_persists_successful_usage(client, fake_llm):
    resp = client.post(
        "/chat", headers=auth_headers(client), json={"message": "Hi there"}
    )
    assert resp.status_code == 200, resp.text

    records = _all_usage()
    assert len(records) == 1
    rec = records[0]
    assert rec.status == "success"
    assert rec.provider == "groq"
    assert rec.model == "llama-3.3-70b-versatile"
    assert rec.request_type == "chat"
    assert rec.attempt == 1
    assert rec.input_tokens == 10
    assert rec.output_tokens == 5
    assert rec.total_tokens == 15
    assert rec.http_status == 200
    assert rec.error_category is None
    assert rec.latency_ms >= 0


def test_screen_share_request_uses_screen_share_type(client, fake_llm):
    image = "data:image/png;base64,AAAA"
    resp = client.post(
        "/chat",
        headers=auth_headers(client),
        json={"message": "What is in this frame?", "image": image},
    )
    assert resp.status_code == 200, resp.text

    records = _all_usage()
    assert len(records) == 1
    assert records[0].request_type == "screen_share"
    assert records[0].model == "qwen/qwen3.6-27b"


def test_failed_attempt_persisted_and_chat_fails(client, fake_llm, monkeypatch):
    def _fail(messages, **kwargs):
        raise llm_service.BadRequestError()

    monkeypatch.setattr(llm_service, "complete", _fail)

    resp = client.post("/chat", headers=auth_headers(client), json={"message": "Hi"})
    assert resp.status_code == 400

    records = _all_usage()
    assert len(records) == 1
    rec = records[0]
    assert rec.status == "failed"
    assert rec.error_category == "bad_request"
    assert rec.input_tokens == 0
    assert rec.output_tokens == 0
    assert rec.total_tokens == 0


def test_fallback_attempts_all_persisted(client, fake_llm, mock_test_key):
    _save_key(client, "openrouter")
    fake_llm["script"]("groq", ("raise_status", 429))
    fake_llm["script"]("openrouter", ("ok", "Fallback reply"))

    resp = client.post("/chat", headers=auth_headers(client), json={"message": "Hi"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["provider"] == "openrouter"

    records = _all_usage()
    assert len(records) == 2
    groq_attempt, openrouter_attempt = records
    assert groq_attempt.attempt == 1
    assert groq_attempt.status == "failed"
    assert groq_attempt.error_category == "rate_limit"
    assert groq_attempt.provider == "groq"
    assert openrouter_attempt.attempt == 2
    assert openrouter_attempt.status == "success"
    assert openrouter_attempt.provider == "openrouter"


def test_no_duplicate_records_for_single_request(client, fake_llm):
    client.post("/chat", headers=auth_headers(client), json={"message": "Hi"})
    assert len(_all_usage()) == 1


def test_usage_persistence_failure_does_not_fail_chat(client, fake_llm, monkeypatch):
    from app.services import usage_service as us

    def _boom(*args, **kwargs):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(us, "UsageRecord", _boom)

    resp = client.post("/chat", headers=auth_headers(client), json={"message": "Hi"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["reply"] == "Hello from the AI!"


def test_record_attempts_unit_success(db_foundation_session):
    user = db_foundation_session["user"]
    session = db_foundation_session["session"]
    attempts = [
        {
            "provider": "groq",
            "model": "m1",
            "attempt": 1,
            "status": "success",
            "http_status": 200,
            "reason": None,
            "input_tokens": 10,
            "output_tokens": 5,
            "total_tokens": 15,
            "response_time_ms": 250,
            "timestamp": 1234567890123,
        }
    ]
    count = usage_service.record_attempts(session, user, "chat", attempts)
    assert count == 1
    rec = session.query(UsageRecord).one()
    assert rec.provider == "groq"
    assert rec.total_tokens == 15
    assert rec.created_at == 1234567890123
    session.rollback()


def test_record_attempts_empty_returns_zero(db_foundation_session):
    session = db_foundation_session["session"]
    user = db_foundation_session["user"]
    assert usage_service.record_attempts(session, user, "chat", []) == 0
    assert usage_service.record_attempts(session, user, "chat", None) == 0


def test_record_attempts_swallows_db_errors():
    class BoomDB:
        def add_all(self, rows):
            raise RuntimeError("disk full")

        def commit(self):
            raise RuntimeError("disk full")

        def rollback(self):
            pass

    attempts = [
        {
            "provider": "groq",
            "model": "m1",
            "attempt": 1,
            "status": "success",
            "input_tokens": 1,
            "output_tokens": 1,
            "total_tokens": 2,
            "response_time_ms": 10,
            "timestamp": 1,
        }
    ]
    user = type("User", (), {"id": "u1"})()
    assert usage_service.record_attempts(BoomDB(), user, "chat", attempts) == 0
