"""Centralized provider fallback/router layer.

Single place that turns a primary (provider, model) chat request into a bounded
attempt chain:

    request -> primary provider/model -> execute -> classify error
             -> temporary? -> next configured fallback -> execute
             -> success OR all exhausted -> clear error

Only temporary failures (rate limits, quota/overload, 5xx, network) trigger a
fallback. Permanent errors (bad requests, invalid keys, unknown models, empty
responses) are surfaced immediately. The user's saved provider/model are never
modified: fallback is strictly per-request and cooldowns are in-memory and
expiring. The same provider/model is never attempted twice in one request.
"""

import logging
import threading
import time
from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from ..config import settings
from ..models import User
from ..schemas.settings import ALLOWED_MODELS
from . import api_key_service, llm_service

logger = logging.getLogger("uvicorn.error")

# Canonical fallback priority after the user's selection. Order is intentional:
# OpenRouter free models first, then Gemini free models, then any other
# configured provider (Groq). The primary provider is always attempted first.
FALLBACK_PRIORITY = ("openrouter", "gemini", "groq")

# Failure categories that are temporary and therefore eligible for fallback.
_TEMPORARY_CATEGORIES = {
    "rate_limit",
    "overload",
    "provider_unavailable",
    "network",
}


class ProviderFailureError(Exception):
    """Error with an HTTP status and optional attempt log for the API layer.

    `attempts` (a list of dicts) is included in the response body so the client
    can record usage for every attempted provider/model, including failures.
    """

    def __init__(
        self,
        status_code: int,
        message: str,
        attempts: Optional[List[dict]] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.attempts = attempts or []


class ProviderCooldown:
    """In-memory per-provider cooldown after a rate limit.

    Keyed by provider so a single 429 never permanently disables anything:
    cooldowns expire automatically and the provider is retried afterwards.
    """

    def __init__(self, default_seconds: int) -> None:
        self._default_seconds = default_seconds
        self._cooldowns: Dict[str, float] = {}
        self._lock = threading.Lock()

    def mark(self, provider: str, retry_after: Optional[float]) -> None:
        seconds = (
            retry_after if retry_after and retry_after > 0 else float(self._default_seconds)
        )
        if seconds <= 0:
            return
        expires = time.monotonic() + seconds
        with self._lock:
            self._cooldowns[provider] = max(
                self._cooldowns.get(provider, 0.0), expires
            )

    def active(self, provider: str) -> bool:
        with self._lock:
            expires = self._cooldowns.get(provider)
            if expires is None:
                return False
            if time.monotonic() >= expires:
                del self._cooldowns[provider]
                return False
            return True

    def clear(self, provider: str | None = None) -> None:
        with self._lock:
            if provider is None:
                self._cooldowns.clear()
            else:
                self._cooldowns.pop(provider, None)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _resolve_key_optional(db: Session, user: User, provider: str) -> Optional[str]:
    """Resolve a provider's API key, returning None when the user has none.

    Used for fallback eligibility: a fallback without a key is skipped, never
    attempted. The key is decrypted in memory only and never logged.
    """
    try:
        key = api_key_service.get_decrypted_key(db, user, provider)
    except ValueError:
        logger.warning("[AI] Could not decrypt stored key for provider=%s", provider)
        return None
    if key:
        return key
    if provider == "groq":
        try:
            return llm_service.get_api_key()
        except llm_service.MissingAPIKeyError:
            return None
    return None


def _resolve_key_strict(db: Session, user: User, provider: str) -> str:
    """Resolve the primary provider's key, raising for a missing/undecryptable key."""
    try:
        key = api_key_service.get_decrypted_key(db, user, provider)
    except ValueError as exc:
        raise llm_service.InvalidAPIKeyError(str(exc)) from exc
    if key:
        return key
    if provider == "groq":
        try:
            return llm_service.get_api_key()
        except llm_service.MissingAPIKeyError:
            pass
    raise llm_service.MissingAPIKeyError(
        f"No API key saved for provider '{provider}'. "
        "Add one in Settings to continue."
    )


def _build_chain(
    db: Session,
    user: User,
    primary_provider: str,
    primary_model: str,
    fallback_models: Optional[Dict[str, str]] = None,
) -> List[Tuple[str, str, str]]:
    """Build the ordered attempt chain: primary first, then configured fallbacks.

    A candidate is only included when it is configured and has a usable API
    key, its model exists and belongs to that provider, and it is not in
    cooldown. The primary provider with no key is a permanent config error.

    `fallback_models` overrides the fallback model per provider (used by the
    screen-analysis path so every candidate is vision-capable). Models coming
    from this server-side override are trusted and skip the ALLOWED_MODELS
    check; only the user-selected primary model is strictly validated upstream.
    """
    candidates: List[Tuple[str, str, str]] = []
    seen: set = set()

    def add(provider: str, model: str, key: str) -> None:
        if provider in seen:
            return
        seen.add(provider)
        candidates.append((provider, model, key))

    if not cooldown.active(primary_provider):
        primary_key = _resolve_key_strict(db, user, primary_provider)
        add(primary_provider, primary_model, primary_key)

    for provider in FALLBACK_PRIORITY:
        if provider == primary_provider or cooldown.active(provider):
            continue
        if fallback_models is not None:
            model = fallback_models.get(provider)
            if model is None:
                continue
        else:
            model = llm_service.PROVIDER_DEFAULT_MODELS.get(provider)
            if model is None or model not in ALLOWED_MODELS.get(provider, set()):
                continue
        key = _resolve_key_optional(db, user, provider)
        if key is None:
            continue  # skip fallbacks without a configured API key
        add(provider, model, key)

    return candidates


def _attempt_failed(
    provider: str, model: str, index: int, exc: llm_service.AIProviderError, elapsed_ms: int
) -> dict:
    return {
        "provider": provider,
        "model": model,
        "attempt": index,
        "status": "failed",
        "http_status": exc.http_status,
        "reason": exc.category,
        "input_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "response_time_ms": elapsed_ms,
        "timestamp": _now_ms(),
    }


def _attempt_success(
    provider: str, model: str, index: int, usage: llm_service.UsageInfo, elapsed_ms: int
) -> dict:
    return {
        "provider": provider,
        "model": model,
        "attempt": index,
        "status": "success",
        "http_status": 200,
        "reason": None,
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
        "response_time_ms": elapsed_ms,
        "timestamp": _now_ms(),
    }


def _log_failure(provider: str, exc: llm_service.AIProviderError) -> None:
    reason = exc.category or type(exc).__name__
    if exc.http_status is not None:
        logger.info("[AI] Failed: %s/%s", exc.http_status, reason)
    else:
        logger.info("[AI] Failed: %s", reason)


def execute_with_fallback(
    db: Session,
    user: User,
    messages: List[Dict],
    primary_provider: str,
    primary_model: str,
    fallback_models: Optional[Dict[str, str]] = None,
) -> dict:
    """Run the bounded attempt chain for a chat request.

    Returns a dict with `reply`, `provider`, `model`, `usage`, `attempts` and
    `fallback_used` (a human-readable notice when a fallback produced the
    reply). Raises a `ProviderFailureError` when every candidate fails; the
    error carries the full attempt log so usage can be recorded client-side.

    `fallback_models` is forwarded to the chain builder so screen-analysis
    requests only fall back to vision-capable models.
    """
    candidates = _build_chain(
        db, user, primary_provider, primary_model, fallback_models=fallback_models
    )
    if not candidates:
        raise ProviderFailureError(
            status_code=503,
            message=(
                "The selected provider is temporarily unavailable and no "
                "fallback provider is configured. Please try again later."
            ),
        )

    attempts: List[dict] = []
    last_error: Optional[llm_service.AIProviderError] = None

    for index, (provider, model, key) in enumerate(candidates, start=1):
        # "Primary" means the user's selected provider, not merely index 1: the
        # primary may have been skipped during cooldown, in which case the
        # first executed candidate is really a fallback.
        is_primary = provider == primary_provider
        label = "Primary" if is_primary else "Fallback"
        logger.info("[AI] %s: %s/%s", label, provider.capitalize(), model)

        started = time.perf_counter()
        try:
            reply, usage = llm_service.complete(
                messages, provider=provider, model=model, api_key=key
            )
        except llm_service.AIProviderError as exc:
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            attempts.append(_attempt_failed(provider, model, index, exc, elapsed_ms))
            _log_failure(provider, exc)

            if exc.category == "rate_limit":
                cooldown.mark(provider, getattr(exc, "retry_after", None))

            if exc.category not in _TEMPORARY_CATEGORIES:
                if is_primary:
                    # Permanent error on the primary: surface it, never fall back.
                    raise ProviderFailureError(
                        status_code=_permanent_status(exc),
                        message=str(exc),
                        attempts=attempts,
                    )
                # Permanent error on a fallback: skip this one, keep the chain.
                last_error = exc
                continue
            last_error = exc
            continue

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        attempts.append(_attempt_success(provider, model, index, usage, elapsed_ms))
        logger.info("[AI] Success: %s/%s", provider.capitalize(), model)

        notice = None
        if not is_primary:
            notice = (
                f"{primary_provider.capitalize()} was temporarily unavailable. "
                f"Response generated using {provider.capitalize()}."
            )
        return {
            "reply": reply,
            "provider": provider,
            "model": model,
            "usage": usage,
            "attempts": attempts,
            "fallback_used": notice,
        }

    # Every candidate exhausted without a success.
    if last_error is not None:
        raise ProviderFailureError(
            status_code=_temporary_status(last_error),
            message=str(last_error),
            attempts=attempts,
        )
    raise ProviderFailureError(
        status_code=502,
        message="All AI providers failed. Please try again later.",
        attempts=attempts,
    )


def _permanent_status(exc: llm_service.AIProviderError) -> int:
    """HTTP status for a permanent provider error surfaced to the client."""
    if isinstance(exc, llm_service.BadRequestError):
        return 400
    if isinstance(exc, llm_service.InvalidModelError):
        return 400
    if isinstance(exc, llm_service.InvalidAPIKeyError):
        return 502
    if isinstance(exc, llm_service.EmptyResponseError):
        return 502
    if isinstance(exc, llm_service.UnsupportedProviderError):
        return 400
    if isinstance(exc, llm_service.MissingAPIKeyError):
        return 503
    return 502


def _temporary_status(exc: llm_service.AIProviderError) -> int:
    if isinstance(exc, llm_service.RateLimitError):
        return 429
    if isinstance(exc, llm_service.ProviderUnavailableError):
        return 502
    return 502


def reset_fallback_state() -> None:
    """Clear all in-memory cooldowns (used by the test suite between tests)."""
    cooldown.clear()

# Module-level singleton so cooldown state survives individual requests.
cooldown = ProviderCooldown(int(settings.ai_fallback_cooldown_seconds))
