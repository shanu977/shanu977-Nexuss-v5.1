from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"] = "user"
    content: str = Field(min_length=1, max_length=20000)

    model_config = {"extra": "forbid"}


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=20000)
    # Prior conversation turns (oldest -> newest) supplied by the client, which
    # owns chat history locally. The backend is stateless for chats.
    history: List[ChatTurn] = Field(default_factory=list, max_length=100)
    # Optional provider/model overrides from the client so the UI selection is
    # always authoritative. Defaults come from the user's saved settings.
    provider: Optional[str] = Field(default=None, max_length=50)
    model: Optional[str] = Field(default=None, max_length=200)

    model_config = {"extra": "forbid"}

    @field_validator("message")
    @classmethod
    def message_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Message must not be empty")
        return v.strip()


class UsageInfo(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0


class FallbackAttempt(BaseModel):
    """One provider attempt in the fallback chain (primary is attempt 1).

    Every attempt is reported so the client can record usage for each
    provider/model tried, and the successful attempt always reflects the
    provider/model that actually generated the reply.
    """

    provider: str
    model: str
    attempt: int
    status: Literal["success", "failed"]
    http_status: Optional[int] = None
    reason: Optional[str] = None
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    response_time_ms: int = 0
    timestamp: int


class ChatResponse(BaseModel):
    reply: str
    provider: str
    model: str
    usage: Optional[UsageInfo] = None
    # Human-readable notice when a fallback provider generated the reply.
    fallback_used: Optional[str] = None
    # Full attempt log (primary + fallbacks) for usage tracking.
    attempts: Optional[List[FallbackAttempt]] = None


class ChatMessageOut(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str
    created_at: int

    model_config = {"from_attributes": True}
