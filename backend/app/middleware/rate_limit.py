import time
from collections import defaultdict, deque
from typing import Callable, Sequence

from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp

from ..config import settings

MAX_TRACKED_KEYS = 10_000

# Test support: track middleware instances so the test suite can reset the
# in-memory windows between tests (all TestClient calls share one client host,
# so a full suite can otherwise exhaust the 60/min budget).
_instances: set["RateLimitMiddleware"] = set()


def reset_rate_limits() -> None:
    for instance in list(_instances):
        instance._hits.clear()


class RateLimitMiddleware(BaseHTTPMiddleware):
    """In-memory sliding-window rate limiter per (client, path).

    Client identity comes from the socket peer address unless
    TRUST_PROXY_HEADERS=true is set (and the proxy overwrites X-Forwarded-For).
    Not suitable for multi-instance production clusters; swap for a Redis-backed
    limiter (e.g. slowapi) when scaling horizontally.
    """

    def __init__(
        self,
        app: ASGIApp,
        max_requests: int = 60,
        window_seconds: int = 60,
        paths: Sequence[str] = ("/chat",),
    ):
        super().__init__(app)
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.paths = tuple(paths)
        self._hits: dict[str, deque] = defaultdict(deque)
        _instances.add(self)

    def _client_id(self, request: Request) -> str:
        if settings.trust_proxy_headers:
            forwarded = request.headers.get("x-forwarded-for")
            if forwarded:
                return forwarded.split(",")[0].strip()
        return request.client.host if request.client else "unknown"

    def _prune(self, now: float) -> None:
        """Drop expired windows and untracked keys so memory stays bounded."""
        cutoff = now - self.window_seconds
        for key in list(self._hits):
            while self._hits[key] and self._hits[key][0] < cutoff:
                self._hits[key].popleft()
            if not self._hits[key]:
                del self._hits[key]

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        if not any(request.url.path.startswith(p) for p in self.paths):
            return await call_next(request)

        now = time.monotonic()
        if len(self._hits) > MAX_TRACKED_KEYS:
            self._prune(now)

        key = f"{self._client_id(request)}:{request.url.path}"

        window = self._hits[key]
        while window and window[0] < now - self.window_seconds:
            window.popleft()

        if len(window) >= self.max_requests:
            # Return an HTTP response directly. Raising HTTPException here would
            # bypass FastAPI's exception handlers (this middleware sits outside
            # the ExceptionMiddleware) and surface as a 500 instead of a 429.
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests. Please try again later."},
            )

        window.append(now)
        return await call_next(request)
