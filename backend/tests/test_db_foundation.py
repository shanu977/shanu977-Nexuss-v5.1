"""Database foundation tests for the Admin foundation tables.

Verifies the Phase 2 schema additions (usage_records, feedback, app_settings,
audit_log, users.status) behave correctly: creation, read-back, defaults,
foreign keys, required-field enforcement, cascade/SET NULL deletion semantics,
indexes, and the Alembic migration upgrade/downgrade.

These tests use their own SQLite engine with `PRAGMA foreign_keys=ON` so
referential-integrity behavior is actually enforced (SQLAlchemy leaves SQLite
FK enforcement off by default).
"""

import os
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event, inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.database import Base
from app.models import (
    AppSetting,
    AuditLog,
    Conversation,
    Feedback,
    Message,
    UsageRecord,
    User,
)


@pytest.fixture()
def db(tmp_path):
    """Session against a fresh file-based SQLite DB with FK enforcement on."""
    path = tmp_path / "foundation_test.db"
    engine = create_engine(
        f"sqlite:///{path.as_posix()}", connect_args={"check_same_thread": False}
    )
    event.listen(
        engine, "connect", lambda dbapi_con, rec: dbapi_con.execute("PRAGMA foreign_keys=ON")
    )
    Base.metadata.create_all(bind=engine)
    TestSession = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    session = TestSession()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _add(session, *objects) -> None:
    session.add_all(objects)
    session.commit()


def _make_user(email="foundation@example.com", name="Foundation User") -> User:
    return User(email=email, name=name)


def test_existing_users_continue_working(db):
    user = _make_user()
    conversation = Conversation(user=user, title="Existing chat")
    message = Message(conversation=conversation, role="user", content="hello")
    _add(db, user)

    assert user.id
    assert user.email == "foundation@example.com"
    assert user.name == "Foundation User"
    assert conversation.id
    assert conversation.user_id == user.id
    assert message.conversation_id == conversation.id
    assert message.content == "hello"


def test_user_role_and_status_defaults(db):
    user = _make_user()
    _add(db, user)

    assert user.role == "user"
    assert user.status == "active"


def test_usage_record_can_be_created(db):
    user = _make_user()
    record = UsageRecord(
        user=user,
        provider="groq",
        model="llama-3.3-70b-versatile",
        request_type="chat",
        attempt=1,
        status="success",
        http_status=200,
        input_tokens=120,
        output_tokens=40,
        total_tokens=160,
        latency_ms=812,
    )
    _add(db, record)

    assert record.id
    assert user.usage_records == [record]
    fresh = db.query(UsageRecord).filter_by(id=record.id).one()
    assert fresh.provider == "groq"
    assert fresh.total_tokens == 160
    assert fresh.created_at is not None


def test_usage_record_failed_attempt_stored(db):
    user = _make_user()
    record = UsageRecord(
        user=user,
        provider="gemini",
        model="gemini-3.6-flash",
        request_type="screen_share",
        attempt=2,
        status="failed",
        http_status=429,
        error_category="rate_limit",
    )
    _add(db, record)

    fresh = db.query(UsageRecord).filter_by(id=record.id).one()
    assert fresh.status == "failed"
    assert fresh.error_category == "rate_limit"
    assert fresh.request_type == "screen_share"
    assert fresh.total_tokens == 0


def test_feedback_can_be_created(db):
    user = _make_user()
    feedback = Feedback(user=user, rating=5, message="Great app!")
    _add(db, feedback)

    assert feedback.id
    assert feedback.status == "new"
    assert user.feedback == [feedback]
    fresh = db.query(Feedback).filter_by(id=feedback.id).one()
    assert fresh.rating == 5
    assert fresh.message == "Great app!"


def test_feedback_rating_out_of_range_rejected(db):
    user = _make_user()
    _add(db, user)

    with pytest.raises(IntegrityError):
        _add(db, Feedback(user=user, rating=9, message="invalid"))
    db.rollback()


def test_app_settings_can_be_created_and_read(db):
    setting = AppSetting(
        key="feature:workspace_enabled",
        value="true",
        value_type="boolean",
        description="Enable workspace context in chat",
    )
    _add(db, setting)

    fresh = db.query(AppSetting).filter_by(key="feature:workspace_enabled").one()
    assert fresh.value == "true"
    assert fresh.value_type == "boolean"


def test_app_settings_key_unique(db):
    _add(db, AppSetting(key="app:title", value="Nexuss"))
    with pytest.raises(IntegrityError):
        _add(db, AppSetting(key="app:title", value="Other"))
    db.rollback()


def test_audit_log_can_be_created(db):
    admin = _make_user(email="admin@example.com")
    entry = AuditLog(
        admin_user=admin,
        action="user.block",
        target_type="user",
        target_id="target-user-1",
        details='{"reason": "spam"}',
        ip_address="10.0.0.1",
    )
    _add(db, entry)

    assert entry.id
    assert admin.audit_logs == [entry]
    fresh = db.query(AuditLog).filter_by(id=entry.id).one()
    assert fresh.action == "user.block"
    assert fresh.ip_address == "10.0.0.1"


def test_foreign_keys_enforced(db):
    _add(db, _make_user())

    with pytest.raises(IntegrityError):
        _add(db, UsageRecord(user_id="no-such-user", provider="groq", model="m"))
    db.rollback()

    with pytest.raises(IntegrityError):
        _add(db, Feedback(user_id="no-such-user", message="hi"))
    db.rollback()

    with pytest.raises(IntegrityError):
        _add(db, AuditLog(admin_user_id="no-such-user", action="user.block"))
    db.rollback()


def test_required_fields_enforced(db):
    _add(db, _make_user())

    with pytest.raises(IntegrityError):
        _add(db, UsageRecord(provider="groq", model="m"))
    db.rollback()

    with pytest.raises(IntegrityError):
        _add(db, Feedback(message="missing user"))
    db.rollback()

    with pytest.raises(IntegrityError):
        _add(db, AppSetting(value="no key"))
    db.rollback()


def test_user_delete_cascades_usage_and_feedback(db):
    user = _make_user()
    usage = UsageRecord(user=user, provider="groq", model="m")
    feedback = Feedback(user=user, rating=4, message="nice")
    _add(db, usage, feedback)
    user_id = user.id

    db.delete(user)
    db.commit()

    assert db.query(UsageRecord).filter_by(user_id=user_id).first() is None
    assert db.query(Feedback).filter_by(user_id=user_id).first() is None


def test_user_delete_nullifies_audit_and_setting_owner(db):
    admin = _make_user(email="admin@example.com")
    entry = AuditLog(admin_user=admin, action="settings.update", target_type="settings")
    setting = AppSetting(key="app:title", value="Nexuss", updated_by=admin.id)
    _add(db, entry, setting)
    admin_id = admin.id

    db.delete(admin)
    db.commit()

    log_row = db.query(AuditLog).filter_by(id=entry.id).one()
    assert log_row.admin_user_id is None
    setting_row = db.query(AppSetting).filter_by(id=setting.id).one()
    assert setting_row.updated_by is None
    assert setting_row.value == "Nexuss"


def test_usage_records_indexes_exist(db):
    inspector = inspect(db.bind)
    indexes = {ix["name"] for ix in inspector.get_indexes("usage_records")}
    assert "ix_usage_records_user_id" in indexes
    assert "ix_usage_records_created_at" in indexes
    assert "ix_usage_records_provider" in indexes


def test_migration_upgrade_and_downgrade(tmp_path):
    """Apply the real migration chain up to the Phase 2 head on a temp SQLite
    DB, verify the schema, then downgrade one revision and verify removal.

    The historical migration b2c3d4e5f6a7 uses alter_column, which SQLite does
    not support, so the chain is stamped past it (it is not part of this
    change and is only a SQLite-testing limitation — production is PostgreSQL).
    """
    from alembic import command
    from alembic.config import Config

    from app import config as app_config

    db_path = tmp_path / "migrate.db"
    url = f"sqlite:///{db_path.as_posix()}"
    original_url = app_config.settings.database_url
    app_config.settings.database_url = url
    try:
        cfg = Config()
        cfg.set_main_option(
            "script_location",
            str(Path(__file__).resolve().parent.parent / "alembic"),
        )
        cfg.set_main_option("sqlalchemy.url", url)

        command.upgrade(cfg, "a1b2c3d4e5f6")
        command.stamp(cfg, "d5e6f7a8b9c0")
        command.upgrade(cfg, "head")

        engine = create_engine(url)
        try:
            inspector = inspect(engine)
            tables = set(inspector.get_table_names())
            assert {"usage_records", "feedback", "app_settings", "audit_log"} <= tables

            user_cols = {c["name"] for c in inspector.get_columns("users")}
            assert "status" in user_cols
            assert "role" in user_cols

            usage_indexes = {ix["name"] for ix in inspector.get_indexes("usage_records")}
            assert "ix_usage_records_user_id" in usage_indexes
            assert "ix_usage_records_provider" in usage_indexes

            command.downgrade(cfg, "-1")

            inspector = inspect(engine)
            tables_after = set(inspector.get_table_names())
            assert "usage_records" not in tables_after
            assert "audit_log" not in tables_after
            user_cols_after = {c["name"] for c in inspector.get_columns("users")}
            assert "status" not in user_cols_after
            assert "role" in user_cols_after
        finally:
            engine.dispose()
    finally:
        app_config.settings.database_url = original_url
