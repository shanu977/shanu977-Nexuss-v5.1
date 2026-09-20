"""Track verification ticket usage.

Revision ID: 7001bdbfcb7a
Revises: f4b5c6d7e8f9
Create Date: 2026-09-21
"""

import sqlalchemy as sa
from alembic import op


revision: str = "7001bdbfcb7a"
down_revision: str = "f4b5c6d7e8f9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "email_otps",
        sa.Column(
            "verification_ticket_used",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )


def downgrade() -> None:
    op.drop_column("email_otps", "verification_ticket_used")