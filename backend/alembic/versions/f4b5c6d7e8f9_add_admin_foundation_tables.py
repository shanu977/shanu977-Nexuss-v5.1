"""Add admin foundation tables and users.status.

Revision ID: f4b5c6d7e8f9
Revises: e1f2a3b4c5d6
Create Date: 2026-08-17 00:00:00.000000

Adds the storage foundation for the future Admin APIs:

* users.status — "active"/"blocked" flag for the Admin Users page.
* usage_records — per-attempt AI usage metadata for the analytics API.
* feedback — user-submitted feedback for the feedback management page.
* app_settings — global (non-user) settings and feature flags.
* audit_log — audit trail of Admin actions.

Idempotency: every object is created only if it does not already exist. The
backend runs ``Base.metadata.create_all`` on startup, which pre-creates missing
tables, so the migration must not fail when those tables (or the ``status``
column) are already present.

No secrets, API keys, chat content, screen-share images, or workspace files
are stored. All operations are SQLite- and PostgreSQL-compatible (no
alter_column, no table rewrites).
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "f4b5c6d7e8f9"
down_revision: Union[str, None] = "e1f2a3b4c5d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _existing_tables() -> set:
    bind = op.get_bind()
    return set(sa.inspect(bind).get_table_names())


def _existing_columns(table: str) -> set:
    bind = op.get_bind()
    return {c["name"] for c in sa.inspect(bind).get_columns(table)}


def _existing_indexes(table: str) -> set:
    bind = op.get_bind()
    return {i["name"] for i in sa.inspect(bind).get_indexes(table)}


def upgrade() -> None:
    if "status" not in _existing_columns("users"):
        op.add_column(
            "users",
            sa.Column("status", sa.String(), nullable=False, server_default="active"),
        )

    tables = _existing_tables()

    if "usage_records" not in tables:
        op.create_table(
            "usage_records",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("user_id", sa.String(), nullable=False),
            sa.Column("provider", sa.String(), nullable=False),
            sa.Column("model", sa.String(), nullable=False),
            sa.Column("request_type", sa.String(), nullable=False),
            sa.Column("attempt", sa.Integer(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("http_status", sa.Integer(), nullable=True),
            sa.Column("error_category", sa.String(), nullable=True),
            sa.Column("input_tokens", sa.Integer(), nullable=False),
            sa.Column("output_tokens", sa.Integer(), nullable=False),
            sa.Column("total_tokens", sa.Integer(), nullable=False),
            sa.Column("latency_ms", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.BigInteger(), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        _create_missing_indexes(
            "usage_records",
            {
                "ix_usage_records_user_id": (["user_id"], False),
                "ix_usage_records_created_at": (["created_at"], False),
                "ix_usage_records_provider": (["provider"], False),
            },
        )

    if "feedback" not in tables:
        op.create_table(
            "feedback",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("user_id", sa.String(), nullable=False),
            sa.Column("rating", sa.Integer(), nullable=True),
            sa.Column("message", sa.Text(), nullable=False),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("created_at", sa.BigInteger(), nullable=False),
            sa.CheckConstraint(
                "rating IS NULL OR (rating >= 1 AND rating <= 5)",
                name="ck_feedback_rating_range",
            ),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        _create_missing_indexes(
            "feedback",
            {
                "ix_feedback_user_id": (["user_id"], False),
                "ix_feedback_created_at": (["created_at"], False),
            },
        )

    if "app_settings" not in tables:
        op.create_table(
            "app_settings",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("key", sa.String(), nullable=False),
            sa.Column("value", sa.Text(), nullable=False),
            sa.Column("value_type", sa.String(), nullable=False),
            sa.Column("description", sa.String(), nullable=True),
            sa.Column("updated_by", sa.String(), nullable=True),
            sa.Column("created_at", sa.BigInteger(), nullable=False),
            sa.Column("updated_at", sa.BigInteger(), nullable=False),
            sa.ForeignKeyConstraint(["updated_by"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
        )
        _create_missing_indexes(
            "app_settings",
            {
                "ix_app_settings_key": (["key"], True),
            },
        )

    if "audit_log" not in tables:
        op.create_table(
            "audit_log",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("admin_user_id", sa.String(), nullable=True),
            sa.Column("action", sa.String(), nullable=False),
            sa.Column("target_type", sa.String(), nullable=True),
            sa.Column("target_id", sa.String(), nullable=True),
            sa.Column("details", sa.Text(), nullable=True),
            sa.Column("ip_address", sa.String(), nullable=True),
            sa.Column("created_at", sa.BigInteger(), nullable=False),
            sa.ForeignKeyConstraint(["admin_user_id"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
        )
        _create_missing_indexes(
            "audit_log",
            {
                "ix_audit_log_admin_user_id": (["admin_user_id"], False),
                "ix_audit_log_action": (["action"], False),
                "ix_audit_log_created_at": (["created_at"], False),
            },
        )


def _create_missing_indexes(table: str, indexes: dict) -> None:
    existing = _existing_indexes(table)
    for name, (columns, unique) in indexes.items():
        if name not in existing:
            op.create_index(
                op.f(name), table, columns, unique=unique
            )


def downgrade() -> None:
    op.drop_index(op.f("ix_audit_log_created_at"), table_name="audit_log")
    op.drop_index(op.f("ix_audit_log_action"), table_name="audit_log")
    op.drop_index(op.f("ix_audit_log_admin_user_id"), table_name="audit_log")
    op.drop_table("audit_log")

    op.drop_index(op.f("ix_app_settings_key"), table_name="app_settings")
    op.drop_table("app_settings")

    op.drop_index(op.f("ix_feedback_created_at"), table_name="feedback")
    op.drop_index(op.f("ix_feedback_user_id"), table_name="feedback")
    op.drop_table("feedback")

    op.drop_index(op.f("ix_usage_records_provider"), table_name="usage_records")
    op.drop_index(op.f("ix_usage_records_created_at"), table_name="usage_records")
    op.drop_index(op.f("ix_usage_records_user_id"), table_name="usage_records")
    op.drop_table("usage_records")

    op.drop_column("users", "status")