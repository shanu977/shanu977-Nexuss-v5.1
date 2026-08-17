"""Best-effort AI usage persistence for the Admin analytics API.

The /chat flow already computes per-attempt usage metadata (the attempt log
from ``fallback_service``). This module stores that metadata into
``usage_records`` WITHOUT ever endangering the chat request: every persistence
failure is caught, logged and swallowed so analytics can never take down chat
availability.
"""

import logging

from sqlalchemy.orm import Session

from ..models import UsageRecord, User
from ..models.models import utc_now_ms

logger = logging.getLogger("uvicorn.error")


def record_attempts(
    db: Session, user: User, request_type: str, attempts: list | None
) -> int:
    """Persist usage metadata for AI provider attempts (best effort).

    `attempts` matches the fallback attempt-log shape (provider, model,
    attempt, status, http_status, reason, input_tokens, output_tokens,
    total_tokens, response_time_ms, timestamp). Empty or None attempt lists
    are ignored. Never raises: a persistence problem must not fail the chat
    request, so every failure is logged and swallowed.
    """
    if not attempts:
        return 0

    try:
        rows = [
            UsageRecord(
                user_id=user.id,
                provider=str(attempt.get("provider") or ""),
                model=str(attempt.get("model") or ""),
                request_type=request_type,
                attempt=int(attempt.get("attempt") or 1),
                status=str(attempt.get("status") or "success"),
                http_status=attempt.get("http_status"),
                error_category=attempt.get("reason"),
                input_tokens=int(attempt.get("input_tokens") or 0),
                output_tokens=int(attempt.get("output_tokens") or 0),
                total_tokens=int(attempt.get("total_tokens") or 0),
                latency_ms=int(attempt.get("response_time_ms") or 0),
                created_at=int(attempt.get("timestamp") or utc_now_ms()),
            )
            for attempt in attempts
        ]
        db.add_all(rows)
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("[usage] Failed to persist usage records")
        return 0
    return len(rows)
