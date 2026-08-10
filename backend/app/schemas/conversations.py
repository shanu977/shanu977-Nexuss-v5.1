from typing import List, Optional

from pydantic import BaseModel, Field

from .chat import ChatMessageOut


class ConversationCreate(BaseModel):
    title: str = Field(default="New chat", max_length=300)
    provider: Optional[str] = Field(default=None, max_length=50)

    model_config = {"extra": "forbid"}


class ConversationUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=300)

    model_config = {"extra": "forbid"}


class ConversationOut(BaseModel):
    id: str
    title: str
    provider: Optional[str] = None
    created_at: int
    updated_at: int

    model_config = {"from_attributes": True}


class ConversationDetail(BaseModel):
    conversation: ConversationOut
    messages: List[ChatMessageOut]
