from typing import Generator
from urllib.parse import urlparse

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings


def _connect_args(url: str) -> dict:
    connect_args: dict = {}
    if url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
    elif "sslmode" not in url and settings.database_sslmode:
        connect_args["sslmode"] = settings.database_sslmode
    if not url.startswith("sqlite"):
        # Fail fast on an unreachable host instead of letting psycopg2 block
        # indefinitely (the default). Surfaces transient DNS/network outages
        # quickly so workers can retry rather than hang.
        connect_args["connect_timeout"] = settings.database_connect_timeout
    return connect_args


def _build_engine():
    url = settings.database_url
    connect_args = _connect_args(url)

    if url.startswith("sqlite"):
        # Local development only. Production uses PostgreSQL (DATABASE_URL).
        return create_engine(
            url,
            connect_args=connect_args,
            pool_pre_ping=True,
            future=True,
        )

    # PostgreSQL (Supabase / Railway production)
    engine_kwargs: dict = {
        "pool_pre_ping": True,
        "future": True,
        "pool_size": settings.db_pool_size,
        "max_overflow": settings.db_max_overflow,
        "pool_recycle": settings.db_pool_recycle,
    }
    if connect_args:
        engine_kwargs["connect_args"] = connect_args

    return create_engine(url, **engine_kwargs)


engine = _build_engine()

SessionLocal = sessionmaker(
    bind=engine, autocommit=False, autoflush=False, future=True
)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def db_display_host(url: str) -> str:
    """Host:port for logs/errors. Never includes credentials."""
    try:
        parsed = urlparse(url)
        return f"{parsed.hostname or 'unknown'}:{parsed.port or 5432}"
    except Exception:
        return "unknown"


def check_database() -> tuple[bool, str]:
    """Run a live SELECT 1 against the configured database.

    Returns (ok, message). The message is safe for logs and never exposes
    passwords or the full connection string. Uses a short connect timeout so
    failures surface fast at startup.
    """
    from sqlalchemy import text

    url = settings.database_url
    connect_args = _connect_args(url)
    # SQLite's sqlite3 driver rejects the PostgreSQL-only connect_timeout kwarg
    if not url.startswith("sqlite"):
        connect_args["connect_timeout"] = 3

    engine_kwargs: dict = {"pool_pre_ping": True, "future": True}
    if connect_args:
        engine_kwargs["connect_args"] = connect_args

    check_engine = create_engine(url, **engine_kwargs)
    try:
        with check_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True, f"OK 1 (database {db_display_host(url)})"
    except Exception as exc:
        return (
            False,
            f"Database connection failed for host {db_display_host(url)}: "
            f"{type(exc).__name__}: {exc}",
        )
    finally:
        check_engine.dispose()
