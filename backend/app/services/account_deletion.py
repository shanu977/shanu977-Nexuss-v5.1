"""Backend coordinator for permanent account deletion.

Architecture (the backend is authoritative):

    frontend --POST /account/delete--> start job (state row) --run inline--> ...
                                          ^                                    |
                                          |   background sweeper (deletion_loop)|
                                          +--------- retries with backoff -----+

Key properties:

* **Identity**: the uid/email come from the verified Firebase ID token, never
  from the request body.
* **Lock**: while a job exists, every non-account API route rejects the user
  (423) so no new user-owned rows can be created mid-deletion.
* **Idempotent**: every step tolerates "already deleted" so a partially
  completed job can be retried any number of times.
* **Resumable**: the job row is committed *before* work starts, so a browser
  closure or process restart cannot strand the deletion — the sweeper picks
  unfinished jobs back up.
* **Bounded retries**: exponential-ish backoff (1m, 5m, 15m, 30m, 1h, 2h, 4h)
  with a hard attempt cap; no uncontrolled retry loop.
* **Privacy**: the job row (the only place the uid is remembered) is deleted
  on success, and no completion/audit record is written anywhere. After a
  successful deletion nothing persistent identifies the person.
"""

import asyncio
import logging
import uuid
from typing import Callable, Iterable

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import SessionLocal
from ..models import (
    AccountDeletion,
    AppSetting,
    AuditLog,
    Conversation,
    EmailOTP,
    Feedback,
    Message,
    UsageRecord,
    User,
    UserApiKey,
    UserSettings,
)
from ..models.models import utc_now_ms
from . import firebase_service

logger = logging.getLogger("uvicorn.error")

# Job states. A completed job's row is deleted, so "completed" is only ever a
# transient API response, never stored.
STATE_QUEUED = "queued"
STATE_RUNNING = "running"
STATE_RETRY_WAIT = "retry_wait"
STATE_FAILED = "failed"
STATE_COMPLETED = "completed"

ACTIVE_STATES = (STATE_QUEUED, STATE_RUNNING, STATE_RETRY_WAIT, STATE_FAILED)

STAGE_QUEUED = "queued"
STAGE_DELETING_DATA = "deleting_data"
STAGE_REMOVING_AUTH = "removing_auth"
STAGE_VERIFYING = "verifying"

MAX_ATTEMPTS = 7
# Bounded retry schedule; attempt N waits BACKOFF_SECONDS[N-1] before retrying.
BACKOFF_SECONDS = (60, 300, 900, 1800, 3600, 7200, 14400)
# A `running` row older than this belongs to a crashed process: reclaim it.
STALE_RUNNING_MS = 5 * 60 * 1000
# How often the background sweeper looks for due jobs.
SWEEP_INTERVAL_SECONDS = 30


class DeletionStepError(Exception):
    """A deletion step did not complete. Always retryable (bounded)."""


def get_active_job(db: Session, firebase_uid: str) -> AccountDeletion | None:
    """Return the in-flight/failed deletion job for this uid, if any."""
    return db.scalar(
        select(AccountDeletion).where(AccountDeletion.firebase_uid == firebase_uid)
    )


def _normalize_email(email: str | None) -> str | None:
    """Canonical form for deletion-job emails: ``lower().strip()``.

    Auth/OTP routes already lowercase+strip addresses before storing or
    looking them up, so the job row must use the same form. Otherwise
    ``User@Example.com`` (stored raw) would not match a later
    ``user@example.com`` lock lookup and the deletion lock could be
    bypassed by casing/whitespace.
    """
    if email is None:
        return None
    normalized = email.lower().strip()
    return normalized or None


def get_active_job_by_email(db: Session, email: str | None) -> AccountDeletion | None:
    """Lookup used by the unauthenticated password/OTP routes.

    Those routes key on an email address, so an in-progress deletion for that
    address must block them from re-creating credentials mid-deletion.
    The lookup is normalized, and matches legacy rows case-insensitively
    so a job stored before normalization still locks correctly.
    """
    normalized = _normalize_email(email)
    if not normalized:
        return None
    return db.scalar(
        select(AccountDeletion)
        .where(func.lower(AccountDeletion.email) == normalized)
        .limit(1)
    )


def deletion_in_progress(db: Session, firebase_uid: str) -> bool:
    return get_active_job(db, firebase_uid) is not None


def start_deletion(db: Session, firebase_uid: str, email: str | None) -> AccountDeletion:
    """Create (or re-arm) the deletion job for this account.

    Idempotent: a second call returns the existing job. A job that had
    exhausted its retries is re-armed so the user can explicitly retry without
    being permanently stuck. The email is stored normalized
    (``lower().strip()``) so email-keyed lock lookups always match.

    Concurrent callers are safe: ``firebase_uid`` stays UNIQUE, and if two
    requests race past the initial select, the loser catches the resulting
    ``IntegrityError`` and returns the winner's row instead of 500ing.
    """
    now = utc_now_ms()
    normalized_email = _normalize_email(email)
    job = get_active_job(db, firebase_uid)
    if job is None:
        job = AccountDeletion(
            id=str(uuid.uuid4()),
            firebase_uid=firebase_uid,
            email=normalized_email,
            state=STATE_QUEUED,
            stage=STAGE_QUEUED,
            attempt=0,
            max_attempts=MAX_ATTEMPTS,
            next_attempt_at=now,
            created_at=now,
            updated_at=now,
        )
        db.add(job)
        try:
            db.commit()
        except IntegrityError:
            # Lost a concurrent insert race: another request created the job
            # first. Return the existing row instead of surfacing a 500.
            db.rollback()
            job = get_active_job(db, firebase_uid)
            if job is None:
                raise
        else:
            db.refresh(job)
            return job

    if job.state == STATE_FAILED:
        # Explicit user retry after the automatic budget was exhausted.
        job.state = STATE_QUEUED
        job.stage = STAGE_QUEUED
        job.attempt = 0
        job.next_attempt_at = now
        job.last_error = None
    if normalized_email and not job.email:
        job.email = normalized_email
    elif normalized_email and job.email != normalized_email:
        # Self-heal a legacy row stored before normalization.
        job.email = normalized_email
    job.updated_at = utc_now_ms()
    db.commit()
    db.refresh(job)
    return job


def _remove_user_rows(db: Session, firebase_uid: str, email: str | None) -> None:
    """Delete every row this account owns, children before parents.

    Safe to run repeatedly: each statement is scoped to this account and
    simply matches zero rows the second time.

    ``app_settings.updated_by`` and ``audit_log.admin_user_id`` are nulled so
    global configuration and admin history survive. Audit rows that *target*
    this account are removed: they are the one place a deleted person's
    identity would otherwise persist after completion.
    """
    conversation_ids = list(
        db.scalars(select(Conversation.id).where(Conversation.user_id == firebase_uid))
    )
    if conversation_ids:
        db.execute(
            delete(Message).where(Message.conversation_id.in_(conversation_ids))
        )
    db.execute(delete(Conversation).where(Conversation.user_id == firebase_uid))
    db.execute(delete(UserSettings).where(UserSettings.user_id == firebase_uid))
    db.execute(delete(UserApiKey).where(UserApiKey.firebase_uid == firebase_uid))
    db.execute(delete(UsageRecord).where(UsageRecord.user_id == firebase_uid))
    db.execute(delete(Feedback).where(Feedback.user_id == firebase_uid))
    if email:
        normalized = email.lower().strip()
        db.execute(delete(EmailOTP).where(EmailOTP.email == normalized))
        # Audit rows that mention the address (e.g. admin actions that carried
        # it in `details`) would re-identify the deleted account.
        db.execute(
            delete(AuditLog).where(AuditLog.details.contains(normalized))
        )
    db.execute(delete(AuditLog).where(AuditLog.target_id == firebase_uid))
    db.execute(
        update(AppSetting)
        .where(AppSetting.updated_by == firebase_uid)
        .values(updated_by=None)
    )
    db.execute(
        update(AuditLog)
        .where(AuditLog.admin_user_id == firebase_uid)
        .values(admin_user_id=None)
    )
    db.execute(delete(User).where(User.id == firebase_uid))
    db.commit()


def _remaining_rows(db: Session, firebase_uid: str, email: str | None) -> dict[str, int]:
    """Count anything still owned by the account (0 everywhere = clean)."""
    conversation_ids = list(
        db.scalars(select(Conversation.id).where(Conversation.user_id == firebase_uid))
    )
    messages = 0
    if conversation_ids:
        messages = (
            db.scalar(
                select(Message.id)
                .where(Message.conversation_id.in_(conversation_ids))
                .limit(1)
            )
            is not None
        )
    remaining = {
        "users": db.scalar(
            select(User.id).where(User.id == firebase_uid).limit(1)
        )
        is not None,
        "conversations": bool(conversation_ids),
        "messages": bool(messages),
        "settings": db.scalar(
            select(UserSettings.id)
            .where(UserSettings.user_id == firebase_uid)
            .limit(1)
        )
        is not None,
        "api_keys": db.scalar(
            select(UserApiKey.id)
            .where(UserApiKey.firebase_uid == firebase_uid)
            .limit(1)
        )
        is not None,
        "usage": db.scalar(
            select(UsageRecord.id)
            .where(UsageRecord.user_id == firebase_uid)
            .limit(1)
        )
        is not None,
        "feedback": db.scalar(
            select(Feedback.id).where(Feedback.user_id == firebase_uid).limit(1)
        )
        is not None,
        "otps": False,
    }
    if email:
        remaining["otps"] = db.scalar(
            select(EmailOTP.id)
            .where(EmailOTP.email == email.lower().strip())
            .limit(1)
        ) is not None
    return {key: int(value) for key, value in remaining.items()}


def _verify_deletion(db: Session, firebase_uid: str, email: str | None) -> None:
    """Prove nothing is left before reporting success.

    A write that raced the lock could have landed rows between the delete and
    the check; if so they are swept once more and re-checked. Anything still
    present raises so the job retries instead of reporting a false success.
    """
    remaining = _remaining_rows(db, firebase_uid, email)
    if any(remaining.values()):
        logger.warning(
            "Deletion verification found leftover rows (%s); sweeping again",
            ",".join(key for key, value in remaining.items() if value),
        )
        _remove_user_rows(db, firebase_uid, email)
        remaining = _remaining_rows(db, firebase_uid, email)
        if any(remaining.values()):
            raise DeletionStepError("Account records remain after deletion.")

    if firebase_service.user_exists(firebase_uid):
        raise DeletionStepError("The sign-in account still exists.")


def _safe_error(stage: str, exc: BaseException) -> str:
    """Operational error text that can never contain secrets or user data."""
    return f"{stage} failed ({type(exc).__name__})"


def run_job(job_id: str, db: Session | None = None) -> str | None:
    """Claim and execute one deletion attempt.

    Returns the resulting state (``completed`` / ``retry_wait`` / ``failed``)
    or ``None`` when another worker already holds the job.

    ``db`` may be supplied by tests; a fresh session is used otherwise.
    """
    own_db = db is None
    session = db if db is not None else SessionLocal()
    try:
        now = utc_now_ms()
        # Atomic claim: only one worker may move queued/retry_wait -> running.
        claimed = session.execute(
            update(AccountDeletion)
            .where(
                AccountDeletion.id == job_id,
                AccountDeletion.state.in_([STATE_QUEUED, STATE_RETRY_WAIT]),
                AccountDeletion.next_attempt_at <= now,
            )
            .values(state=STATE_RUNNING, updated_at=now)
        )
        session.commit()
        if (claimed.rowcount or 0) != 1:
            return None

        return _execute_claimed(session, job_id)
    finally:
        if own_db:
            session.close()


def _set_stage(db: Session, job_id: str, stage: str) -> None:
    db.execute(
        update(AccountDeletion)
        .where(AccountDeletion.id == job_id)
        .values(stage=stage, updated_at=utc_now_ms())
    )
    db.commit()


def _finish_failed(db: Session, job_id: str, stage: str, exc: BaseException) -> str:
    db.rollback()
    job = db.get(AccountDeletion, job_id)
    if job is None:
        return STATE_COMPLETED
    now = utc_now_ms()
    job.last_error = _safe_error(stage, exc)
    job.stage = stage
    job.updated_at = now
    if job.attempt >= job.max_attempts:
        job.state = STATE_FAILED
        logger.error(
            "Account deletion permanently failed after %s attempts at stage %s",
            job.attempt,
            stage,
        )
    else:
        delay = BACKOFF_SECONDS[min(job.attempt, len(BACKOFF_SECONDS)) - 1]
        job.state = STATE_RETRY_WAIT
        job.next_attempt_at = now + delay * 1000
        logger.warning(
            "Account deletion attempt %s failed at stage %s (%s); retrying in %ss",
            job.attempt,
            stage,
            type(exc).__name__,
            delay,
        )
    db.commit()
    db.refresh(job)
    return job.state


def _execute_claimed(db: Session, job_id: str) -> str:
    job = db.get(AccountDeletion, job_id)
    if job is None:
        return STATE_COMPLETED

    # Count this attempt before doing anything so a crash still consumes it.
    db.execute(
        update(AccountDeletion)
        .where(AccountDeletion.id == job_id)
        .values(attempt=AccountDeletion.attempt + 1, updated_at=utc_now_ms())
    )
    db.commit()
    db.refresh(job)

    firebase_uid = job.firebase_uid
    email = job.email

    steps: Iterable[tuple[str, Callable[[], None]]] = (
        (
            STAGE_DELETING_DATA,
            lambda: _remove_user_rows(db, firebase_uid, email),
        ),
        (
            STAGE_REMOVING_AUTH,
            lambda: firebase_service.delete_user(firebase_uid),
        ),
        (
            STAGE_VERIFYING,
            lambda: _verify_deletion(db, firebase_uid, email),
        ),
    )

    for stage, step in steps:
        _set_stage(db, job_id, stage)
        try:
            step()
        except Exception as exc:  # noqa: BLE001 - classified, never re-raised
            return _finish_failed(db, job_id, stage, exc)

    # Success: drop the operational state so no trace of the deletion (or the
    # person) remains anywhere in the database.
    db.execute(delete(AccountDeletion).where(AccountDeletion.id == job_id))
    db.commit()
    logger.info("Account deletion completed and operational state removed")
    return STATE_COMPLETED


def run_due_jobs(db: Session | None = None) -> int:
    """Reclaim stale jobs and run everything that is due. Returns #run."""
    own_db = db is None
    session = db if db is not None else SessionLocal()
    try:
        now = utc_now_ms()
        # A process that died mid-run leaves `running` rows behind: requeue
        # them (without burning an attempt) so deletion resumes automatically.
        session.execute(
            update(AccountDeletion)
            .where(
                AccountDeletion.state == STATE_RUNNING,
                AccountDeletion.updated_at < now - STALE_RUNNING_MS,
            )
            .values(state=STATE_QUEUED, updated_at=now)
        )
        session.commit()

        due_ids = list(
            session.scalars(
                select(AccountDeletion.id)
                .where(
                    AccountDeletion.state.in_([STATE_QUEUED, STATE_RETRY_WAIT]),
                    AccountDeletion.next_attempt_at <= now,
                )
                .order_by(AccountDeletion.next_attempt_at.asc())
                .limit(10)
            )
        )
        ran = 0
        for job_id in due_ids:
            if run_job(job_id, session) is not None:
                ran += 1
        return ran
    finally:
        if own_db:
            session.close()


async def deletion_loop() -> None:
    """Background sweeper: keeps deleting while the app is up.

    Started from the FastAPI lifespan. Jobs created by an earlier process (or
    after a crash/restart) are picked up here — the browser does not need to
    stay open for deletion to finish.
    """
    while True:
        try:
            ran = await asyncio.to_thread(run_due_jobs)
            if ran:
                logger.info("Account deletion sweeper processed %s job(s)", ran)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "Account deletion sweep failed; retrying soon (%s)",
                type(exc).__name__,
            )
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)


def status_payload(job: AccountDeletion | None) -> dict:
    """Public view of a job: stage progress, never internal identifiers."""
    if job is None:
        return {
            "state": "none",
            "stage": None,
            "attempt": 0,
            "next_attempt_at": None,
            "last_error": None,
        }
    return {
        "state": job.state,
        "stage": job.stage,
        "attempt": job.attempt,
        "next_attempt_at": job.next_attempt_at,
        "last_error": job.last_error,
    }
