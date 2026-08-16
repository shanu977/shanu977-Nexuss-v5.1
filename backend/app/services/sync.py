from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Conversation, Message
from ..models.models import utc_now_ms
from ..schemas.sync import (
    ConversationSync,
    MessageSync,
    SyncPullResponse,
    SyncPushRequest,
)


def cap_title(title: str, max_len: int = 300) -> str:
    title = (title or "New chat").strip()
    return title[:max_len] if len(title) > max_len else title


def upsert_conversation(db: Session, user_id: str, data: ConversationSync) -> bool:
    existing = db.get(Conversation, data.id)
    if existing is None:
        db.add(
            Conversation(
                id=data.id,
                user_id=user_id,
                title=cap_title(data.title),
                provider=data.provider,
                created_at=data.createdAt,
                updated_at=data.updatedAt,
            )
        )
        # Flush so subsequent message upserts can find this conversation
        # (the session is created with autoflush=False).
        db.flush()
        return True

    # Never mutate another user's conversation: only the owner may update it.
    if existing.user_id != user_id:
        return False

    if data.updatedAt > existing.updated_at:
        existing.title = cap_title(data.title)
        existing.provider = data.provider
        existing.updated_at = max(data.updatedAt, existing.updated_at)
        return True

    return False


def upsert_message(db: Session, user_id: str, data: MessageSync) -> bool:
    existing = db.get(Message, data.id)
    if existing is not None:
        return False

    conversation = db.get(Conversation, data.chatId)
    if conversation is None or conversation.user_id != user_id:
        return False

    db.add(
        Message(
            id=data.id,
            conversation_id=data.chatId,
            role=data.role,
            content=data.content,
            created_at=data.timestamp,
        )
    )
    return True


def apply_push(db: Session, user_id: str, payload: SyncPushRequest) -> dict:
    accepted_conv = 0
    accepted_msg = 0

    for conv in payload.conversations:
        if upsert_conversation(db, user_id, conv):
            accepted_conv += 1

    for msg in payload.messages:
        if upsert_message(db, user_id, msg):
            accepted_msg += 1

    for conv_id in payload.deletedConversations:
        conv = db.get(Conversation, conv_id)
        if conv and conv.user_id == user_id:
            db.delete(conv)
            accepted_conv += 1

    for msg_id in payload.deletedMessages:
        msg = db.get(Message, msg_id)
        if msg:
            conv = db.get(Conversation, msg.conversation_id)
            if conv and conv.user_id == user_id:
                db.delete(msg)
                accepted_msg += 1

    db.commit()
    return {"acceptedConversations": accepted_conv, "acceptedMessages": accepted_msg}


def pull(db: Session, user_id: str, since: int = 0) -> SyncPullResponse:
    conversations = db.scalars(
        select(Conversation)
        .where(Conversation.user_id == user_id)
        .where(Conversation.updated_at >= since)
    ).all()

    conv_ids = [c.id for c in conversations]

    messages: list[Message] = []
    if conv_ids:
        messages = list(
            db.scalars(select(Message).where(Message.conversation_id.in_(conv_ids)))
        )

    return SyncPullResponse(
        conversations=[_to_conv(c) for c in conversations],
        messages=[_to_msg(m) for m in messages],
        serverTime=utc_now_ms(),
    )


def _to_conv(c: Conversation) -> ConversationSync:
    return ConversationSync(
        id=c.id,
        title=c.title,
        provider=c.provider,
        createdAt=c.created_at,
        updatedAt=c.updated_at,
    )


def _to_msg(m: Message) -> MessageSync:
    return MessageSync(
        id=m.id,
        chatId=m.conversation_id,
        role=m.role,
        content=m.content,
        timestamp=m.created_at,
    )
