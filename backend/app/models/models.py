import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from ..database import Base


def utc_now_ms() -> int:
    # timezone-aware so .timestamp() is always interpreted as UTC, never as the
    # process-local timezone (datetime.utcnow() is deprecated and its naive
    # .timestamp() silently shifts timestamps by the local offset).
    return int(datetime.now(timezone.utc).timestamp() * 1000)


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    email = Column(String, unique=True, index=True, nullable=False)
    name = Column(String, nullable=False, default="")
    firebase_uid = Column(String, unique=True, index=True, nullable=True)
    photo_url = Column(String, nullable=True)
    provider = Column(String, nullable=False, default="local")
    role = Column(String, nullable=False, default="user", server_default="user")
    # "active" or "blocked". Server-side admin authorization (get_current_admin)
    # keys off `role`; status is the future block/unblock flag for the Admin
    # Users page. Every existing user backfills to "active".
    status = Column(String, nullable=False, default="active", server_default="active")
    created_at = Column(BigInteger, nullable=False, default=utc_now_ms)
    updated_at = Column(BigInteger, nullable=False, default=utc_now_ms)

    conversations = relationship(
        "Conversation", back_populates="user", cascade="all, delete-orphan"
    )
    settings = relationship(
        "UserSettings", back_populates="user", uselist=False, cascade="all, delete-orphan"
    )
    usage_records = relationship(
        "UsageRecord", back_populates="user", cascade="all, delete-orphan"
    )
    feedback = relationship(
        "Feedback", back_populates="user", cascade="all, delete-orphan"
    )
    audit_logs = relationship(
        "AuditLog",
        back_populates="admin_user",
        foreign_keys="AuditLog.admin_user_id",
    )


class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title = Column(String, nullable=False, default="New chat")
    provider = Column(String, nullable=True)
    created_at = Column(BigInteger, nullable=False, default=utc_now_ms)
    updated_at = Column(BigInteger, nullable=False, default=utc_now_ms, index=True)

    user = relationship("User", back_populates="conversations")
    messages = relationship(
        "Message", back_populates="conversation", cascade="all, delete-orphan"
    )


class Message(Base):
    __tablename__ = "messages"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    conversation_id = Column(
        String,
        ForeignKey("conversations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role = Column(String, nullable=False)
    content = Column(Text, nullable=False, default="")
    created_at = Column(BigInteger, nullable=False, default=utc_now_ms, index=True)
    source = Column(
        String, nullable=False, default="sync", server_default="sync"
    )

    conversation = relationship("Conversation", back_populates="messages")


class UserSettings(Base):
    __tablename__ = "user_settings"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(
        String,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    theme = Column(String, nullable=False, default="dark")
    language = Column(String, nullable=False, default="en")
    provider = Column(String, nullable=False, default="groq")
    model = Column(String, nullable=False, default="openai/gpt-oss-120b")
    updated_at = Column(BigInteger, nullable=False, default=utc_now_ms)

    user = relationship("User", back_populates="settings")


class UserApiKey(Base):
    """Encrypted API key a user has saved for a provider.

    Owned by the user's Firebase UID (`firebase_uid`). The raw key is never
    stored: only the Fernet-encrypted ciphertext lives in Supabase. The key is
    decrypted in-memory just long enough to make a provider request.
    """

    __tablename__ = "user_api_keys"
    __table_args__ = (
        UniqueConstraint(
            "firebase_uid", "provider", name="uq_user_api_keys_uid_provider"
        ),
    )

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    firebase_uid = Column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider = Column(String, nullable=False)
    encrypted_api_key = Column(Text, nullable=False)
    created_at = Column(BigInteger, nullable=False, default=utc_now_ms)
    updated_at = Column(BigInteger, nullable=False, default=utc_now_ms)


class EmailOTP(Base):
    __tablename__ = "email_otps"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    email = Column(String, nullable=False, index=True)
    otp_hash = Column(String, nullable=False)
    purpose = Column(String, nullable=False, default="link_password")
    expires_at = Column(BigInteger, nullable=False)
    attempts = Column(Integer, nullable=False, default=0)
    max_attempts = Column(Integer, nullable=False, default=3)
    resend_available_at = Column(BigInteger, nullable=False, default=0)
    used = Column(Boolean, nullable=False, default=False)
    created_at = Column(BigInteger, nullable=False, default=utc_now_ms)


class UsageRecord(Base):
    """One AI provider attempt from a /chat request.

    Mirrors the `FallbackAttempt` data the backend already computes per request
    (fallback_service): every attempt in the chain (primary + fallbacks) becomes
    one row. This is analytics metadata only — never chat content, images, or
    workspace files. Ingestion from /chat lands in the backend integration
    phase; this table is the storage foundation for the Admin analytics API.
    """

    __tablename__ = "usage_records"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider = Column(String, nullable=False, index=True)
    model = Column(String, nullable=False)
    # "chat" for text requests, "screen_share" when an image frame was analyzed.
    request_type = Column(String, nullable=False, default="chat")
    # Position in the fallback chain (primary = 1).
    attempt = Column(Integer, nullable=False, default=1)
    # "success" or "failed" (per attempt).
    status = Column(String, nullable=False, default="success")
    http_status = Column(Integer, nullable=True)
    # Failure category from the provider error (rate_limit, overload, ...).
    error_category = Column(String, nullable=True)
    input_tokens = Column(Integer, nullable=False, default=0)
    output_tokens = Column(Integer, nullable=False, default=0)
    total_tokens = Column(Integer, nullable=False, default=0)
    # Response latency for this attempt (ms).
    latency_ms = Column(Integer, nullable=False, default=0)
    created_at = Column(BigInteger, nullable=False, default=utc_now_ms, index=True)

    user = relationship("User", back_populates="usage_records")


class Feedback(Base):
    """Feedback intentionally submitted by a user.

    Stores only what the user submits for feedback management; never private
    chat/workspace content. `rating` is optional (1-5); `status` tracks the
    admin triage lifecycle.
    """

    __tablename__ = "feedback"
    __table_args__ = (
        CheckConstraint(
            "rating IS NULL OR (rating >= 1 AND rating <= 5)",
            name="ck_feedback_rating_range",
        ),
    )

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    rating = Column(Integer, nullable=True)
    message = Column(Text, nullable=False, default="")
    # "new" | "reviewed" | "closed"
    status = Column(String, nullable=False, default="new")
    created_at = Column(BigInteger, nullable=False, default=utc_now_ms, index=True)

    user = relationship("User", back_populates="feedback")


class AppSetting(Base):
    """Global (non-user) application settings and feature flags.

    Key/value store for Admin-controlled global configuration. Values are
    stored as JSON-encoded text with a `value_type` hint so the Admin settings
    UI can render them. Never stores secrets or provider API keys.
    """

    __tablename__ = "app_settings"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    key = Column(String, nullable=False, unique=True, index=True)
    value = Column(Text, nullable=False, default="")
    # "string" | "boolean" | "number" | "json" — how to decode `value`.
    value_type = Column(String, nullable=False, default="string")
    description = Column(String, nullable=True)
    # Last admin to change the setting (SET NULL if that admin is deleted).
    updated_by = Column(
        String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at = Column(BigInteger, nullable=False, default=utc_now_ms)
    updated_at = Column(BigInteger, nullable=False, default=utc_now_ms)

    updated_by_user = relationship(
        "User", foreign_keys=[updated_by], passive_deletes=True
    )


class AuditLog(Base):
    """Audit trail of important Admin actions.

    Records who (admin), what (action), and the affected target. `details` is
    a JSON blob of non-sensitive context (before/after values). The admin FK
    uses SET NULL so the audit history survives an admin account being deleted.
    Writing happens in the Admin API/security phase.
    """

    __tablename__ = "audit_log"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    admin_user_id = Column(
        String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    action = Column(String, nullable=False, index=True)
    target_type = Column(String, nullable=True)
    target_id = Column(String, nullable=True)
    details = Column(Text, nullable=True)
    ip_address = Column(String, nullable=True)
    created_at = Column(BigInteger, nullable=False, default=utc_now_ms, index=True)

    admin_user = relationship("User", back_populates="audit_logs")
