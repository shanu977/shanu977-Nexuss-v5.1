"""Add source column to messages.

Marks whether a message was created by the server-side AI assistant
(source='chat') or synced from a client device (source='sync', the default).
The retention cleanup deletes only 'sync' messages so conversation history
and AI memory are never wiped.
"""

import sqlalchemy as sa

from alembic import op

revision: str = "3f9c1a2b7d04"
down_revision: str = "cc2abd2b51ae"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("source", sa.String(), nullable=False, server_default="sync"),
    )


def downgrade() -> None:
    op.drop_column("messages", "source")
