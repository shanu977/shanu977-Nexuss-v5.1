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


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("status", sa.String(), nullable=False, server_default="active"),
    )

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
    op.create_index(op.f("ix_usage_records_user_id"), "usage_records", ["user_id"], unique=False)
    op.create_index(op.f("ix_usage_records_created_at"), "usage_records", ["created_at"], unique=False)
    op.create_index(op.f("ix_usage_records_provider"), "usage_records", ["provider"], unique=False)

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
    op.create_index(op.f("ix_feedback_user_id"), "feedback", ["user_id"], unique=False)
    op.create_index(op.f("ix_feedback_created_at"), "feedback", ["created_at"], unique=False)

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
    op.create_index(op.f("ix_app_settings_key"), "app_settings", ["key"], unique=True)

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
    op.create_index(op.f("ix_audit_log_admin_user_id"), "audit_log", ["admin_user_id"], unique=False)
    op.create_index(op.f("ix_audit_log_action"), "audit_log", ["action"], unique=False)
    op.create_index(op.f("ix_audit_log_created_at"), "audit_log", ["created_at"], unique=False)


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
