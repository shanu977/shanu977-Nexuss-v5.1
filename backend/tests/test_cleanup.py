import pytest

from app.database import Base
from app.models.models import User, Conversation, Message, utc_now_ms
from app.services.cleanup import cleanup_old_messages

from tests.conftest_helpers import engine, TestingSessionLocal


def _seed_chat(db, chat_id="c", email="cleanup@example.com"):
    user = User(
        id="u-cleanup",
        email=email,
        name="Cleanup",
        created_at=utc_now_ms(),
    )
    db.add(user)
    db.flush()
    conv = Conversation(
        id=chat_id,
        user_id=user.id,
        title="Cleanup",
        created_at=utc_now_ms(),
        updated_at=utc_now_ms(),
    )
    db.add(conv)
    db.flush()
    return conv.id


def _add_message(db, msg_id, chat_id, created_at, source="sync"):
    db.add(Message(
        id=msg_id, conversation_id=chat_id, role="user",
        content="x", created_at=created_at, source=source,
    ))


def test_cleanup_deletes_only_old_sync_messages(client):
    now = utc_now_ms()
    db = TestingSessionLocal()
    try:
        _seed_chat(db)
        _add_message(db, "old-sync", "c", now - 5 * 24 * 60 * 60 * 1000)
        _add_message(db, "old-chat", "c", now - 5 * 24 * 60 * 60 * 1000, source="chat")
        _add_message(db, "recent", "c", now - 1 * 24 * 60 * 60 * 1000)
        db.commit()
        deleted = cleanup_old_messages(db, retention_days=4)
        db.commit()
        assert deleted == 1
        remaining = db.query(Message).filter(Message.id == "recent").count()
        assert remaining == 1
        assert db.query(Message).filter(Message.id == "old-sync").count() == 0
        assert db.query(Message).filter(Message.id == "old-chat").count() == 1
    finally:
        db.close()


def test_cleanup_noop_when_nothing_old(client):
    now = utc_now_ms()
    db = TestingSessionLocal()
    try:
        _seed_chat(db, email="cleanup2@example.com")
        _add_message(db, "fresh", "c", now)
        db.commit()
        assert cleanup_old_messages(db, retention_days=4) == 0
    finally:
        db.close()


def test_cleanup_never_deletes_chat_history(client):
    now = utc_now_ms()
    db = TestingSessionLocal()
    try:
        _seed_chat(db, chat_id="chatc", email="cleanup3@example.com")
        _add_message(db, "chat-a", "chatc", now - 30 * 24 * 60 * 60 * 1000, source="chat")
        _add_message(db, "chat-b", "chatc", now - 30 * 24 * 60 * 60 * 1000, source="chat")
        db.commit()
        deleted = cleanup_old_messages(db, retention_days=4)
        db.commit()
        assert deleted == 0
        assert db.query(Message).filter(Message.id.in_(["chat-a", "chat-b"])).count() == 2
    finally:
        db.close()
