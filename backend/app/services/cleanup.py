import asyncio
import logging

from sqlalchemy import delete
from sqlalchemy.orm import Session

from ..config import settings
from ..database import SessionLocal
from ..models import Message
from ..models.models import utc_now_ms

logger = logging.getLogger("uvicorn.error")


def cleanup_old_messages(db: Session | None = None, retention_days: int | None = None) -> int:
    days = retention_days or settings.retention_days
    cutoff = utc_now_ms() - days * 24 * 60 * 60 * 1000

    own_db = db is None
    session = db if db is not None else SessionLocal()
    try:
        # Only sync'd device data is subject to retention. Chat history
        # (source='chat') backs the AI memory feature and is never deleted.
        result = session.execute(
            delete(Message)
            .where(Message.source == "sync")
            .where(Message.created_at < cutoff)
        )
        if own_db:
            session.commit()
        return result.rowcount or 0
    finally:
        if own_db:
            session.close()


async def cleanup_loop() -> None:
    retry_delay_seconds = 60
    while True:
        try:
            deleted = cleanup_old_messages()
            if deleted:
                logger.info("Retention cleanup deleted %s message(s)", deleted)
            # Back to the normal schedule on success.
            await asyncio.sleep(settings.cleanup_interval_hours * 60 * 60)
        except Exception as exc:  # pragma: no cover
            # A transient DB/DNS outage must never crash the app or stall the
            # loop: log it and retry soon instead of waiting the full interval.
            logger.warning(
                "Retention cleanup failed; retrying in %ss: %s",
                retry_delay_seconds,
                exc,
            )
            await asyncio.sleep(retry_delay_seconds)
