import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
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
    return int(datetime.utcnow().timestamp() * 1000)


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    email = Column(String, unique=True, index=True, nullable=False)
    name = Column(String, nullable=False, default="")
    firebase_uid = Column(String, unique=True, index=True, nullable=True)
    photo_url = Column(String, nullable=True)
    provider = Column(String, nullable=False, default="local")
    created_at = Column(BigInteger, nullable=False, default=utc_now_ms)
    updated_at = Column(BigInteger, nullable=False, default=utc_now_ms)

    conversations = relationship(
        "Conversation", back_populates="user", cascade="all, delete-orphan"
    )
    settings = relationship(
        "UserSettings", back_populates="user", uselist=False, cascade="all, delete-orphan"
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
    theme = Column(String, nullable=False, default="light")
    language = Column(String, nullable=False, default="en")
    provider = Column(String, nullable=False, default="groq")
    model = Column(String, nullable=False, default="llama-3.3-70b-versatile")
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
