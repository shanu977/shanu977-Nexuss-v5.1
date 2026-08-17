"""Add role column to users for server-side admin authorization.

Revision ID: e1f2a3b4c5d6
Revises: d5e6f7a8b9c0
Create Date: 2026-08-17 00:00:00.000000

The role column is non-nullable with a server default of "user", so existing
rows are backfilled safely and every new user defaults to a normal user.
Existing users remain normal users unless explicitly promoted to "admin".
"""

import sqlalchemy as sa

from alembic import op

revision: str = "e1f2a3b4c5d6"
down_revision: str = "d5e6f7a8b9c0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("role", sa.String(), nullable=False, server_default="user"),
    )


def downgrade() -> None:
    op.drop_column("users", "role")
