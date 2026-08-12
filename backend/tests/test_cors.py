"""CORS: allowed/dev origins receive access-control headers on preflight,
unknown origins are blocked, and config parsing trims whitespace and trailing
slashes while deduplicating entries."""

from app.config import Settings

STABLE_VERCEL_ORIGIN = "https://shanu977-nexuss-v5-1.vercel.app"


def test_stable_vercel_production_origin_is_allowed_by_default(client):
    assert STABLE_VERCEL_ORIGIN in Settings(_env_file=None).cors_origins_list
    resp = client.options(
        "/api-keys/test",
        headers={
            "Origin": STABLE_VERCEL_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert resp.headers.get("access-control-allow-origin") == STABLE_VERCEL_ORIGIN
    assert resp.headers.get("access-control-allow-credentials", "").lower() == "true"


def test_preflight_allowed_origin_gets_cors_headers(client):
    resp = client.options(
        "/api-keys/test",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert "access-control-allow-origin" in resp.headers
    assert (
        resp.headers["access-control-allow-origin"] == "http://localhost:3000"
    )
    assert resp.headers.get("access-control-allow-credentials", "").lower() == "true"
    allow_methods = resp.headers.get("access-control-allow-methods", "")
    assert allow_methods == "*" or "post" in allow_methods.lower()


def test_origin_gets_headers_on_real_request(client):
    resp = client.get("/health", headers={"Origin": "http://localhost:3000"})
    assert resp.status_code == 200
    assert (
        resp.headers["access-control-allow-origin"] == "http://localhost:3000"
    )


def test_preflight_unknown_origin_is_blocked(client):
    resp = client.options(
        "/api-keys/test",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert "access-control-allow-origin" not in resp.headers


def test_real_request_unknown_origin_gets_no_origin_header(client):
    resp = client.get("/health", headers={"Origin": "https://evil.example.com"})
    assert resp.status_code == 200
    assert "access-control-allow-origin" not in resp.headers


def test_cors_origins_trim_whitespace_trailing_slashes_and_dedupe():
    s = Settings(
        _env_file=None,
        environment="development",
        cors_origins=" http://localhost:3000/ , https://app.example.com/ , http://localhost:3000,  ,",
    )
    assert s.cors_origins_list == [
        "http://localhost:3000",
        "https://app.example.com",
    ]


def test_cors_origins_json_list_normalized():
    s = Settings(
        _env_file=None,
        environment="development",
        cors_origins='["http://localhost:3000", "https://app.example.com/"]',
    )
    assert s.cors_origins_list == [
        "http://localhost:3000",
        "https://app.example.com",
    ]


def test_cors_origins_exact_railway_json_env_value():
    """The JSON-list form of CORS_ORIGINS must resolve to the stable Vercel
    production origin. Setting the variable replaces the localhost defaults,
    so local development relies on the defaults which include localhost."""

    defaults = Settings(_env_file=None, environment="development")
    assert "http://localhost:3000" in defaults.cors_origins_list
    assert "https://shanu977-nexuss-v5-1.vercel.app" in defaults.cors_origins_list

    with_env_override = Settings(
        _env_file=None,
        environment="development",
        cors_origins='["https://shanu977-nexuss-v5-1.vercel.app"]',
    )
    assert with_env_override.cors_origins_list == [
        "https://shanu977-nexuss-v5-1.vercel.app",
    ]


def test_railway_plain_string_env_does_not_crash():
    """Railway supplies CORS_ORIGINS as a plain, non-JSON string. This must
    load without a SettingsError and resolve to exactly that origin."""
    s = Settings(
        _env_file=None,
        environment="development",
        cors_origins="https://shanu977-nexuss-v5-1.vercel.app",
    )
    assert s.cors_origins_list == ["https://shanu977-nexuss-v5-1.vercel.app"]


def test_railway_plain_string_env_preserves_localhost_override():
    """A comma-separated CORS_ORIGINS supplied by Railway (e.g. to include a
    staging domain) is split, trimmed, slash-stripped and deduplicated."""
    s = Settings(
        _env_file=None,
        environment="development",
        cors_origins=(
            " http://localhost:3000, https://shanu977-nexuss-v5-1.vercel.app/,"
            "https://shanu977-nexuss-v5-1.vercel.app "
        ),
    )
    assert s.cors_origins_list == [
        "http://localhost:3000",
        "https://shanu977-nexuss-v5-1.vercel.app",
    ]


def test_plain_string_env_from_process_environment():
    """Simulates the real Railway runtime path: CORS_ORIGINS as an actual OS
    environment variable (not a kwarg), loaded without JSON pre-decoding."""
    import os

    old = os.environ.get("CORS_ORIGINS")
    try:
        os.environ["CORS_ORIGINS"] = "https://shanu977-nexuss-v5-1.vercel.app"
        s = Settings(_env_file=None, environment="development")
        assert s.cors_origins_list == [
            "https://shanu977-nexuss-v5-1.vercel.app",
        ]
    finally:
        if old is None:
            os.environ.pop("CORS_ORIGINS", None)
        else:
            os.environ["CORS_ORIGINS"] = old


def test_railway_production_startup_with_plain_string_env(monkeypatch):
    """Mirror the exact Railway runtime that crashed with SettingsError:
    CORS_ORIGINS supplied as a plain (non-JSON) string from the process
    environment, ENVIRONMENT=production, and no .env file deployed. Settings
    must instantiate without a pydantic SettingsError and resolve exactly to
    the stable Vercel production origin."""
    monkeypatch.setenv("CORS_ORIGINS", "https://shanu977-nexuss-v5-1.vercel.app")
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv(
        "DATABASE_URL", "postgresql://user:pass@aws-1-ap-south-1.pooler.supabase.com:6543/postgres"
    )
    monkeypatch.setenv("API_KEY_ENCRYPTION_KEY", "k" * 64)
    monkeypatch.setenv("OTP_SECRET_KEY", "s" * 64)
    monkeypatch.setenv("FIREBASE_PROJECT_ID", "your-ai-chat-app")
    monkeypatch.setenv(
        "FIREBASE_CLIENT_EMAIL",
        "firebase-adminsdk-fbsvc@your-ai-chat-app.iam.gserviceaccount.com",
    )
    monkeypatch.setenv(
        "FIREBASE_PRIVATE_KEY",
        "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
    )

    s = Settings(_env_file=None)
    assert s.environment == "production"
    assert s.cors_origins_list == ["https://shanu977-nexuss-v5-1.vercel.app"]


def test_production_requires_secrets_when_enabled():
    """If Railway runs with ENVIRONMENT=production but is missing a required
    secret, Settings refuses to start (this crashes the app into a Railway 502,
    which the browser reports as a CORS failure)."""
    import pytest

    with pytest.raises(ValueError, match="Insecure production configuration"):
        Settings(
            _env_file=None,
            environment="production",
            cors_origins=["https://shanu977-nexuss-v5-1.vercel.app"],
        )