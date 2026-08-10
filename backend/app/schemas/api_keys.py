from pydantic import BaseModel, Field, field_validator

from .settings import ALLOWED_PROVIDERS


class ApiKeyUpsert(BaseModel):
    provider: str
    api_key: str = Field(min_length=1, max_length=2000)

    model_config = {"extra": "forbid"}

    @field_validator("provider")
    @classmethod
    def provider_is_supported(cls, v: str) -> str:
        if v not in ALLOWED_PROVIDERS:
            raise ValueError(
                f"provider must be one of {', '.join(ALLOWED_PROVIDERS)}"
            )
        return v

    @field_validator("api_key")
    @classmethod
    def api_key_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("API key must not be empty")
        return v


class ApiKeyTest(BaseModel):
    """Request body for testing an API key against a provider."""

    provider: str
    api_key: str = Field(min_length=1, max_length=2000)

    model_config = {"extra": "forbid"}

    @field_validator("provider")
    @classmethod
    def provider_is_supported(cls, v: str) -> str:
        if v not in ALLOWED_PROVIDERS:
            raise ValueError(
                f"provider must be one of {', '.join(ALLOWED_PROVIDERS)}"
            )
        return v

    @field_validator("api_key")
    @classmethod
    def api_key_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("API key must not be empty")
        return v


class ApiKeyTestResponse(BaseModel):
    """Response for API key validation."""

    valid: bool
    message: str


class ApiKeyOut(BaseModel):
    """Presence metadata only. The raw API key is never returned to the client."""

    provider: str
    has_key: bool
    updatedAt: int
