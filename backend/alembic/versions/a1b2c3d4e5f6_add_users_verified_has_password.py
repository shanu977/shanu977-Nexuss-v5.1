"""Add verified and has_password columns to users.

The User SQLAlchemy model expects these columns but the initial migration
(cc2abd2b51ae) did not include them, causing:
  psycopg2.errors.UndefinedColumn: column users.verified does not exist

Both columns use String type with default "false" to match the model definition.
"""

import sqlalchemy as sa

from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: str = "8d1a2c3e4f5a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("verified", sa.String(), nullable=False, server_default="false"),
    )
    op.add_column(
        "users",
        sa.Column("has_password", sa.String(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("users", "has_password")
    op.drop_column("users", "verified")
