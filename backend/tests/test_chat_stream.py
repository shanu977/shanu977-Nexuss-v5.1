# pyrefly: ignore [missing-import]
import json
import threading

import pytest

from app.services import llm_service
from app.services.llm_service import UsageInfo
from tests.conftest import auth_headers


def _parse_events(resp_text):
    """Parse a raw SSE body into a list of event dicts (in arrival order)."""
    events = []
    for line in resp_text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            events.append(json.loads(line[5:].strip()))
    return events


def _chunk_text(events):
    return "".join(e["content"] for e in events if e["type"] == "chunk")


@pytest.fixture
def mock_test_key(monkeypatch):
    """Allow saving fake API keys for any provider (no network calls)."""
    from app.services import api_key_service

    def _mock(provider, api_key):
        return {"valid": True, "message": f"{provider.capitalize()} API key is valid."}

    monkeypatch.setattr(api_key_service, "test_key", _mock)


@pytest.fixture
def fake_stream(monkeypatch):
    """Replace llm_service.complete_stream with a per-provider scriptable fake.

    `script` maps provider -> list of items: strings become (delta, None)
    yields, exceptions are raised mid-stream (as they would be by the real
    generator), and a final (None, UsageInfo) is appended automatically.
    """
    calls = []
    script = {}

    def _set(provider, items):
        script[provider] = items

    def _make_generator(items):
        def gen():
            for item in items:
                if isinstance(item, BaseException):
                    raise item
                yield item, None
            yield None, UsageInfo(input_tokens=10, output_tokens=5, total_tokens=15)

        return gen()

    def _fake(messages, **kwargs):
        provider = kwargs["provider"]
        calls.append({**kwargs, "messages": messages})
        items = script.get(provider)
        if items is None:
            items = ["Hello from the AI!"]
        return _make_generator(items)

    monkeypatch.setattr(llm_service, "complete_stream", _fake)
    return {"calls": calls, "script": _set}


def _save_key(client, provider, key="key-123"):
    headers = auth_headers(client)
    resp = client.put(
        "/api-keys", headers=headers, json={"provider": provider, "api_key": key}
    )
    assert resp.status_code == 200, resp.text


# -------------------------------------------------------------- happy path


def test_chat_stream_is_sse_with_chunks_then_usage(client, fake_stream):
    fake_stream["script"]("groq", ["Hello", " world"])
    headers = auth_headers(client)

    resp = client.post("/chat/stream", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert "no-cache" in resp.headers["cache-control"]

    events = _parse_events(resp.text)
    assert [e["type"] for e in events] == ["chunk", "chunk", "usage"]
    assert _chunk_text(events) == "Hello world"

    usage = events[-1]
    assert usage["usage"] == {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
    assert usage["provider"] == "groq"
    assert usage["model"] == "openai/gpt-oss-120b"
    assert usage["fallback_used"] is None
    assert [a["provider"] for a in usage["attempts"]] == ["groq"]


def test_chat_stream_first_chunk_arrives_before_completion(client, fake_stream, monkeypatch):
    """The first chunk is written into the response while the provider is still
    working: the fake generator blocks until the client has read that chunk,
    and the request only completes once the provider is released."""
    chunk_sent = threading.Event()
    release_rest = threading.Event()

    def _blocking(messages, **kwargs):
        def gen():
            yield "First", None
            chunk_sent.set()
            if not release_rest.wait(timeout=10):
                raise RuntimeError("client never read the first chunk")
            yield " rest", None
            yield None, UsageInfo(input_tokens=1, output_tokens=2, total_tokens=3)

        return gen()

    monkeypatch.setattr(llm_service, "complete_stream", _blocking)
    headers = auth_headers(client)

    result = {}

    def _read():
        result["resp"] = client.post(
            "/chat/stream", headers=headers, json={"message": "Hi"}
        )

    worker = threading.Thread(target=_read)
    worker.start()
    try:
        # The provider produced the first chunk and the server forwarded it into
        # the stream while the provider is still blocked on the rest.
        assert chunk_sent.wait(timeout=10), "first chunk was never generated"
        # The client request is still in flight: the full response is NOT ready
        # yet even though the first chunk has already been written.
        assert worker.is_alive(), "response completed before the provider finished"
        release_rest.set()
    finally:
        release_rest.set()
        worker.join(timeout=10)

    resp = result["resp"]
    assert resp.status_code == 200, resp.text
    events = _parse_events(resp.text)
    assert [e["type"] for e in events] == ["chunk", "chunk", "usage"]
    assert _chunk_text(events) == "First rest"


def test_chat_stream_filters_reasoning_across_chunk_boundaries(client, fake_stream):
    fake_stream["script"](
        "groq",
        [
            " think",
            "ing\ninternal reasoning\n",
            " response\nFinal",
            " answer.",
        ],
    )
    headers = auth_headers(client)

    resp = client.post("/chat/stream", headers=headers, json={"message": "why?"})
    assert resp.status_code == 200, resp.text

    events = _parse_events(resp.text)
    assert _chunk_text(events) == "Final answer."
    for e in events:
        assert "thinking" not in e.get("content", "").lower()
        assert "internal" not in e.get("content", "").lower()


def test_chat_stream_routes_to_selected_provider(client, fake_stream):
    _save_key(client, "openrouter")
    headers = auth_headers(client)
    resp = client.post(
        "/chat/stream",
        headers=headers,
        json={
            "message": "hi",
            "provider": "openrouter",
            "model": "openai/gpt-oss-120b:free",
        },
    )
    assert resp.status_code == 200, resp.text

    events = _parse_events(resp.text)
    assert events[-1]["type"] == "usage"
    assert events[-1]["provider"] == "openrouter"
    assert events[-1]["model"] == "openai/gpt-oss-120b:free"
    assert fake_stream["calls"][0]["provider"] == "openrouter"
    assert fake_stream["calls"][0]["api_key"] == "key-123"


# ---------------------------------------------------------------- fallback


def test_chat_stream_falls_back_when_primary_fails_before_content(client, fake_stream, mock_test_key):
    _save_key(client, "openrouter")
    fake_stream["script"]("groq", [llm_service.RateLimitError()])
    headers = auth_headers(client)

    resp = client.post("/chat/stream", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 200, resp.text

    events = _parse_events(resp.text)
    assert _chunk_text(events) == "Hello from the AI!"
    usage = events[-1]
    assert usage["type"] == "usage"
    assert usage["provider"] == "openrouter"
    assert usage["fallback_used"] == (
        "Groq was temporarily unavailable. Response generated using Openrouter."
    )
    assert [a["provider"] for a in usage["attempts"]] == ["groq", "openrouter"]
    assert usage["attempts"][0]["status"] == "failed"
    assert usage["attempts"][0]["http_status"] == 429
    assert usage["attempts"][1]["status"] == "success"
    assert [c["provider"] for c in fake_stream["calls"]] == ["groq", "openrouter"]


def test_chat_stream_permanent_error_does_not_fall_back(client, fake_stream, mock_test_key):
    _save_key(client, "openrouter")
    fake_stream["script"]("groq", [llm_service.BadRequestError()])
    headers = auth_headers(client)

    resp = client.post("/chat/stream", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 200, resp.text

    events = _parse_events(resp.text)
    err = [e for e in events if e["type"] == "error"]
    assert len(err) == 1
    assert err[0]["status"] == 400
    assert err[0]["partial"] is False
    assert [a["provider"] for a in err[0]["attempts"]] == ["groq"]
    assert [c["provider"] for c in fake_stream["calls"]] == ["groq"]


def test_chat_stream_mid_stream_failure_keeps_partial_and_does_not_fall_back(
    client, fake_stream, mock_test_key
):
    """Once content has been streamed, a provider failure must NOT fall back:
    a disjoint fallback reply could not be merged with the partial text."""
    _save_key(client, "openrouter")
    fake_stream["script"](
        "groq", ["Partial answer ", llm_service.ProviderUnavailableError()]
    )
    headers = auth_headers(client)

    resp = client.post("/chat/stream", headers=headers, json={"message": "Hi"})
    assert resp.status_code == 200, resp.text

    events = _parse_events(resp.text)
    assert _chunk_text(events) == "Partial answer "
    err = [e for e in events if e["type"] == "error"]
    assert len(err) == 1
    assert err[0]["status"] == 502
    assert err[0]["partial"] is True
    assert [a["provider"] for a in err[0]["attempts"]] == ["groq"]
    # Only the primary was contacted; no fallback after partial content.
    assert [c["provider"] for c in fake_stream["calls"]] == ["groq"]


# ------------------------------------------------------------------ errors


def test_chat_stream_requires_auth(client, fake_stream):
    resp = client.post("/chat/stream", json={"message": "hi"})
    assert resp.status_code == 401


def test_chat_stream_rejects_empty_message(client, fake_stream):
    headers = auth_headers(client)
    assert (
        client.post("/chat/stream", headers=headers, json={"message": ""}).status_code
        == 422
    )


def test_chat_stream_rejects_invalid_model_override(client, fake_stream):
    headers = auth_headers(client)
    resp = client.post(
        "/chat/stream",
        headers=headers,
        json={"message": "hi", "provider": "gemini", "model": "llama-3.3-70b-versatile"},
    )
    assert resp.status_code == 400
    assert "not supported" in resp.json()["detail"].lower()
    assert fake_stream["calls"] == []


def test_chat_stream_empty_provider_response_emits_error_event(client, monkeypatch):
    from app.services.llm_service import EmptyResponseError

    def _empty(messages, **kwargs):
        def gen():
            raise EmptyResponseError()

        return gen()

    monkeypatch.setattr(llm_service, "complete_stream", _empty)
    headers = auth_headers(client)

    resp = client.post("/chat/stream", headers=headers, json={"message": "hi"})
    assert resp.status_code == 200, resp.text

    events = _parse_events(resp.text)
    assert [e["type"] for e in events] == ["error"]
    assert events[0]["status"] == 502
    assert "empty" in events[0]["message"].lower()
