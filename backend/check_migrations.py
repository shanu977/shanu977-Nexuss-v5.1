"""Migration drift checker — run in CI to catch schema mismatches early.

Exit codes:
    0  Models match the database (no pending migrations)
    1  Drift detected — a migration needs to be created

Usage:
    python check_migrations.py          # check for drift
    python check_migrations.py --diff   # show what would change
"""

import sys
from pathlib import Path

# Add backend/ to path so imports work
sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlalchemy import create_engine, text

from alembic.config import Config
from alembic.script import ScriptDirectory

from app.config import settings
from app.database import Base

# Import all models so they register with Base.metadata.
# Each new model MUST be added to app/models/__init__.py for this to work.
from app import models  # noqa: F401

# Supabase schema we own (tables created by our migrations)
OWN_SCHEMA = "public"


def get_alembic_config() -> Config:
    """Build an Alembic Config pointing at the current database."""
    alembic_cfg = Config(str(Path(__file__).resolve().parent / "alembic.ini"))
    alembic_cfg.set_main_option("sqlalchemy.url", settings.database_url)
    return alembic_cfg


def check_pending_migrations(alembic_cfg: Config) -> tuple[bool, str]:
    """Check if there are migrations that haven't been applied yet.

    Returns (is_clean, message).
    """
    script = ScriptDirectory.from_config(alembic_cfg)
    head = script.get_current_head()

    if not head:
        return True, "No migrations exist"

    engine = create_engine(settings.database_url)
    try:
        with engine.connect() as conn:
            result = conn.execute(text("SELECT version_num FROM alembic_version"))
            row = result.fetchone()
            current = row[0] if row else None
    finally:
        engine.dispose()

    if current == head:
        return True, f"Database is up to date at {head}"

    return False, (
        f"Database is at {current or '(none)'}, "
        f"but head is {head}. "
        f"Run: alembic upgrade head"
    )


def check_drift(alembic_cfg: Config) -> tuple[bool, str]:
    """Check if models have drifted from the database (new changes not migrated).

    Compares each model's expected table against the actual public schema.
    Returns (is_clean, message).
    """
    engine = create_engine(settings.database_url)
    try:
        with engine.connect() as conn:
            # Get DB tables via raw SQL (bypasses schema issues)
            result = conn.execute(text(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
            ))
            db_tables = {row[0] for row in result}

            # Get model tables
            model_tables = set(Base.metadata.tables.keys())

            # Find tables in models but not in DB (need migration to add)
            missing_in_db = model_tables - db_tables
            # Find tables in DB but not in models (model was deleted)
            missing_in_models = db_tables - model_tables

            lines = []
            for table_name in sorted(missing_in_db):
                lines.append(f"  + TABLE MISSING IN DB: {table_name}")
            for table_name in sorted(missing_in_models):
                # Skip alembic_version (managed by alembic, not our models)
                if table_name == "alembic_version":
                    continue
                lines.append(f"  - TABLE MISSING IN MODELS: {table_name}")

            # Check columns for each table that exists in both
            for table_name in sorted(model_tables & db_tables):
                # Get DB columns
                result = conn.execute(text(
                    "SELECT column_name, data_type, is_nullable, column_default "
                    "FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = :t "
                    "ORDER BY ordinal_position"
                ), {"t": table_name})
                db_columns = {row[0] for row in result}

                # Get model columns
                model_table = Base.metadata.tables[table_name]
                model_columns = {c.name for c in model_table.columns}

                missing_cols = model_columns - db_columns
                extra_cols = db_columns - model_columns

                for col_name in sorted(missing_cols):
                    lines.append(f"  + COLUMN MISSING IN DB: {table_name}.{col_name}")
                for col_name in sorted(extra_cols):
                    lines.append(f"  - COLUMN MISSING IN MODELS: {table_name}.{col_name}")

            # Check indexes for each table that exists in both
            for table_name in sorted(model_tables & db_tables):
                # Get DB indexes
                result = conn.execute(text(
                    "SELECT indexname FROM pg_indexes "
                    "WHERE schemaname = 'public' AND tablename = :t "
                    "AND indexname NOT LIKE '%_pkey'"
                ), {"t": table_name})
                db_indexes = {row[0] for row in result}

                # Get model indexes (skip primary key indexes)
                model_table = Base.metadata.tables[table_name]
                model_indexes = set()
                for idx in model_table.indexes:
                    if idx.name and not idx.name.endswith("_pkey"):
                        model_indexes.add(idx.name)

                missing_indexes = model_indexes - db_indexes
                for idx_name in sorted(missing_indexes):
                    lines.append(f"  + INDEX MISSING IN DB: {table_name}.{idx_name}")

        if not lines:
            return True, "Models match the database — no drift detected"

        summary = f"Drift detected ({len(lines)} changes):\n" + "\n".join(lines)
        return False, summary

    finally:
        engine.dispose()


def main():
    show_diff = "--diff" in sys.argv

    alembic_cfg = get_alembic_config()

    print("=" * 60)
    print("Migration Drift Check")
    print("=" * 60)

    # Check 1: Pending migrations
    print("\n[1/2] Checking for pending migrations...")
    is_clean_pending, msg_pending = check_pending_migrations(alembic_cfg)
    print(f"  {msg_pending}")

    # Check 2: Model drift
    print("\n[2/2] Checking for model drift...")
    is_clean_drift, msg_drift = check_drift(alembic_cfg)
    print(f"  {msg_drift}")

    if show_diff and not is_clean_drift:
        print("\nTo fix, run:")
        print("  alembic revision --autogenerate -m 'description'")
        print("  alembic upgrade head")

    print("\n" + "=" * 60)
    if is_clean_pending and is_clean_drift:
        print("PASS: No action needed")
        sys.exit(0)
    else:
        print("FAIL: Migration action required")
        sys.exit(1)


if __name__ == "__main__":
    main()
