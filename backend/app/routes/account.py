"""Self-service account endpoints: profile facts, data export, deletion.

Security model (mirrors the rest of the API):
  * Identity comes exclusively from a Firebase ID token verified by the
    Firebase Admin SDK. The client never supplies a user id; the verified
    session decides which account is affected, so a user can only ever delete
    (or inspect) their own account.
  * Deletion additionally requires the exact confirmation literal ``DELETE``
    and a *freshly issued* ID token (``iat`` within
    ``RECENT_AUTH_MAX_AGE_SECONDS``). The frontend performs a real Firebase
    re-authentication (password re-entry, or the Google popup for OAuth
    accounts) before refreshing the token, so a stale/stolen bearer token
    cannot destroy an account.
  * The actual deletion is executed by the backend coordinator in
    ``services.account_deletion`` — a resumable, idempotent, server-side job
    with bounded retries. This route only *starts* it and reports progress.
  * Service-account credentials (Firebase Admin) are used only server-side.
"""

import logging
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    Conversation,
    Feedback,
    Message,
    User,
    UserApiKey,
    UserSettings,
    UsageRecord,
)
from ..routes.deps import get_current_user, get_verified_firebase_session
from ..schemas.account import (
    AccountInfoOut,
    DeleteAccountIn,
    DeleteAccountOut,
    DeletionStatusOut,
)
from ..services import account_deletion

logger = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/account", tags=["account"])

# A self-deletion request must present an ID token issued within this window.
# The frontend force-refreshes the token *after* re-authenticating right
# before calling, so a compliant client always passes; a leaked, hour-old
# bearer token does not.
RECENT_AUTH_MAX_AGE_SECONDS = 5 * 60

DELETE_CONFIRMATION_LITERAL = "DELETE"

_STATE_DETAILS = {
    account_deletion.STATE_QUEUED: (
        "Deletion has started and continues on our servers. It is safe to "
        "close this window."
    ),
    account_deletion.STATE_RUNNING: (
        "Your account and personal data are being permanently deleted. "
        "Please don't close this window."
    ),
    account_deletion.STATE_RETRY_WAIT: (
        "A step did not finish and will be retried automatically. Deletion "
        "continues on our servers."
    ),
    account_deletion.STATE_FAILED: (
        "Deletion could not be completed automatically. Please retry."
    ),
    account_deletion.STATE_COMPLETED: (
        "The account and all associated Nexuss data were deleted."
    ),
}


@router.get("", response_model=AccountInfoOut)
def get_account(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return the non-sensitive profile facts for the signed-in account."""
    user_settings = db.scalar(
        select(UserSettings).where(UserSettings.user_id == user.id)
    )
    return AccountInfoOut(
        email=user.email or "",
        name=user.name or "",
        photo_url=user.photo_url,
        provider=user.provider or "firebase",
        role=user.role or "user",
        created_at=user.created_at,
    )


@router.get("/export")
def export_account_data(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Export everything this account owns on the server, as JSON.

    Chat history in the current web client lives in the browser (IndexedDB)
    and is exported client-side; this payload covers the server-side copy of
    the account. Encrypted provider API keys are deliberately never returned.
    """
    conversations = db.scalars(
        select(Conversation)
        .where(Conversation.user_id == user.id)
        .order_by(Conversation.created_at.asc(), Conversation.id.asc())
    ).all()

    conversation_out = []
    for conv in conversations:
        messages = db.scalars(
            select(Message)
            .where(Message.conversation_id == conv.id)
            .order_by(Message.created_at.asc(), Message.id.asc())
        ).all()
        conversation_out.append(
            {
                "id": conv.id,
                "title": conv.title,
                "provider": conv.provider,
                "createdAt": conv.created_at,
                "updatedAt": conv.updated_at,
                "messages": [
                    {
                        "role": msg.role,
                        "content": msg.content,
                        "source": msg.source,
                        "createdAt": msg.created_at,
                    }
                    for msg in messages
                ],
            }
        )

    api_keys = db.scalars(
        select(UserApiKey)
        .where(UserApiKey.firebase_uid == user.id)
        .order_by(UserApiKey.created_at.asc())
    ).all()

    usage_records = db.scalars(
        select(UsageRecord)
        .where(UsageRecord.user_id == user.id)
        .order_by(UsageRecord.created_at.desc())
    ).all()

    feedback_rows = db.scalars(
        select(Feedback)
        .where(Feedback.user_id == user.id)
        .order_by(Feedback.created_at.desc())
    ).all()

    user_settings = db.scalar(
        select(UserSettings).where(UserSettings.user_id == user.id)
    )

    return {
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "account": {
            "email": user.email,
            "name": user.name,
            "photoUrl": user.photo_url,
            "signInProvider": user.provider,
            "role": user.role,
            "createdAt": user.created_at,
            "updatedAt": user.updated_at,
        },
        "settings": (
            {
                "theme": user_settings.theme,
                "language": user_settings.language,
                "provider": user_settings.provider,
                "model": user_settings.model,
                "updatedAt": user_settings.updated_at,
            }
            if user_settings
            else None
        ),
        # Metadata only: the encrypted ciphertext of a provider key is never
        # exported (it is useless without the server-side Fernet key anyway).
        "apiKeys": [
            {
                "provider": key.provider,
                "createdAt": key.created_at,
                "updatedAt": key.updated_at,
            }
            for key in api_keys
        ],
        "conversations": conversation_out,
        "usageRecords": [
            {
                "provider": rec.provider,
                "model": rec.model,
                "requestType": rec.request_type,
                "attempt": rec.attempt,
                "status": rec.status,
                "httpStatus": rec.http_status,
                "errorCategory": rec.error_category,
                "inputTokens": rec.input_tokens,
                "outputTokens": rec.output_tokens,
                "totalTokens": rec.total_tokens,
                "latencyMs": rec.latency_ms,
                "createdAt": rec.created_at,
            }
            for rec in usage_records
        ],
        "feedback": [
            {
                "rating": row.rating,
                "message": row.message,
                "status": row.status,
                "createdAt": row.created_at,
            }
            for row in feedback_rows
        ],
        "notes": [
            "Encrypted provider API keys are never included in an export.",
            "Chat history created in the Nexuss web app is stored in this "
            "browser only and is exported separately by the client.",
        ],
    }


def _require_recent_authentication(decoded: dict) -> None:
    """Reject deletion when the bearer token was not issued recently.

    ``iat`` is signed by Firebase and cannot be forged by the client. It is
    the server-side proof that the caller re-authenticated (the client only
    refreshes the token *after* a successful password/OAuth re-auth) moments
    ago. Test mock tokens carry no ``iat`` and are only ever accepted while
    pytest is running (see ``deps._verify_bearer_token``).
    """
    issued_at = decoded.get("iat")
    if issued_at is None:
        return
    try:
        age = time.time() - float(issued_at)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your session could not be verified. Please sign in again.",
        )
    if age > RECENT_AUTH_MAX_AGE_SECONDS:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=(
                "For your security, account deletion requires you to "
                "re-authenticate. Please sign out, sign in again, and retry."
            ),
        )


def _status_for_job(
    db: Session, firebase_uid: str, detail: str | None = None
) -> DeletionStatusOut:
    job = account_deletion.get_active_job(db, firebase_uid)
    payload = account_deletion.status_payload(job)
    return DeletionStatusOut(
        state=payload["state"],
        stage=payload["stage"],
        attempt=payload["attempt"],
        next_attempt_at=payload["next_attempt_at"],
        last_error=payload["last_error"],
        detail=detail or _STATE_DETAILS.get(payload["state"]),
    )


@router.get("/deletion", response_model=DeletionStatusOut)
def get_deletion_status(
    identity: tuple[str, dict, User | None] = Depends(get_verified_firebase_session),
    db: Session = Depends(get_db),
):
    """Current deletion state for the signed-in account.

    The browser uses this to *resume* a deletion that was started earlier (or
    in another tab) and to poll progress without ever re-triggering work. It
    works even after the ``users`` row is gone, because identity comes from
    the verified token rather than a database row.
    """
    firebase_uid, _decoded, _user = identity
    return _status_for_job(db, firebase_uid)


@router.post("/delete", response_model=DeleteAccountOut)
def delete_account(
    payload: DeleteAccountIn,
    identity: tuple[str, dict, User | None] = Depends(get_verified_firebase_session),
    db: Session = Depends(get_db),
):
    """Start (or resume) permanent deletion of the signed-in account.

    The request only *creates the job*: every destructive step runs in the
    backend coordinator, which survives the browser closing and retries with
    a bounded backoff schedule. The response reports the current state — a
    success message is returned only after the deletion has been verified.
    """
    firebase_uid, decoded, user = identity

    if payload.confirmation != DELETE_CONFIRMATION_LITERAL:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='Type "DELETE" to confirm account deletion.',
        )

    _require_recent_authentication(decoded)

    if user is not None and user.role == "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Administrator accounts cannot be deleted from the app. "
                "Contact support to have the account removed."
            ),
        )

    existing = account_deletion.get_active_job(db, firebase_uid)
    email = (user.email if user is not None else None) or (existing.email if existing else None)
    if email is None:
        email = decoded.get("email")

    job = account_deletion.start_deletion(db, firebase_uid, email)
    attempts_before = job.attempt

    # First attempt runs inline so the caller gets immediate feedback; later
    # attempts are driven by the background sweeper if this one fails.
    result_state = account_deletion.run_job(job.id, db)
    if result_state is None:
        # Another worker holds the job — report its live state.
        return _status_for_job(db, firebase_uid)

    if result_state == account_deletion.STATE_COMPLETED:
        return DeleteAccountOut(
            state=account_deletion.STATE_COMPLETED,
            stage=account_deletion.STAGE_VERIFYING,
            attempt=attempts_before + 1,
            next_attempt_at=None,
            last_error=None,
            detail=_STATE_DETAILS[account_deletion.STATE_COMPLETED],
        )

    return _status_for_job(db, firebase_uid)
