"""Alembic environment configuration.

This file is the bridge between SQLAlchemy models and the PostgreSQL database.
When you run `alembic revision --autogenerate`, Alembic:

1. Imports this file
2. Imports all models via `app.models` (line 8) — this registers them in
   Base.metadata so Alembic knows what tables/columns the code expects
3. Connects to the live database
4. Compares Base.metadata (code) vs the actual database schema
5. Generates a migration for any differences

IMPORTANT: If you add a new model class, you MUST import it in
`app/models/__init__.py` or Alembic will not see it.
"""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.config import settings
from app.database import Base

# Import all models so they register with Base.metadata.
# Each new model MUST be added to app/models/__init__.py for this to work.
from app import models  # noqa: F401

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Override sqlalchemy.url with the runtime database URL from app config.
# This means alembic.ini's sqlalchemy.url is never used — it exists only as
# a placeholder so Alembic does not complain about a missing value.
config.set_main_option("sqlalchemy.url", settings.database_url)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (generates SQL without a DB connection).

    Useful for:
    - Generating migration SQL to review before applying
    - CI/CD pipelines that need to inspect the generated SQL
    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode (connects to DB and applies changes).

    This is the normal mode used by `alembic upgrade` and `alembic downgrade`.
    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
