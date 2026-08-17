import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import settings
from .database import Base, engine, check_database, get_db
from .middleware.rate_limit import RateLimitMiddleware
from .routes import (
    admin,
    admin_analytics,
    admin_feedback,
    admin_security,
    admin_settings,
    admin_users,
    api_keys,
    auth,
    chat,
    conversations,
    settings as settings_router,
    sync,
)
from .services import firebase_service
from .services.cleanup import cleanup_loop
from .services.db_health import check_and_log
from .services.fallback_service import ProviderFailureError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Idempotent: creates any missing tables on startup (dev SQLite and
    # Supabase/PostgreSQL alike), e.g. `user_api_keys` on first deploy.
    # Skip live-DB work while running the test suite (keeps tests hermetic).
    is_test = "PYTEST_CURRENT_TEST" in os.environ
    if not is_test:
        Base.metadata.create_all(bind=engine)
        result = check_and_log()
        if not result.is_healthy:
            logger.warning(
                "Schema issues detected. Run: alembic upgrade head"
            )
        firebase_service.initialize_firebase()
    task = None
    if not is_test:
        task = asyncio.create_task(cleanup_loop())
    logger.info("Backend started")
    yield
    if task is not None:
        task.cancel()


app = FastAPI(
    title="Chatbot SaaS API",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(RateLimitMiddleware, max_requests=20, window_seconds=60, paths=("/chat",))

app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(admin_users.router)
app.include_router(admin_analytics.router)
app.include_router(admin_feedback.router)
app.include_router(admin_settings.router)
app.include_router(admin_security.router)
app.include_router(sync.router)
app.include_router(settings_router.router)
app.include_router(api_keys.router)
app.include_router(chat.router)
app.include_router(conversations.router)


@app.exception_handler(ProviderFailureError)
async def provider_failure_handler(request, exc: ProviderFailureError):
    """Return provider failures with their attempt log (detail stays a string
    so clients that only read `detail` keep working)."""
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.message, "attempts": exc.attempts},
    )


@app.get("/health")
def health(db: Session = Depends(get_db)):
    """Readiness probe: returns 503 if the database is unreachable.

    Uses get_db so tests (which override it with SQLite) stay hermetic.
    """
    try:
        db.execute(text("SELECT 1"))
        return {"status": "ok", "database": "ok"}
    except Exception:
        raise HTTPException(status_code=503, detail="Database unavailable")
