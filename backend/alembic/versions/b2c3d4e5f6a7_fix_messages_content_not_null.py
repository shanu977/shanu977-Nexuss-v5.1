"""Set messages.content to NOT NULL.

The SQLAlchemy model declares content as NOT NULL with default="" but the
live PostgreSQL schema has it as NULLABLE. This migration backfills any
NULL values with empty strings and then enforces NOT NULL.

Safe for existing data: only NULLs are replaced; non-NULL values are untouched.
"""

import sqlalchemy as sa

from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: str = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Backfill any existing NULLs before adding the constraint.
    op.execute("UPDATE messages SET content = '' WHERE content IS NULL")
    op.alter_column(
        "messages",
        "content",
        existing_type=sa.Text(),
        nullable=False,
        server_default="",
    )


def downgrade() -> None:
    op.alter_column(
        "messages",
        "content",
        existing_type=sa.Text(),
        nullable=True,
        server_default=None,
    )
