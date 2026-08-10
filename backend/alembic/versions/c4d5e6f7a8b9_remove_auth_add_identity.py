"""Remove authentication columns/tables, add identity fields to users.

Removes the OTP/email-verification auth system:
  - users: password_hash, verified, has_password, last_login
  - tables: email_verifications, password_setup_tokens

Adds Firebase-ready identity fields to users (kept in sync with the SQLAlchemy
model; Firebase Auth itself is added in a later step):
  - firebase_uid (unique, indexed, nullable)
  - photo_url (nullable)
  - provider (default 'local')
  - updated_at (default now)
"""

import sqlalchemy as sa

from alembic import op

revision: str = "c4d5e6f7a8b9"
down_revision: str = "b2c3d4e5f6a7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("password_setup_tokens")
    op.drop_table("email_verifications")

    op.add_column(
        "users",
        sa.Column("firebase_uid", sa.String(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("photo_url", sa.String(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("provider", sa.String(), nullable=False, server_default="local"),
    )
    op.add_column(
        "users",
        sa.Column("updated_at", sa.BigInteger(), nullable=False, server_default="0"),
    )
    op.create_index(op.f("ix_users_firebase_uid"), "users", ["firebase_uid"], unique=True)

    op.drop_column("users", "last_login")
    op.drop_column("users", "has_password")
    op.drop_column("users", "verified")
    op.drop_column("users", "password_hash")


def downgrade() -> None:
    op.add_column("users", sa.Column("password_hash", sa.String(), nullable=False, server_default=""))
    op.add_column("users", sa.Column("verified", sa.String(), nullable=False, server_default="false"))
    op.add_column("users", sa.Column("has_password", sa.String(), nullable=False, server_default="false"))
    op.add_column("users", sa.Column("last_login", sa.BigInteger(), nullable=True))

    op.drop_index(op.f("ix_users_firebase_uid"), table_name="users")
    op.drop_column("users", "updated_at")
    op.drop_column("users", "provider")
    op.drop_column("users", "photo_url")
    op.drop_column("users", "firebase_uid")

    op.create_table(
        "email_verifications",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("otp_hash", sa.String(), nullable=False),
        sa.Column("purpose", sa.String(), nullable=False),
        sa.Column("expires_at", sa.BigInteger(), nullable=False),
        sa.Column("attempts", sa.BigInteger(), nullable=False),
        sa.Column("max_attempts", sa.BigInteger(), nullable=False),
        sa.Column("verified", sa.String(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_email_verifications_email"), "email_verifications", ["email"], unique=False
    )
    op.create_table(
        "password_setup_tokens",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=False),
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("expires_at", sa.BigInteger(), nullable=False),
        sa.Column("used", sa.String(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_password_setup_tokens_token_hash"),
        "password_setup_tokens",
        ["token_hash"],
        unique=True,
    )
    op.create_index(
        op.f("ix_password_setup_tokens_user_id"),
        "password_setup_tokens",
        ["user_id"],
        unique=False,
    )
