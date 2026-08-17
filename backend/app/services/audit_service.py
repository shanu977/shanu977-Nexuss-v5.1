"""Audit trail helper for Admin mutations.

Stages/writes ``audit_log`` rows so every important Admin action is traceable
(who, action, target, non-sensitive details, IP when known).

* ``add_admin_action`` stages the row on the caller's session so it commits
  atomically with the mutation itself — an audit entry is only persisted when
  the mutation succeeds.
* ``record_admin_action`` stages and commits immediately.

Never stores sensitive data: details are limited to non-sensitive context
(e.g. before/after role values), never tokens, API keys, or content.
"""

import json
import logging

from fastapi import Request
from sqlalchemy.orm import Session

from ..models import AuditLog, User
from ..models.models import utc_now_ms

logger = logging.getLogger("uvicorn.error")


def client_ip(request: Request | None) -> str | None:
    """Best-effort client IP for audit context (None when unavailable)."""
    if request is None:
        return None
    return request.client.host if request.client is not None else None


def _details_json(details) -> str | None:
    if details is None:
        return None
    if isinstance(details, str):
        return details
    try:
        return json.dumps(details, default=str)
    except (TypeError, ValueError):
        logger.warning("[audit] Could not serialize details; storing repr")
        return str(details)


def add_admin_action(
    db: Session,
    admin: User,
    action: str,
    *,
    target_type: str | None = None,
    target_id: str | None = None,
    details=None,
    ip_address: str | None = None,
) -> AuditLog:
    """Stage an AuditLog row on the session. Caller commits (atomic mutation)."""
    entry = AuditLog(
        admin_user_id=admin.id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        details=_details_json(details),
        ip_address=ip_address,
        created_at=utc_now_ms(),
    )
    db.add(entry)
    return entry


def record_admin_action(
    db: Session,
    admin: User,
    action: str,
    *,
    target_type: str | None = None,
    target_id: str | None = None,
    details=None,
    ip_address: str | None = None,
) -> AuditLog:
    """Stage an AuditLog row and commit immediately."""
    entry = add_admin_action(
        db,
        admin,
        action,
        target_type=target_type,
        target_id=target_id,
        details=details,
        ip_address=ip_address,
    )
    db.commit()
    return entry
