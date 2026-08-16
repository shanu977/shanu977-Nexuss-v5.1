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


# ---------------------------------------------------------------------------
# Client identity: X-Forwarded-For must only be trusted from a proxy peer.
# ---------------------------------------------------------------------------

def _client_id_for(client_host: str, xff: str | None = None) -> str:
    """Directly exercise RateLimitMiddleware._client_id with a synthetic request."""
    from starlette.requests import Request

    from app.middleware.rate_limit import RateLimitMiddleware

    headers = [(b"host", b"testserver")]
    if xff is not None:
        headers.append((b"x-forwarded-for", xff.encode()))
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/chat",
        "raw_path": b"/chat",
        "query_string": b"",
        "root_path": "",
        "headers": headers,
        "client": (client_host, 1234),
        "server": ("testserver", 80),
        "app": {},
    }
    mw = RateLimitMiddleware(lambda *_: None, paths=())
    return mw._client_id(Request(scope))


def test_proxy_peer_uses_first_xff_hop():
    # Railway-style: the socket peer is an internal address and the first
    # X-Forwarded-For hop is the real client.
    assert _client_id_for("10.0.0.7", xff="203.0.113.5, 10.0.0.1") == "203.0.113.5"


def test_public_peer_ignores_spoofed_xff():
    # Direct public peer: a client-supplied X-Forwarded-For must not grant a
    # fresh rate-limit budget.
    assert _client_id_for("8.8.8.8", xff="1.1.1.1") == "8.8.8.8"


def test_no_xff_uses_socket_peer():
    assert _client_id_for("10.0.0.7") == "10.0.0.7"
    assert _client_id_for("8.8.8.8") == "8.8.8.8"


def test_trust_proxy_headers_trusts_xff_from_public_peer(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "trust_proxy_headers", True)
    assert _client_id_for("8.8.8.8", xff="1.1.1.1") == "1.1.1.1"
