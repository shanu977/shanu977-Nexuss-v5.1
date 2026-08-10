from typing import List

from pydantic import BaseModel, Field

MAX_SYNC_CONVERSATIONS = 1000
MAX_SYNC_MESSAGES = 5000
MAX_SYNC_CONTENT_CHARS = 200_000


class ConversationSync(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    title: str = Field(default="New chat", max_length=300)
    provider: str | None = Field(default=None, max_length=50)
    createdAt: int
    updatedAt: int

    model_config = {"extra": "forbid"}


class MessageSync(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    chatId: str = Field(min_length=1, max_length=200)
    role: str = Field(min_length=1, max_length=20)
    content: str = Field(default="", max_length=MAX_SYNC_CONTENT_CHARS)
    timestamp: int

    model_config = {"extra": "forbid"}


class SyncPushRequest(BaseModel):
    conversations: List[ConversationSync] = Field(
        default_factory=list, max_length=MAX_SYNC_CONVERSATIONS
    )
    messages: List[MessageSync] = Field(
        default_factory=list, max_length=MAX_SYNC_MESSAGES
    )
    deletedConversations: List[str] = Field(
        default_factory=list, max_length=MAX_SYNC_CONVERSATIONS
    )
    deletedMessages: List[str] = Field(
        default_factory=list, max_length=MAX_SYNC_MESSAGES
    )

    model_config = {"extra": "forbid"}


class SyncPushResponse(BaseModel):
    accepted: bool = True
    serverTime: int


class SyncPullResponse(BaseModel):
    conversations: List[ConversationSync]
    messages: List[MessageSync]
    serverTime: int
