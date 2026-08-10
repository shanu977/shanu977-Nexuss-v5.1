import json
from functools import lru_cache
from pathlib import Path
from typing import List

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Project root = directory containing the `app` package (i.e. backend/).
# Used so relative credential paths always resolve against the backend
# project directory, regardless of the process working directory.
BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # "development" (default) or "production". Production enforces that real
    # secrets are provided and refuses to start with weak defaults.
    environment: str = "development"

    database_url: str = "sqlite:///./chatbot_local.db"
    database_sslmode: str = "require"
    db_pool_size: int = 5
    db_max_overflow: int = 10
    db_pool_recycle: int = 1800
    # Seconds to wait before giving up on establishing a PostgreSQL connection.
    # psycopg2 otherwise blocks forever on an unreachable host, which can stall
    # background workers (e.g. retention cleanup) during a transient outage.
    database_connect_timeout: int = 10

    # Secret used to encrypt user API keys at rest (Fernet). A long random
    # string is required in production; development falls back to a local key.
    api_key_encryption_key: str = Field(
        default="", validation_alias="API_KEY_ENCRYPTION_KEY"
    )

    # Firebase Admin SDK credentials
    firebase_project_id: str = Field(default="", validation_alias="FIREBASE_PROJECT_ID")
    firebase_client_email: str = Field(default="", validation_alias="FIREBASE_CLIENT_EMAIL")
    firebase_private_key: str = Field(default="", validation_alias="FIREBASE_PRIVATE_KEY")
    firebase_credentials_path: str = Field(default="", validation_alias="FIREBASE_CREDENTIALS_PATH")

    # Secret key used for signing OTP email verification tickets
    otp_secret_key: str = Field(default="dev-otp-secret-key-change-in-prod", validation_alias="OTP_SECRET_KEY")

    # SMTP settings for delivering OTP verification emails. Credentials are
    # read from the environment and never hardcoded, logged, or exposed to the
    # client. When unset, delivery is disabled and /auth/otp/send returns a
    # safe error instead of claiming success.
    smtp_host: str = Field(default="", validation_alias="SMTP_HOST")
    smtp_port: int = Field(default=587, validation_alias="SMTP_PORT")
    smtp_username: str = Field(default="", validation_alias="SMTP_USERNAME")
    smtp_password: str = Field(default="", validation_alias="SMTP_PASSWORD")
    smtp_from_email: str = Field(default="", validation_alias="SMTP_FROM_EMAIL")
    smtp_from_name: str = Field(default="", validation_alias="SMTP_FROM_NAME")

    # Only trust X-Forwarded-For when behind a proxy that overwrites it
    # (e.g. nginx/Railway). Keep False otherwise so clients can't spoof
    # their identity to bypass the rate limiter.
    trust_proxy_headers: bool = False

    retention_days: int = 4
    cleanup_interval_hours: int = 1

    # AI provider (server-side, dev). Never commit a real key.
    groq_api_key: str = Field(default="gsk_dev_default_key", validation_alias="GROQ_API_KEY")
    ai_model: str = "llama-3.3-70b-versatile"
    groq_base_url: str = "https://api.groq.com/openai/v1"
    ai_max_tokens: int = 1024
    # Seconds a provider is skipped after a rate limit (used when the provider
    # does not return a Retry-After / reset hint).
    ai_fallback_cooldown_seconds: int = 30

    cors_origins: List[str] = [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:8080",
    ]

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, v):
        if isinstance(v, str):
            if v.startswith("["):
                try:
                    return json.loads(v)
                except Exception:
                    pass
            return [item.strip() for item in v.split(",") if item.strip()]
        return v

    @field_validator("firebase_credentials_path", mode="after")
    @classmethod
    def resolve_firebase_credentials_path(cls, v):
        """Resolve a relative credentials path against the backend project
        directory (not the process CWD). Absolute and root-relative paths
        (e.g. /path/to/key.json) are passed through unchanged."""
        if not v:
            return v
        p = Path(v)
        if p.is_absolute() or v.startswith(("/", "\\")):
            return v
        return str(BACKEND_DIR / v)

    @model_validator(mode="after")
    def enforce_production_security(self):
        """Fail fast in production instead of silently running with insecure
        defaults. In development the dev fallbacks are fine for local use."""
        if self.environment != "production":
            return self

        problems: List[str] = []

        if not self.database_url or self.database_url.startswith("sqlite"):
            problems.append(
                "DATABASE_URL must point to a PostgreSQL database in production "
                "(the bundled SQLite fallback is development-only)."
            )

        if not self.api_key_encryption_key:
            problems.append(
                "API_KEY_ENCRYPTION_KEY must be set to a long random string "
                "used to encrypt user API keys at rest."
            )

        if (
            not self.otp_secret_key
            or self.otp_secret_key == "dev-otp-secret-key-change-in-prod"
        ):
            problems.append(
                "OTP_SECRET_KEY must be set to a strong random secret in "
                "production (it signs the email-verification JWT that lets a "
                "user set a password on an account)."
            )

        has_firebase_creds = bool(
            self.firebase_credentials_path
            or (
                self.firebase_project_id
                and self.firebase_client_email
                and self.firebase_private_key
            )
        )
        if not has_firebase_creds:
            problems.append(
                "Firebase Admin credentials are required in production "
                "(FIREBASE_CREDENTIALS_PATH or FIREBASE_PROJECT_ID + "
                "FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY). Without them "
                "every authenticated request will fail."
            )

        local_origins = [
            o for o in self.cors_origins
            if "localhost" in o or "127.0.0.1" in o
        ]
        if local_origins:
            problems.append(
                f"CORS_ORIGINS contains localhost/127.0.0.1 entries "
                f"which are invalid in production: {local_origins}"
            )

        if problems:
            raise ValueError(
                "Insecure production configuration. Fix the following before starting:\n  - "
                + "\n  - ".join(problems)
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
