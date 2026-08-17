"""Pydantic schemas for the Admin backend APIs.

Response shapes are stable for the future Admin UI and are built from real
Nexuss data only. Sensitive values (tokens, keys, encrypted ciphertext,
content) are never exposed.
"""

import json
import re
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

# ────────────────────────────────────────────────────────────── users

# Keys that may never be stored in app_settings (secrets/credentials).
_FORBIDDEN_SETTING_SUBSTRINGS = (
    "secret",
    "password",
    "credential",
    "private_key",
    "private-key",
    "api_key",
    "api-key",
)


class AdminUserOut(BaseModel):
    id: str
    email: str
    name: str
    photo_url: Optional[str] = None
    provider: str
    role: str
    status: str
    created_at: int
    updated_at: int

    model_config = {"from_attributes": True}


class AdminUserList(BaseModel):
    items: List[AdminUserOut]
    total: int
    page: int
    page_size: int
    pages: int


class RoleUpdate(BaseModel):
    role: Literal["user", "admin"]

    model_config = {"extra": "forbid"}


class DeleteResult(BaseModel):
    status: str
    id: str


# ────────────────────────────────────────────────────────────── analytics


class AnalyticsPeriod(BaseModel):
    from_ms: Optional[int] = None
    to_ms: Optional[int] = None


class AnalyticsTotals(BaseModel):
    total_users: int
    active_users: int
    total_requests: int
    successful_requests: int
    failed_requests: int
    input_tokens: int
    output_tokens: int
    total_tokens: int
    requests_today: int


class AnalyticsSummary(BaseModel):
    period: AnalyticsPeriod
    totals: AnalyticsTotals


class AiUsageDaily(BaseModel):
    date: str
    requests: int
    successful: int
    failed: int
    input_tokens: int
    output_tokens: int
    total_tokens: int


class AiUsageBucket(BaseModel):
    key: str
    requests: int
    successful: int
    failed: int
    total_tokens: int


class AiUsageResponse(BaseModel):
    period: AnalyticsPeriod
    filters: dict
    totals: AnalyticsTotals
    series: List[AiUsageDaily]
    by_provider: List[AiUsageBucket]
    by_model: List[AiUsageBucket]
    by_status: List[AiUsageBucket]
    by_request_type: List[AiUsageBucket]


# ────────────────────────────────────────────────────────────── feedback


class FeedbackUser(BaseModel):
    id: str
    email: str
    name: str


class AdminFeedbackOut(BaseModel):
    id: str
    user: FeedbackUser
    rating: Optional[int] = None
    message: str
    status: str
    created_at: int


class AdminFeedbackList(BaseModel):
    items: List[AdminFeedbackOut]
    total: int
    page: int
    page_size: int
    pages: int


class FeedbackStatusUpdate(BaseModel):
    status: Literal["new", "reviewed", "closed"]

    model_config = {"extra": "forbid"}


# ────────────────────────────────────────────────────────────── settings


class AdminSettingOut(BaseModel):
    id: str
    key: str
    value: str
    value_type: str
    description: Optional[str] = None
    updated_by_email: Optional[str] = None
    created_at: int
    updated_at: int


class AdminSettingUpsert(BaseModel):
    key: str = Field(min_length=1, max_length=120)
    value: str = Field(max_length=8000)
    value_type: Literal["string", "boolean", "number", "json"] = "string"
    description: Optional[str] = Field(default=None, max_length=500)

    model_config = {"extra": "forbid"}

    @field_validator("key")
    @classmethod
    def key_is_safe(cls, v: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9._:\-]+", v):
            raise ValueError(
                "key may only contain letters, digits, '.', ':', '-' and '_'"
            )
        lowered = v.lower()
        for forbidden in _FORBIDDEN_SETTING_SUBSTRINGS:
            if forbidden in lowered:
                raise ValueError(
                    "app_settings must not store secrets or credentials"
                )
        return v

    @model_validator(mode="after")
    def value_matches_type(self) -> "AdminSettingUpsert":
        value_type = self.value_type
        if value_type == "boolean":
            if self.value not in ("true", "false"):
                raise ValueError("boolean value must be 'true' or 'false'")
        elif value_type == "number":
            try:
                float(self.value)
            except ValueError as exc:
                raise ValueError("number value must be numeric") from exc
        elif value_type == "json":
            try:
                json.loads(self.value)
            except ValueError as exc:
                raise ValueError("json value must be valid JSON") from exc
        return self


class AdminSettingsResponse(BaseModel):
    items: List[AdminSettingOut]


# ────────────────────────────────────────────────────────────── security / audit


class AuditLogOut(BaseModel):
    id: str
    admin_user_id: Optional[str] = None
    admin_email: Optional[str] = None
    admin_name: Optional[str] = None
    action: str
    target_type: Optional[str] = None
    target_id: Optional[str] = None
    # Parsed non-sensitive details JSON (never secrets/credentials).
    details: Optional[dict] = None
    ip_address: Optional[str] = None
    created_at: int


class AuditLogList(BaseModel):
    items: List[AuditLogOut]
    total: int
    page: int
    page_size: int
    pages: int
