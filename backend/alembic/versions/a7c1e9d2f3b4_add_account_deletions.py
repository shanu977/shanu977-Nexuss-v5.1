"""Add account_deletions table (temporary deletion-job state).

Revision ID: a7c1e9d2f3b4
Revises: f4b5c6d7e8f9
Create Date: 2026-09-30 00:00:00.000000

Holds the *in-flight* operational state of a permanent account deletion so
the backend can keep deleting (with bounded retries) even if the browser is
closed or the process restarts. The row is deleted on success — no deletion
history is retained.

Idempotency: the backend runs ``Base.metadata.create_all`` on startup, which
pre-creates missing tables, so every object is created only if absent.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a7c1e9d2f3b4"
down_revision: Union[str, None] = "f4b5c6d7e8f9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _existing_tables() -> set:
    bind = op.get_bind()
    return set(sa.inspect(bind).get_table_names())


def _existing_indexes(table: str) -> set:
    bind = op.get_bind()
    return {i["name"] for i in sa.inspect(bind).get_indexes(table)}


def upgrade() -> None:
    tables = _existing_tables()

    if "account_deletions" not in tables:
        op.create_table(
            "account_deletions",
            sa.Column("id", sa.String(), nullable=False),
            sa.Column("firebase_uid", sa.String(), nullable=False),
            sa.Column("email", sa.String(), nullable=True),
            sa.Column("state", sa.String(), nullable=False, server_default="queued"),
            sa.Column("stage", sa.String(), nullable=False, server_default="queued"),
            sa.Column("attempt", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="7"),
            sa.Column("next_attempt_at", sa.BigInteger(), nullable=False),
            sa.Column("last_error", sa.String(), nullable=True),
            sa.Column("created_at", sa.BigInteger(), nullable=False),
            sa.Column("updated_at", sa.BigInteger(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )

    indexes = _existing_indexes("account_deletions")
    if "ix_account_deletions_firebase_uid" not in indexes:
        op.create_index(
            "ix_account_deletions_firebase_uid",
            "account_deletions",
            ["firebase_uid"],
            unique=True,
        )
    if "ix_account_deletions_email" not in indexes:
        op.create_index(
            "ix_account_deletions_email",
            "account_deletions",
            ["email"],
            unique=False,
        )


def downgrade() -> None:
    op.drop_index("ix_account_deletions_email", table_name="account_deletions")
    op.drop_index("ix_account_deletions_firebase_uid", table_name="account_deletions")
    op.drop_table("account_deletions")
