"""Centralized AI provider fallback: routing, cooldown, attempts, errors."""

# pyrefly: ignore [missing-import]
import pytest

from app.services import llm_service
from app.services.llm_service import UsageInfo
from tests.conftest import auth_headers


@pytest.fixture
def mock_test_key(monkeypatch):
    """Allow saving fake API keys for any provider (no network calls)."""
    from app.services import api_key_service

    def _mock(provider, api_key):
        return {"valid": True, "message": f"{provider.capitalize()} API key is valid."}

    monkeypatch.setattr(api_key_service, "test_key", _mock)


@pytest.fixture
def fake_llm(monkeypatch):
    """Replace llm_service.complete with a per-provider scriptable fake.

    The fake records every call (provider/model/api_key) so tests can assert
    the exact chain. `script` maps provider -> ("ok", reply, usage) or
    ("raise", exception) or ("raise_status", http_status).
    """
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
            reply = outcome[1]
            if len(outcome) > 2 and outcome[2] is not None:
                usage = outcome[2]
            else:
                usage = UsageInfo(
                    input_tokens=10, output_tokens=5, total_tokens=15
                )
            return reply, usage
        if kind == "raise":
            raise outcome[1]
        if kind == "raise_status":
            raise llm_service._map_error(outcome[1])

    monkeypatch.setattr(llm_service, "complete", _fake)
    return {"calls": calls, "script": _set}


def _save_key(client, provider, key="key-123"):
    headers = auth_headers(client)
    resp = client.put(
        "/api-keys", headers=headers, json={"provider": provider, "api_key": key}
    )
    assert resp.status_code == 200, resp.text


# ------------------------------------------------------------------ happy path


def test_primary_succeeds_without_fallback(client, fake_llm, mock_test_key):
    headers = auth_headers(client)
    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["reply"] == "Hello from the AI!"
    assert data["provider"] == "groq"
    assert data["model"] == "llama-3.3-70b-versatile"
    assert data["fallback_used"] is None

    attempts = data["attempts"]
    assert len(attempts) == 1
    assert attempts[0]["provider"] == "groq"
    assert attempts[0]["status"] == "success"
    assert attempts[0]["attempt"] == 1
    assert attempts[0]["total_tokens"] == 15

    # Only the primary provider was contacted.
    assert [c["provider"] for c in fake_llm["calls"]] == ["groq"]


def test_existing_chat_flow_still_works_with_history(client, fake_llm, mock_test_key):
    headers = auth_headers(client)
    history = [
        {"role": "user", "content": "What is the capital of France?"},
        {"role": "assistant", "content": "Paris."},
    ]
    resp = client.post(
        "/chat", headers=headers, json={"message": "And of Spain?", "history": history}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["reply"] == "Hello from the AI!"
    # Context is still forwarded to the provider call.
    msgs = fake_llm["calls"][0]["messages"]
    assert msgs[1:-1] == history


# ----------------------------------------------------------------- fallback


def test_429_falls_back_to_openrouter(client, fake_llm, mock_test_key):
    _save_key(client, "openrouter")
    fake_llm["script"]("groq", ("raise_status", 429))
    headers = auth_headers(client)

    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["provider"] == "openrouter"
    assert data["model"] == "openai/gpt-oss-120b:free"
    assert data["fallback_used"] == (
        "Groq was temporarily unavailable. Response generated using Openrouter."
    )

    attempts = data["attempts"]
    assert [a["provider"] for a in attempts] == ["groq", "openrouter"]
    assert attempts[0]["status"] == "failed"
    assert attempts[0]["http_status"] == 429
    assert attempts[0]["reason"] == "rate_limit"
    assert attempts[0]["total_tokens"] == 0
    assert attempts[1]["status"] == "success"
    assert attempts[1]["http_status"] == 200

    assert [c["provider"] for c in fake_llm["calls"]] == ["groq", "openrouter"]


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_5xx_statuses_fall_back(client, fake_llm, mock_test_key, status):
    _save_key(client, "openrouter")
    fake_llm["script"]("groq", ("raise_status", status))
    headers = auth_headers(client)

    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["provider"] == "openrouter"
    assert resp.json()["attempts"][0]["http_status"] == status


def test_fallback_uses_the_exact_model_for_that_provider(client, fake_llm, mock_test_key):
    # The fallback must send the provider's own configured model id, never a
    # model borrowed from another provider.
    _save_key(client, "openrouter")
    fake_llm["script"]("groq", ("raise_status", 429))
    headers = auth_headers(client)

    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 200
    calls = fake_llm["calls"]
    assert calls[1]["provider"] == "openrouter"
    assert calls[1]["model"] == "openai/gpt-oss-120b:free"


def test_openrouter_fails_then_gemini_succeeds(client, fake_llm, mock_test_key):
    _save_key(client, "openrouter")
    _save_key(client, "gemini")
    fake_llm["script"]("groq", ("raise_status", 429))
    fake_llm["script"]("openrouter", ("raise_status", 503))
    headers = auth_headers(client)

    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["provider"] == "gemini"
    assert data["model"] == "gemini-3.6-flash"
    assert [a["provider"] for a in data["attempts"]] == [
        "groq",
        "openrouter",
        "gemini",
    ]
    assert data["attempts"][1]["status"] == "failed"
    assert data["attempts"][2]["status"] == "success"


def test_fallback_with_permanent_error_skips_that_provider(client, fake_llm, mock_test_key):
    # OpenRouter's key is invalid (permanent) -> skipped, Gemini still tried.
    _save_key(client, "openrouter")
    _save_key(client, "gemini")
    fake_llm["script"]("groq", ("raise_status", 429))
    fake_llm["script"]("openrouter", ("raise_status", 401))
    headers = auth_headers(client)

    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["provider"] == "gemini"
    assert [a["provider"] for a in data["attempts"]] == [
        "groq",
        "openrouter",
        "gemini",
    ]


# -------------------------------------------------------- no fallback for these


def test_400_does_not_fall_back(client, fake_llm, mock_test_key):
    _save_key(client, "openrouter")
    fake_llm["script"]("groq", ("raise_status", 400))
    headers = auth_headers(client)

    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 400
    body = resp.json()
    assert body["detail"]
    # Only the primary was attempted; the error body still carries the attempt.
    assert [a["provider"] for a in body["attempts"]] == ["groq"]
    assert [c["provider"] for c in fake_llm["calls"]] == ["groq"]


def test_401_does_not_fall_back(client, fake_llm, mock_test_key):
    _save_key(client, "openrouter")
    fake_llm["script"]("groq", ("raise_status", 401))
    headers = auth_headers(client)

    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 502
    assert [a["provider"] for a in resp.json()["attempts"]] == ["groq"]
    assert [c["provider"] for c in fake_llm["calls"]] == ["groq"]


def test_403_does_not_fall_back(client, fake_llm, mock_test_key):
    _save_key(client, "openrouter")
    fake_llm["script"]("groq", ("raise_status", 403))
    headers = auth_headers(client)

    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 502
    assert [a["provider"] for a in resp.json()["attempts"]] == ["groq"]
    assert [c["provider"] for c in fake_llm["calls"]] == ["groq"]


def test_invalid_model_404_does_not_fall_back(client, fake_llm, mock_test_key):
    _save_key(client, "openrouter")
    fake_llm["script"]("groq", ("raise_status", 404))
    headers = auth_headers(client)

    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 400
    assert [c["provider"] for c in fake_llm["calls"]] == ["groq"]


# ------------------------------------------------------------ key handling


def test_missing_fallback_key_is_skipped(client, fake_llm, mock_test_key):
    # No OpenRouter/Gemini keys saved: the only candidate is the primary.
    fake_llm["script"]("groq", ("raise_status", 429))
    headers = auth_headers(client)

    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 429
    body = resp.json()
    assert [a["provider"] for a in body["attempts"]] == ["groq"]
    assert [c["provider"] for c in fake_llm["calls"]] == ["groq"]


def test_fallback_uses_the_providers_own_api_key(client, fake_llm, mock_test_key):
    _save_key(client, "openrouter", key="or-secret-key")
    fake_llm["script"]("groq", ("raise_status", 429))
    headers = auth_headers(client)

    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 200
    openrouter_call = fake_llm["calls"][1]
    assert openrouter_call["provider"] == "openrouter"
    assert openrouter_call["api_key"] == "or-secret-key"
    # The key must never appear in the response.
    assert "or-secret-key" not in resp.text


# ----------------------------------------------------------- all fail / limits


def test_all_fail_returns_clear_error_with_all_attempts(client, fake_llm, mock_test_key):
    _save_key(client, "openrouter")
    _save_key(client, "gemini")
    fake_llm["script"]("groq", ("raise_status", 429))
    fake_llm["script"]("openrouter", ("raise_status", 503))
    fake_llm["script"]("gemini", ("raise_status", 504))
    headers = auth_headers(client)

    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 502
    body = resp.json()
    assert body["detail"]
    assert [a["provider"] for a in body["attempts"]] == [
        "groq",
        "openrouter",
        "gemini",
    ]
    assert all(a["status"] == "failed" for a in body["attempts"])


def test_no_infinite_retry_and_no_duplicate_attempt(client, fake_llm, mock_test_key):
    _save_key(client, "openrouter")
    _save_key(client, "gemini")
    fake_llm["script"]("groq", ("raise_status", 429))
    fake_llm["script"]("openrouter", ("raise_status", 503))
    fake_llm["script"]("gemini", ("raise_status", 503))
    headers = auth_headers(client)

    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 502

    providers = [c["provider"] for c in fake_llm["calls"]]
    # Each provider attempted exactly once: no retries, no duplicates.
    assert providers == ["groq", "openrouter", "gemini"]
    assert len(providers) == len(set(providers))


# ---------------------------------------------------------------- cooldown


def test_cooldown_skips_rate_limited_provider_on_next_request(client, fake_llm, mock_test_key):
    _save_key(client, "openrouter")
    _save_key(client, "gemini")

    fake_llm["script"]("groq", ("raise_status", 429))
    headers = auth_headers(client)

    # First request: Groq 429 -> OpenRouter fallback succeeds (30s default
    # cooldown applied to Groq).
    resp1 = client.post("/chat", headers=headers, json={"message": "one"})
    assert resp1.status_code == 200, resp1.text
    assert resp1.json()["provider"] == "openrouter"

    # Second request (still inside the cooldown): Groq is skipped entirely
    # and OpenRouter answers as the first candidate.
    resp2 = client.post("/chat", headers=headers, json={"message": "two"})
    assert resp2.status_code == 200, resp2.text
    attempts2 = resp2.json()["attempts"]
    assert [a["provider"] for a in attempts2] == ["openrouter"]
    assert resp2.json()["fallback_used"] == (
        "Groq was temporarily unavailable. Response generated using Openrouter."
    )


def test_cooldown_is_not_permanent(client, fake_llm, mock_test_key):
    _save_key(client, "openrouter")

    fake_llm["script"]("groq", ("raise_status", 429))
    headers = auth_headers(client)
    resp1 = client.post("/chat", headers=headers, json={"message": "one"})
    assert resp1.status_code == 200

    # Once the cooldown expires, the primary is attempted again.
    from app.services import fallback_service

    fake_llm["script"]("groq", ("ok", "groq is back", None))
    fallback_service.cooldown.clear("groq")
    resp2 = client.post("/chat", headers=headers, json={"message": "two"})
    assert resp2.status_code == 200
    assert resp2.json()["provider"] == "groq"


# ------------------------------------------------------- settings untouched


def test_saved_provider_and_model_never_change_after_fallback(client, fake_llm, mock_test_key):
    headers = auth_headers(client)
    put = client.put(
        "/settings",
        headers=headers,
        json={"provider": "groq", "model": "llama-3.3-70b-versatile"},
    )
    assert put.status_code == 200

    _save_key(client, "openrouter")
    fake_llm["script"]("groq", ("raise_status", 429))
    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 200
    assert resp.json()["provider"] == "openrouter"

    # Saved settings are untouched: the response records the actual provider,
    # but the persisted selection is still Groq + llama-3.3-70b-versatile.
    get = client.get("/settings", headers=headers)
    assert get.json()["provider"] == "groq"
    assert get.json()["model"] == "llama-3.3-70b-versatile"


# --------------------------------------------------------------- usage detail


def test_usage_reflects_actual_provider_and_models(client, fake_llm, mock_test_key):
    _save_key(client, "openrouter")
    fake_llm["script"]("groq", ("raise_status", 429))
    headers = auth_headers(client)

    resp = client.post("/chat", headers=headers, json={"message": "Hi"})
    data = resp.json()

    # The success usage is attributed to the fallback provider/model.
    assert data["usage"] == {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
    assert data["provider"] == "openrouter"
    assert data["model"] == "openai/gpt-oss-120b:free"

    attempts = data["attempts"]
    assert attempts[0]["total_tokens"] == 0  # failed attempt records no tokens
    assert attempts[1]["total_tokens"] == 15  # success attempt records usage
    assert attempts[1]["provider"] == "openrouter"
    assert attempts[1]["model"] == "openai/gpt-oss-120b:free"


# ------------------------------------------------------------ engine details


class _FakeResp:
    def __init__(self, status_code, headers=None):
        self.status_code = status_code
        self.headers = headers or {}


def test_extract_retry_after_from_seconds_header():
    resp = _FakeResp(429, {"retry-after": "7"})
    exc = llm_service._map_error(429, resp)
    assert isinstance(exc, llm_service.RateLimitError)
    assert exc.retry_after == 7.0
    assert exc.http_status == 429


def test_extract_retry_after_from_reset_header():
    import time

    reset = int(time.time()) + 12
    resp = _FakeResp(429, {"x-ratelimit-reset": str(reset)})
    exc = llm_service._map_error(429, resp)
    assert 10 <= exc.retry_after <= 14


def test_map_error_categories():
    assert isinstance(llm_service._map_error(400), llm_service.BadRequestError)
    assert isinstance(llm_service._map_error(401), llm_service.InvalidAPIKeyError)
    assert isinstance(llm_service._map_error(403), llm_service.InvalidAPIKeyError)
    assert isinstance(llm_service._map_error(404), llm_service.InvalidModelError)
    assert isinstance(llm_service._map_error(429), llm_service.RateLimitError)
    assert isinstance(llm_service._map_error(500), llm_service.ProviderUnavailableError)
    assert llm_service._map_error(500).category == "overload"
    assert llm_service._map_error(502).category == "provider_unavailable"


def test_retry_after_flows_through_real_complete(monkeypatch):
    class _FakeClient:
        def post(self, url, json, headers):
            return _FakeResp(429, {"retry-after": "3"})

    monkeypatch.setattr(llm_service, "get_api_key", lambda: "test-key")
    monkeypatch.setattr(llm_service, "_get_client", lambda: _FakeClient())
    with pytest.raises(llm_service.RateLimitError) as excinfo:
        llm_service.complete([{"role": "user", "content": "hi"}])
    assert excinfo.value.retry_after == 3.0
