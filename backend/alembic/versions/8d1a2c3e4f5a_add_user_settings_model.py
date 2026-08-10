"""Add model column to user_settings.

Adds the user-selected model so the backend chat flow can use the exact model
the UI shows. API keys are intentionally NOT stored server-side; they live in
the browser's localStorage and are passed per chat request.
"""

import sqlalchemy as sa

from alembic import op

revision: str = "8d1a2c3e4f5a"
down_revision: str = "3f9c1a2b7d04"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_settings",
        sa.Column("model", sa.String(), nullable=False, server_default="llama-3.3-70b-versatile"),
    )


def downgrade() -> None:
    op.drop_column("user_settings", "model")
