# pyrefly: ignore [missing-import]
import pytest

from app.services import llm_service
from app.services.llm_service import UsageInfo
from app.services.prompt_service import ContextLimitError, build_messages
from tests.conftest import auth_headers


@pytest.fixture
def fake_llm(monkeypatch):
    """Replace the real AI provider call with a deterministic fake."""
    captured = {}

    def _fake(messages, **kwargs):
        captured["messages"] = messages
        captured.update(kwargs)
        assert messages[0]["role"] == "system"
        assert messages[-1]["role"] == "user"
        usage = UsageInfo(input_tokens=10, output_tokens=5, total_tokens=15)
        return "Hello from the AI!", usage

    monkeypatch.setattr(llm_service, "complete", _fake)
    return captured


@pytest.fixture(autouse=True)
def mock_test_key(monkeypatch):
    """Mock API key validation so tests can save fake keys."""
    from app.services import api_key_service

    def _mock(provider, api_key):
        return {"valid": True, "message": f"{provider.capitalize()} API key is valid."}

    monkeypatch.setattr(api_key_service, "test_key", _mock)


# ---------------------------------------------------------------- chat flow


def test_chat_returns_reply(client, fake_llm):
    headers = auth_headers(client)
    resp = client.post("/chat", headers=headers, json={"message": "Hi there"})
    assert resp.status_code == 200, resp.text
    data = resp.json()

    assert data["reply"] == "Hello from the AI!"
    # The response echoes the exact provider/model used, matching the indicator.
    assert data["provider"] == "groq"
    assert data["model"] == "llama-3.3-70b-versatile"

    # Context sent to the LLM: system + new user message.
    assert fake_llm["messages"][-1] == {"role": "user", "content": "Hi there"}


def test_chat_filters_internal_reasoning_from_the_reply(client, monkeypatch):
    from app.services import llm_service
    from app.services.llm_service import UsageInfo

    def _reasoning(messages, **kwargs):
        usage = UsageInfo(input_tokens=10, output_tokens=5, total_tokens=15)
        return "\n".join(
            [
                " thinking",
                "The user's screen shows an error.",
                "This reasoning must never reach the client.",
                " response",
                "The fix is to install pandas.",
            ]
        ), usage

    monkeypatch.setattr(llm_service, "complete", _reasoning)
    headers = auth_headers(client)
    resp = client.post("/chat", headers=headers, json={"message": "Why does this fail?"})
    assert resp.status_code == 200, resp.text

    assert resp.json()["reply"] == "The fix is to install pandas."
    assert "thinking" not in resp.json()["reply"]
    assert "reasoning" not in resp.json()["reply"]


def test_chat_sends_client_history_for_context(client, fake_llm):
    headers = auth_headers(client)
    history = [
        {"role": "user", "content": "What is the capital of France?"},
        {"role": "assistant", "content": "Paris."},
    ]
    resp = client.post(
        "/chat", headers=headers, json={"message": "And of Spain?", "history": history}
    )
    assert resp.status_code == 200, resp.text

    msgs = fake_llm["messages"]
    assert msgs[0]["role"] == "system"
    assert msgs[1:-1] == history
    assert msgs[-1] == {"role": "user", "content": "And of Spain?"}


def test_chat_tolerates_empty_history_turns_and_drops_them(client, fake_llm):
    headers = auth_headers(client)
    history = [
        {"role": "user", "content": "What is the capital of France?"},
        # A reasoning-only reply previously produced an empty assistant turn;
        # it must not 422 the next message in the conversation.
        {"role": "assistant", "content": ""},
        {"role": "assistant", "content": "   "},
        {"role": "user", "content": "And of Spain?"},
    ]
    resp = client.post(
        "/chat", headers=headers, json={"message": "Also Portugal?", "history": history}
    )
    assert resp.status_code == 200, resp.text

    msgs = fake_llm["messages"]
    # Empty turns are dropped before the prompt is built.
    assert msgs[1:-1] == [
        {"role": "user", "content": "What is the capital of France?"},
        {"role": "user", "content": "And of Spain?"},
    ]
    assert msgs[-1] == {"role": "user", "content": "Also Portugal?"}


def test_chat_uses_selected_provider_and_key_from_supabase(client, fake_llm):
    headers = auth_headers(client)
    # Pick a Gemini model and verify the backend routes the request to it.
    resp = client.put(
        "/settings", headers=headers, json={"provider": "gemini", "model": "gemini-3.6-flash"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["model"] == "gemini-3.6-flash"

    # Without a stored key (Gemini has no server fallback) -> clear 503.
    resp = client.post("/chat", headers=headers, json={"message": "hi"})
    assert resp.status_code == 503
    assert "API key saved" in resp.json()["detail"]

    # Save the key to Supabase for the Gemini provider.
    resp = client.put(
        "/api-keys", headers=headers, json={"provider": "gemini", "api_key": "gem-key-123"}
    )
    assert resp.status_code == 200, resp.text
    status = resp.json()
    assert status["has_key"] is True
    # The raw key is never returned to the client.
    assert "gem-key-123" not in resp.text

    # Now /chat resolves the key from Supabase (no client-supplied key at all).
    resp = client.post("/chat", headers=headers, json={"message": "Hello Gemini"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["provider"] == "gemini"
    assert data["model"] == "gemini-3.6-flash"
    assert fake_llm["provider"] == "gemini"
    assert fake_llm["model"] == "gemini-3.6-flash"
    # The decrypted key is passed to the provider and never echoed back.
    assert fake_llm["api_key"] == "gem-key-123"
    assert "gem-key-123" not in str(client.get("/settings", headers=headers).text)
    assert "gem-key-123" not in str(client.get("/api-keys", headers=headers).text)


def test_chat_can_override_provider_and_model_per_request(client, fake_llm):
    headers = auth_headers(client)
    # No saved settings; the client chooses OpenRouter on this request.
    client.put(
        "/api-keys", headers=headers, json={"provider": "openrouter", "api_key": "or-key"}
    )
    resp = client.post(
        "/chat",
        headers=headers,
        json={
            "message": "hi",
            "provider": "openrouter",
            "model": "openai/gpt-oss-120b:free",
        },
    )
    assert resp.status_code == 200, resp.text
    assert fake_llm["provider"] == "openrouter"
    assert fake_llm["api_key"] == "or-key"
    assert fake_llm["model"] == "openai/gpt-oss-120b:free"


def test_chat_never_silently_swaps_an_invalid_explicit_model(client, fake_llm):
    headers = auth_headers(client)
    # A Groq model requested against the Gemini provider must be rejected, not
    # silently rewritten to some other model.
    resp = client.post(
        "/chat",
        headers=headers,
        json={"message": "hi", "provider": "gemini", "model": "llama-3.3-70b-versatile"},
    )
    assert resp.status_code == 400
    assert "not supported" in resp.json()["detail"].lower()
    # llm_service.complete was never called, so nothing was substituted.
    assert "provider" not in fake_llm


def test_chat_rejects_unsupported_provider_override(client, fake_llm):
    headers = auth_headers(client)
    resp = client.post("/chat", headers=headers, json={"message": "hi", "provider": "bogus"})
    assert resp.status_code == 400


# ------------------------------------------------------ screen-share analysis


SCREEN_IMAGE = "data:image/png;base64,iVBORw0KGgo="


def test_chat_with_image_routes_to_vision_model(client, fake_llm):
    headers = auth_headers(client)
    client.put(
        "/settings", headers=headers, json={"provider": "gemini", "model": "gemini-3.6-flash"}
    )
    client.put(
        "/api-keys", headers=headers, json={"provider": "gemini", "api_key": "gem-key-123"}
    )

    resp = client.post(
        "/chat",
        headers=headers,
        json={"message": "What error is on my screen?", "image": SCREEN_IMAGE},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["provider"] == "gemini"
    assert data["model"] == "gemini-3.6-flash"
    assert fake_llm["provider"] == "gemini"
    assert fake_llm["model"] == "gemini-3.6-flash"

    # The current user turn is multimodal: text + the single captured frame.
    last = fake_llm["messages"][-1]
    assert last["role"] == "user"
    assert isinstance(last["content"], list)
    parts = {p["type"]: p for p in last["content"]}
    assert parts["text"]["text"] == "What error is on my screen?"
    assert parts["image_url"]["image_url"]["url"] == SCREEN_IMAGE


def test_chat_with_image_on_text_model_uses_vision_default(client, fake_llm):
    headers = auth_headers(client)
    # Default Groq selection (llama-3.3-70b-versatile) is text-only. The frame
    # must be routed to a vision-capable model, never sent to the text model.
    resp = client.post(
        "/chat",
        headers=headers,
        json={"message": "What do you see?", "image": SCREEN_IMAGE},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["model"] == "qwen/qwen3.6-27b"
    assert fake_llm["model"] == "qwen/qwen3.6-27b"
    assert isinstance(fake_llm["messages"][-1]["content"], list)


def test_chat_with_image_keeps_history_text_only(client, fake_llm):
    headers = auth_headers(client)
    history = [
        {"role": "user", "content": "I am sharing my screen."},
        {"role": "assistant", "content": "Ask me anything about it."},
    ]
    resp = client.post(
        "/chat",
        headers=headers,
        json={"message": "Check this error", "history": history, "image": SCREEN_IMAGE},
    )
    assert resp.status_code == 200, resp.text
    msgs = fake_llm["messages"]
    # Prior turns stay plain text; only the current question carries the frame.
    assert msgs[1:-1] == history
    assert isinstance(msgs[-1]["content"], list)


def test_chat_with_image_on_openrouter_uses_vision_default(client, fake_llm):
    headers = auth_headers(client)
    client.put(
        "/api-keys", headers=headers, json={"provider": "openrouter", "api_key": "or-key"}
    )
    resp = client.post(
        "/chat",
        headers=headers,
        json={
            "message": "What do you see?",
            "provider": "openrouter",
            "model": "openai/gpt-oss-120b:free",
            "image": SCREEN_IMAGE,
        },
    )
    assert resp.status_code == 200, resp.text
    assert (
        resp.json()["model"] == "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
    )
    assert fake_llm["model"] == "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
    assert isinstance(fake_llm["messages"][-1]["content"], list)


def test_chat_with_image_rejects_non_data_url(client, fake_llm):
    headers = auth_headers(client)
    assert (
        client.post(
            "/chat",
            headers=headers,
            json={"message": "hi", "image": "https://example.com/screen.png"},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/chat",
            headers=headers,
            json={"message": "hi", "image": "data:text/plain;base64,YWJj"},
        ).status_code
        == 422
    )


def test_chat_with_image_errors_when_provider_has_no_vision_model(client, fake_llm, monkeypatch):
    from app.services import ai_service

    monkeypatch.setattr(ai_service, "VISION_MODELS", {})
    headers = auth_headers(client)
    resp = client.post(
        "/chat", headers=headers, json={"message": "hi", "image": SCREEN_IMAGE}
    )
    assert resp.status_code == 400
    assert "vision" in resp.json()["detail"].lower()
    # The provider call was never attempted.
    assert "provider" not in fake_llm


def test_chat_with_image_uses_selected_vision_capable_model(client, fake_llm):
    # A user-selected vision-capable model (gemini-2.5-pro) is honored instead
    # of being swapped for the provider's vision default (gemini-3.6-flash).
    headers = auth_headers(client)
    client.put(
        "/api-keys", headers=headers, json={"provider": "gemini", "api_key": "gem-key-123"}
    )
    resp = client.post(
        "/chat",
        headers=headers,
        json={
            "message": "Look at this",
            "provider": "gemini",
            "model": "gemini-2.5-pro",
            "image": SCREEN_IMAGE,
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["model"] == "gemini-2.5-pro"
    assert fake_llm["model"] == "gemini-2.5-pro"


def test_chat_requires_auth_headers(client, fake_llm):
    resp = client.post("/chat", json={"message": "hi"})
    assert resp.status_code == 401


def test_chat_rejects_empty_message(client, fake_llm):
    headers = auth_headers(client)
    assert client.post("/chat", headers=headers, json={"message": ""}).status_code == 422
    assert (
        client.post("/chat", headers=headers, json={"message": "   "}).status_code
        == 422
    )


def test_chat_rejects_oversized_history(client, fake_llm):
    headers = auth_headers(client)
    history = [{"role": "user", "content": "x"} for _ in range(101)]
    resp = client.post(
        "/chat", headers=headers, json={"message": "hi", "history": history}
    )
    assert resp.status_code == 422


# ------------------------------------------------------- workspace context


def test_chat_attaches_workspace_context(client, fake_llm):
    headers = auth_headers(client)
    resp = client.post(
        "/chat",
        headers=headers,
        json={
            "message": "Fix the auth bug",
            "workspace_context": (
                "Relevant files from the user's local workspace:\n\n"
                "### src/auth/login.ts\nimport { validateToken } from './token';\n\n"
                "### server/api.py\ndef login(payload):\n    return payload\n"
            ),
        },
    )
    assert resp.status_code == 200, resp.text
    msgs = fake_llm["messages"]
    # The workspace note is its own region, inserted before the current user
    # message; chat history stays separate.
    assert msgs[-2]["role"] == "system"
    assert "src/auth/login.ts" in msgs[-2]["content"]
    assert "workspace" in msgs[-2]["content"]
    assert msgs[-1] == {"role": "user", "content": "Fix the auth bug"}


def test_chat_workspace_context_includes_agent_change_guidance(client, fake_llm):
    """The workspace note tells the model it may propose edits via a fenced
    workspace-change block (which the client shows as a diff and only applies
    after approval), and that it must never claim to have modified files."""
    headers = auth_headers(client)
    resp = client.post(
        "/chat",
        headers=headers,
        json={
            "message": "Change the endpoint to /v2",
            "workspace_context": "### server/api.py\napp = FastAPI()\n",
        },
    )
    assert resp.status_code == 200, resp.text
    msgs = fake_llm["messages"]
    note = msgs[-2]["content"]
    assert "workspace-change" in note
    assert "Never claim you edited files yourself" in note


def test_chat_accepts_camelcase_workspace_context(client, fake_llm):
    """The frontend sends workspaceContext (camelCase); the schema alias must
    map it to workspace_context so the request is not rejected with a 422."""
    headers = auth_headers(client)
    resp = client.post(
        "/chat",
        headers=headers,
        json={
            "message": "Can you see my folder?",
            "workspaceContext": (
                "Workspace status from the user's connected Path workspace:\n\n"
                "The user's workspace \"MyProject\" is connected and 12 files "
                "are indexed."
            ),
        },
    )
    assert resp.status_code == 200, resp.text
    msgs = fake_llm["messages"]
    assert msgs[-2]["role"] == "system"
    assert "MyProject" in msgs[-2]["content"]
    assert msgs[-1] == {"role": "user", "content": "Can you see my folder?"}


def test_chat_workspace_context_keeps_history_and_frame_last(client, fake_llm):
    headers = auth_headers(client)
    history = [
        {"role": "user", "content": "I connected my project."},
        {"role": "assistant", "content": "Ask me anything about it."},
    ]
    resp = client.post(
        "/chat",
        headers=headers,
        json={
            "message": "Check this error",
            "history": history,
            "image": SCREEN_IMAGE,
            "workspace_context": "### src/app.ts\nconsole.log('hi');\n",
        },
    )
    assert resp.status_code == 200, resp.text
    msgs = fake_llm["messages"]
    # History stays text-only and in order; the workspace note sits right
    # before the multimodal current user message (which keeps the frame last).
    assert msgs[1:3] == history
    assert msgs[-2]["role"] == "system"
    assert "src/app.ts" in msgs[-2]["content"]
    assert isinstance(msgs[-1]["content"], list)


def test_chat_ignores_blank_workspace_context(client, fake_llm):
    headers = auth_headers(client)
    resp = client.post(
        "/chat", headers=headers, json={"message": "hi", "workspace_context": "   "}
    )
    assert resp.status_code == 200, resp.text
    # Only the base system prompt and the user message; no workspace note.
    assert [m["role"] for m in fake_llm["messages"]] == ["system", "user"]


def test_chat_rejects_oversized_workspace_context(client, fake_llm):
    headers = auth_headers(client)
    resp = client.post(
        "/chat",
        headers=headers,
        json={"message": "hi", "workspace_context": "x" * 200_000},
    )
    assert resp.status_code == 422


# ------------------------------------------------------------- error handling


def test_chat_missing_api_key_returns_503(client, monkeypatch):
    from app.services.llm_service import MissingAPIKeyError

    def _raise_missing(_messages, **_kwargs):
        raise MissingAPIKeyError()

    monkeypatch.setattr(llm_service, "complete", _raise_missing)

    headers = auth_headers(client)
    resp = client.post("/chat", headers=headers, json={"message": "hi"})
    assert resp.status_code == 503
    assert "API key" in resp.json()["detail"]


def test_chat_provider_failure_returns_502(client, monkeypatch):
    from app.services.llm_service import ProviderUnavailableError

    def _raise_provider(_messages, **_kwargs):
        raise ProviderUnavailableError()

    monkeypatch.setattr(llm_service, "complete", _raise_provider)

    headers = auth_headers(client)
    resp = client.post("/chat", headers=headers, json={"message": "hi"})
    assert resp.status_code == 502


def test_chat_rate_limit_returns_429(client, monkeypatch):
    from app.services.llm_service import RateLimitError

    def _raise_rate(_messages, **_kwargs):
        raise RateLimitError()

    monkeypatch.setattr(llm_service, "complete", _raise_rate)

    headers = auth_headers(client)
    resp = client.post("/chat", headers=headers, json={"message": "hi"})
    assert resp.status_code == 429


# ------------------------------------------------ provider response handling


class _FakeResp:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


class _FakeClient:
    def __init__(self, resp):
        self._resp = resp

    def post(self, url, json, headers, **kwargs):
        return self._resp


def _fake_transport(monkeypatch, resp, api_key="test-key"):
    monkeypatch.setattr(llm_service, "get_api_key", lambda: api_key)
    monkeypatch.setattr(llm_service, "_get_client", lambda: _FakeClient(resp))


def test_complete_null_content_returns_controlled_error(monkeypatch):
    _fake_transport(
        monkeypatch, _FakeResp(200, {"choices": [{"message": {"content": None}}]})
    )
    with pytest.raises(llm_service.EmptyResponseError):
        llm_service.complete([{"role": "user", "content": "hi"}])


def test_complete_empty_content_returns_controlled_error(monkeypatch):
    _fake_transport(
        monkeypatch, _FakeResp(200, {"choices": [{"message": {"content": "   "}}]})
    )
    with pytest.raises(llm_service.EmptyResponseError):
        llm_service.complete([{"role": "user", "content": "hi"}])


def test_complete_parses_valid_content(monkeypatch):
    _fake_transport(
        monkeypatch,
        _FakeResp(200, {"choices": [{"message": {"content": "  hello world  "}}]}),
    )
    reply, usage = llm_service.complete([{"role": "user", "content": "hi"}])
    assert reply == "hello world"
    assert usage.input_tokens == 0
    assert usage.output_tokens == 0
    assert usage.total_tokens == 0


def test_complete_400_maps_to_bad_request_not_unavailable(monkeypatch):
    _fake_transport(monkeypatch, _FakeResp(400))
    with pytest.raises(llm_service.BadRequestError):
        llm_service.complete([{"role": "user", "content": "hi"}])


def test_chat_null_provider_response_returns_502(client, monkeypatch):
    _fake_transport(
        monkeypatch, _FakeResp(200, {"choices": [{"message": {"content": None}}]})
    )
    headers = auth_headers(client)
    resp = client.post("/chat", headers=headers, json={"message": "hi"})
    assert resp.status_code == 502
    assert "empty response" in resp.json()["detail"].lower()


def test_chat_provider_bad_request_returns_400(client, monkeypatch):
    _fake_transport(monkeypatch, _FakeResp(400))
    headers = auth_headers(client)
    resp = client.post("/chat", headers=headers, json={"message": "hi"})
    assert resp.status_code == 400
    assert "provider" in resp.json()["detail"].lower()


# ------------------------------------------------ legacy conversation CRUD
# The /conversations endpoints remain available (the app no longer uses them:
# chat history is owned by the client), so their basic contract stays tested.


def test_conversation_crud(client):
    headers = auth_headers(client)

    created = client.post(
        "/conversations", headers=headers, json={"title": "One"}
    ).json()
    assert created["title"] == "One"
    assert created["id"]

    lst = client.get("/conversations", headers=headers).json()
    assert len(lst) == 1

    detail = client.get(
        f"/conversations/{created['id']}", headers=headers
    ).json()
    assert detail["messages"] == []

    assert (
        client.delete(f"/conversations/{created['id']}", headers=headers).status_code
        == 204
    )
    assert client.get("/conversations", headers=headers).json() == []
    assert (
        client.get(f"/conversations/{created['id']}", headers=headers).status_code
        == 404
    )
    assert (
        client.delete(f"/conversations/{created['id']}", headers=headers).status_code
        == 404
    )


def test_conversation_rename(client):
    headers = auth_headers(client)
    created = client.post(
        "/conversations", headers=headers, json={"title": "Old title"}
    ).json()

    resp = client.patch(
        f"/conversations/{created['id']}", headers=headers, json={"title": "New title"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["title"] == "New title"

    lst = client.get("/conversations", headers=headers).json()
    assert lst[0]["title"] == "New title"

    other = client.post(
        "/conversations", headers=headers, json={"title": "Other"}
    ).json()
    assert other["id"] != created["id"]


def test_conversation_list_scoped_to_user(client):
    headers = auth_headers(client)

    client.post("/conversations", headers=headers, json={"title": "A"})
    client.post("/conversations", headers=headers, json={"title": "B"})

    lst = client.get("/conversations", headers=headers).json()
    assert len(lst) == 2


# ------------------------------------------------- context size protection


def _token_total(msgs):
    from app.services.prompt_service import estimate_tokens

    return sum(estimate_tokens(m["content"]) for m in msgs)


def test_build_messages_trims_oldest_history_when_oversized():
    history = [{"role": "user", "content": "x" * 100} for _ in range(10)]
    msgs = build_messages(history, "question", max_tokens=150)

    assert msgs[0]["role"] == "system"
    assert msgs[-1]["content"] == "question"
    assert _token_total(msgs) <= 150
    # Some oldest history entries were dropped, but the message still fits
    assert 3 < len(msgs) < 12


def test_build_messages_keeps_newest_history_first():
    history = [
        {"role": "user", "content": f"msg-{i} " * 40} for i in range(5)
    ]
    msgs = build_messages(history, "tail", max_tokens=200)
    history_msgs = [m["content"] for m in msgs if m["role"] != "system"][:-1]
    # the last (newest) history message must survive trimming
    assert any("msg-4" in content for content in history_msgs)


def test_build_messages_raises_when_message_alone_exceeds_budget():
    with pytest.raises(ContextLimitError):
        build_messages([], "x" * 1000, max_tokens=100)
