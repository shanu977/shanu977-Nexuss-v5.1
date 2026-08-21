import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.orm import Session
from starlette.exceptions import HTTPException as StarletteHTTPException

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


def _add_cors_headers(response, request: Request) -> JSONResponse:
    """Add CORS headers to a response if the request origin is allowed.
    
    This is a safety net to ensure error responses always include proper CORS headers,
    even if the CORSMiddleware somehow doesn't reach them. In normal operation, the
    middleware handles CORS; this is a fallback for edge cases.
    """
    origin = request.headers.get("origin")
    if origin and origin in settings.cors_origins_list:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
    return response


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

# Middleware order: add_middleware() is LIFO — the LAST call added is the
# OUTERMOST wrapper (executes first). CORSMiddleware MUST be outermost so that:
#   1. OPTIONS preflight requests are handled before reaching RateLimitMiddleware.
#   2. All responses (including 429 from RateLimitMiddleware) include the
#      Access-Control-Allow-Origin header the browser requires.
# Do NOT swap this order without understanding the LIFO semantics.
app.add_middleware(
    RateLimitMiddleware,
    max_requests=20,
    window_seconds=60,
    paths=("/chat",),
    path_limits=(
        ("/auth/otp/send", 5),
        ("/auth/user-status", 10),
        ("/admin/", 15),
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    """Global exception handler for HTTPException that ensures CORS headers are included."""
    response = JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
    )
    return _add_cors_headers(response, request)


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    """Catch-all exception handler for unexpected errors, ensures CORS headers are included."""
    logger.exception(f"Unhandled exception: {exc}")
    response = JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )
    return _add_cors_headers(response, request)


@app.exception_handler(ProviderFailureError)
async def provider_failure_handler(request: Request, exc: ProviderFailureError):
    """Return provider failures with their attempt log (detail stays a string
    so clients that only read `detail` keep working)."""
    response = JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.message, "attempts": exc.attempts},
    )
    return _add_cors_headers(response, request)


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
