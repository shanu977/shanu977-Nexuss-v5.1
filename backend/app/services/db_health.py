"""Database health check — reports schema issues without modifying data.

Run on backend startup to verify:
1. Database connectivity
2. Required tables exist
3. Required columns exist in each table

This module NEVER writes to or modifies the database. It only reads schema
metadata and reports problems via logging.
"""

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Set

from sqlalchemy import create_engine, inspect, text

from app.config import settings

logger = logging.getLogger("db_health")

# ──────────────────────────────────────────────────────────────
# Required schema definition
# ──────────────────────────────────────────────────────────────

# Tables that MUST exist for the app to function.
REQUIRED_TABLES: List[str] = [
    "users",
    "user_settings",
    "user_api_keys",
    "conversations",
    "messages",
]

# Columns that MUST exist in each table.
# Format: { "table_name": { "column_name": "expected_type_hint" } }
# The type_hint is informational only — we don't enforce types at startup.
REQUIRED_COLUMNS: Dict[str, Dict[str, str]] = {
    "users": {
        "id": "String (PK)",
        "email": "String (unique, indexed)",
        "name": "String",
        "firebase_uid": "String (unique, indexed, nullable)",
        "photo_url": "String (nullable)",
        "provider": "String (default='local')",
        "role": "String (default='user'; 'admin' grants admin access)",
        "status": "String (default='active'; 'blocked' disables the account)",
        "created_at": "BigInteger",
        "updated_at": "BigInteger",
    },
    "user_settings": {
        "id": "String (PK)",
        "user_id": "String (FK -> users.id, unique)",
        "theme": "String",
        "language": "String",
        "provider": "String",
        "model": "String",
        "updated_at": "BigInteger",
    },
    "user_api_keys": {
        "id": "String (PK)",
        "firebase_uid": "String (FK -> users.id)",
        "provider": "String",
        "encrypted_api_key": "Text",
        "created_at": "BigInteger",
        "updated_at": "BigInteger",
    },
    "conversations": {
        "id": "String (PK)",
        "user_id": "String (FK -> users.id)",
        "title": "String",
        "provider": "String (nullable)",
        "created_at": "BigInteger",
        "updated_at": "BigInteger",
    },
    "messages": {
        "id": "String (PK)",
        "conversation_id": "String (FK -> conversations.id)",
        "role": "String",
        "content": "Text",
        "created_at": "BigInteger",
        "source": "String (default='sync')",
    },
}


# ──────────────────────────────────────────────────────────────
# Result types
# ──────────────────────────────────────────────────────────────

@dataclass
class HealthCheckResult:
    """Result of a database health check."""
    connected: bool = False
    connection_error: str = ""
    tables_ok: List[str] = field(default_factory=list)
    tables_missing: List[str] = field(default_factory=list)
    columns_ok: List[str] = field(default_factory=list)
    columns_missing: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    @property
    def is_healthy(self) -> bool:
        return (
            self.connected
            and len(self.tables_missing) == 0
            and len(self.columns_missing) == 0
        )

    def summary(self) -> str:
        """Human-readable summary for logging."""
        lines: List[str] = []

        # Connection status
        if self.connected:
            lines.append("DATABASE OK")
        else:
            lines.append("DATABASE CONNECTION FAILED")
            lines.append(f"  Error: {self.connection_error}")
            return "\n".join(lines)

        # Table check
        lines.append("")
        lines.append("Schema check:")
        for table in REQUIRED_TABLES:
            if table in self.tables_ok:
                lines.append(f"  {table} table ✅")
            else:
                lines.append(f"  {table} table ❌ MISSING")

        # Column check
        missing_cols = [c for c in self.columns_missing]
        if missing_cols:
            lines.append("")
            lines.append("Missing columns:")
            for col in missing_cols:
                lines.append(f"  {col} ❌")

        # Extra warnings
        if self.warnings:
            lines.append("")
            lines.append("Warnings:")
            for w in self.warnings:
                lines.append(f"  ⚠ {w}")

        return "\n".join(lines)


# ──────────────────────────────────────────────────────────────
# Health check logic
# ──────────────────────────────────────────────────────────────

def _connect_check() -> tuple[bool, str]:
    """Test basic database connectivity."""
    url = settings.database_url
    connect_args: dict = {}
    if url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
    elif "sslmode" not in url and settings.database_sslmode:
        connect_args["sslmode"] = settings.database_sslmode

    if not url.startswith("sqlite"):
        connect_args["connect_timeout"] = 3

    engine_kwargs: dict = {"pool_pre_ping": True, "future": True}
    if connect_args:
        engine_kwargs["connect_args"] = connect_args

    check_engine = create_engine(url, **engine_kwargs)
    try:
        with check_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True, ""
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"
    finally:
        check_engine.dispose()


def _check_tables(inspector) -> tuple[List[str], List[str]]:
    """Check which required tables exist. Returns (ok, missing)."""
    db_tables: Set[str] = set(inspector.get_table_names())
    ok = [t for t in REQUIRED_TABLES if t in db_tables]
    missing = [t for t in REQUIRED_TABLES if t not in db_tables]
    return ok, missing


def _check_columns(inspector, table_name: str) -> tuple[List[str], List[str]]:
    """Check which required columns exist in a table. Returns (ok, missing)."""
    db_columns: Set[str] = {col["name"] for col in inspector.get_columns(table_name)}
    required = REQUIRED_COLUMNS.get(table_name, {})
    ok = [f"{table_name}.{col}" for col in required if col in db_columns]
    missing = [f"{table_name}.{col}" for col in required if col not in db_columns]
    return ok, missing


def run_health_check() -> HealthCheckResult:
    """Run the full database health check. Never modifies the database."""
    result = HealthCheckResult()

    # Step 1: Connectivity
    connected, error = _connect_check()
    result.connected = connected
    result.connection_error = error
    if not connected:
        return result

    # Step 2: Inspect schema
    url = settings.database_url
    connect_args: dict = {}
    if url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
    elif "sslmode" not in url and settings.database_sslmode:
        connect_args["sslmode"] = settings.database_sslmode

    engine_kwargs: dict = {"pool_pre_ping": True, "future": True}
    if connect_args:
        engine_kwargs["connect_args"] = connect_args

    check_engine = create_engine(url, **engine_kwargs)
    try:
        with check_engine.connect() as conn:
            # For PostgreSQL, ensure we're looking at the public schema
            if not url.startswith("sqlite"):
                conn.execute(text("SET search_path TO public"))
            inspector = inspect(conn)

            # Step 3: Check tables
            tables_ok, tables_missing = _check_tables(inspector)
            result.tables_ok = tables_ok
            result.tables_missing = tables_missing

            # Step 4: Check columns for each existing table
            for table_name in tables_ok:
                cols_ok, cols_missing = _check_columns(inspector, table_name)
                result.columns_ok.extend(cols_ok)
                result.columns_missing.extend(cols_missing)

            # Step 5: Warn about tables in DB but not in models (not fatal)
            model_tables = {t for t in REQUIRED_TABLES}
            extra_tables = set(inspector.get_table_names()) - model_tables - {"alembic_version"}
            if extra_tables:
                result.warnings.append(
                    f"Tables exist in DB but not in required list: {', '.join(sorted(extra_tables))}"
                )

    finally:
        check_engine.dispose()

    return result


def check_and_log() -> HealthCheckResult:
    """Run health check and log results. Returns the result for programmatic use."""
    result = run_health_check()
    summary = result.summary()

    if result.is_healthy:
        logger.info("Database health check:\n%s", summary)
    else:
        logger.warning("Database health check:\n%s", summary)

    return result
