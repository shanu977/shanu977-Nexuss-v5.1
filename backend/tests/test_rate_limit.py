import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.database import get_db
from app.services import llm_service
from app.services.llm_service import UsageInfo

from tests.conftest_helpers import override_get_db

app.dependency_overrides[get_db] = override_get_db


@pytest.fixture(autouse=True)
def _mock_llm(monkeypatch):
    """Keep /chat fast and network-free: the rate limiter must be tested
    without making real AI provider calls."""
    def _fake(messages, **kwargs):
        usage = UsageInfo(input_tokens=1, output_tokens=1, total_tokens=2)
        return "hi", usage

    monkeypatch.setattr(llm_service, "complete", _fake)


def _chat(client, message="hi"):
    """Hit the rate-limited /chat endpoint with a minimal request body."""
    return client.post("/chat", json={"message": message})


def test_chat_rate_limiting():
    with TestClient(app) as client:
        statuses = []
        for _ in range(70):
            resp = _chat(client, message="ratelimit1")
            statuses.append(resp.status_code)
        assert 429 in statuses


def test_health_is_not_rate_limited():
    with TestClient(app) as client:
        for _ in range(70):
            resp = client.get("/health")
            assert resp.status_code == 200


def test_rate_limit_not_bypassed_by_xff_spoofing():
    # TRUST_PROXY_HEADERS defaults to false, so spoofed X-Forwarded-For
    # values must NOT grant a fresh budget.
    with TestClient(app) as client:
        statuses = []
        for i in range(70):
            resp = _chat(client, message=f"xff{i}")
            statuses.append(resp.status_code)
        assert 429 in statuses


def test_chat_rate_limiting_returns_json_429():
    """Verify /chat is rate limited under heavy load and returns JSON."""
    with TestClient(app) as client:
        statuses = []
        for i in range(70):
            resp = _chat(client, message=f"chatrl{i}")
            statuses.append(resp.status_code)

        # Once the window is exhausted the middleware must return a JSON 429.
        assert 429 in statuses
        last = _chat(client, message="chatrl-last")
        assert last.status_code == 429
        assert last.json()["detail"]
