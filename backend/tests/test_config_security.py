"""Security: Settings must refuse insecure production configuration and fail
safely when secrets are missing. Development stays permissive."""

import pytest

from app.config import Settings


def _settings(**kwargs) -> Settings:
    # _env_file=None keeps tests hermetic: never load backend/.env.
    return Settings(_env_file=None, **kwargs)


def test_development_runs_without_secrets():
    s = _settings(environment="development")
    assert s.environment == "development"


def test_production_rejects_sqlite_database_url():
    with pytest.raises(ValueError, match="DATABASE_URL"):
        _settings(
            environment="production",
            database_url="sqlite:///./chatbot_local.db",
        )


def test_production_rejects_missing_database_url():
    with pytest.raises(ValueError, match="DATABASE_URL"):
        _settings(
            environment="production",
            database_url="",
        )


def test_production_rejects_missing_api_key_encryption_key():
    with pytest.raises(ValueError, match="API_KEY_ENCRYPTION_KEY"):
        _settings(
            environment="production",
            database_url="postgresql://user:pass@db.example.com/db",
        )


def test_production_rejects_localhost_cors_origins():
    with pytest.raises(ValueError, match="CORS_ORIGINS"):
        _settings(
            environment="production",
            database_url="postgresql://user:pass@db.example.com/db",
            API_KEY_ENCRYPTION_KEY="super-secret-encryption-key-value",
            cors_origins=["http://localhost:3000"],
        )


def test_production_accepts_strong_configuration():
    s = _settings(
        environment="production",
        database_url="postgresql://user:pass@db.example.com/db",
        API_KEY_ENCRYPTION_KEY="super-secret-encryption-key-value",
        OTP_SECRET_KEY="super-secret-otp-signing-key-value",
        FIREBASE_PROJECT_ID="my-project",
        FIREBASE_CLIENT_EMAIL="firebase-adminsdk@my-project.iam.gserviceaccount.com",
        FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
        cors_origins=["https://myapp.com"],
    )
    assert s.api_key_encryption_key == "super-secret-encryption-key-value"


def test_production_rejects_default_otp_secret_key():
    with pytest.raises(ValueError, match="OTP_SECRET_KEY"):
        _settings(
            environment="production",
            database_url="postgresql://user:pass@db.example.com/db",
            API_KEY_ENCRYPTION_KEY="super-secret-encryption-key-value",
            cors_origins=["https://myapp.com"],
        )


def test_production_rejects_missing_firebase_admin_credentials():
    with pytest.raises(ValueError, match="Firebase Admin credentials"):
        _settings(
            environment="production",
            database_url="postgresql://user:pass@db.example.com/db",
            API_KEY_ENCRYPTION_KEY="super-secret-encryption-key-value",
            OTP_SECRET_KEY="super-secret-otp-signing-key-value",
            cors_origins=["https://myapp.com"],
        )


def test_production_accepts_firebase_credentials_path_only():
    s = _settings(
        environment="production",
        database_url="postgresql://user:pass@db.example.com/db",
        API_KEY_ENCRYPTION_KEY="super-secret-encryption-key-value",
        OTP_SECRET_KEY="super-secret-otp-signing-key-value",
        FIREBASE_CREDENTIALS_PATH="/path/to/serviceAccountKey.json",
        cors_origins=["https://myapp.com"],
    )
    assert s.firebase_credentials_path == "/path/to/serviceAccountKey.json"
