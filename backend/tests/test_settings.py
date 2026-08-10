from tests.conftest import auth_headers


def test_settings_default_and_update(client):
    headers = auth_headers(client)
    get = client.get("/settings", headers=headers)
    assert get.status_code == 200
    body = get.json()
    assert body["theme"] == "light"
    assert body["language"] == "en"
    assert body["provider"] == "groq"
    assert body["model"] == "llama-3.3-70b-versatile"

    # Adding settings again must not create duplicates
    get2 = client.get("/settings", headers=headers)
    assert get2.status_code == 200

    put = client.put("/settings", headers=headers, json={"theme": "dark", "provider": "gemini"})
    assert put.status_code == 200
    updated = put.json()
    assert updated["theme"] == "dark"
    assert updated["provider"] == "gemini"
    assert updated["language"] == "en"
    # Switching provider resets the model to that provider's default.
    assert updated["model"] == "gemini-3.6-flash"


def test_settings_saves_model_choice(client):
    headers = auth_headers(client)
    put = client.put(
        "/settings", headers=headers, json={"provider": "groq", "model": "llama-3.1-8b-instant"}
    )
    assert put.status_code == 200
    assert put.json()["model"] == "llama-3.1-8b-instant"

    # Persists on a fresh read.
    get = client.get("/settings", headers=headers)
    assert get.status_code == 200
    assert get.json()["model"] == "llama-3.1-8b-instant"


def test_settings_rejects_model_not_supported_by_provider(client):
    headers = auth_headers(client)
    resp = client.put(
        "/settings", headers=headers, json={"provider": "groq", "model": "gemini-2.5-pro"}
    )
    assert resp.status_code == 422

    # Changing only the model must validate against the CURRENT provider.
    resp2 = client.put("/settings", headers=headers, json={"model": "qwen/qwen3"})
    assert resp2.status_code == 422


def test_settings_accepts_each_providers_new_models(client):
    headers = auth_headers(client)
    # Groq's expanded lineup
    for model in [
        "llama-3.1-8b-instant",
        "llama-3.3-70b-versatile",
        "openai/gpt-oss-20b",
        "openai/gpt-oss-120b",
        "qwen/qwen3.6-27b",
        "groq/compound",
        "groq/compound-mini",
    ]:
        resp = client.put(
            "/settings", headers=headers, json={"provider": "groq", "model": model}
        )
        assert resp.status_code == 200, f"{model}: {resp.text}"
        assert resp.json()["model"] == model

    # Gemini's current lineup (free-tier models)
    for model in [
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-2.5-pro",
        "gemma-4",
    ]:
        resp = client.put(
            "/settings", headers=headers, json={"provider": "gemini", "model": model}
        )
        assert resp.status_code == 200, f"{model}: {resp.text}"

    # OpenRouter free models
    for model in [
        "openai/gpt-oss-120b:free",
        "openai/gpt-oss-20b:free",
        "nvidia/nemotron-3-ultra:free",
        "nvidia/nemotron-3-super:free",
        "nex-agi/nex-n2-pro:free",
        "liquid/lfm2.5-1.2b-instruct:free",
        "openrouter/free",
    ]:
        resp = client.put(
            "/settings", headers=headers, json={"provider": "openrouter", "model": model}
        )
        assert resp.status_code == 200, f"{model}: {resp.text}"


def test_settings_rejects_removed_models(client):
    headers = auth_headers(client)
    # Models removed from the lineup must no longer be accepted.
    removed = [
        ("gemini", "gemini-2.5-flash"),
        ("openrouter", "deepseek/deepseek-chat-v3"),
        ("openrouter", "qwen/qwen3"),
    ]
    for provider, model in removed:
        resp = client.put(
            "/settings", headers=headers, json={"provider": provider, "model": model}
        )
        assert resp.status_code == 422, f"{provider}/{model}: {resp.text}"


def test_settings_requires_auth_headers(client):
    assert client.get("/settings").status_code == 401
    assert client.put("/settings", json={"theme": "dark"}).status_code == 401


def test_settings_rejects_unknown_fields(client):
    headers = auth_headers(client)
    resp = client.put("/settings", headers=headers, json={"bogus": 1})
    assert resp.status_code == 422


def test_settings_null_field_is_ignored_not_500(client):
    headers = auth_headers(client)
    resp = client.put("/settings", headers=headers, json={"theme": None})
    assert resp.status_code == 200
    assert resp.json()["theme"] == "light"
    assert resp.json()["language"] == "en"
