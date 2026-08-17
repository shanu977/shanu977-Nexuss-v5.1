"""Admin Security API — read-only audit trail.

Minimal endpoint required by the Phase 4 Security page: a paginated,
filterable view over the real ``audit_log`` rows that Phase 3's
``audit_service`` writes. Admin-only. Never exposes sensitive values: the
audit ``details`` blob is non-sensitive by construction (audit_service never
stores tokens, keys, passwords, or content), and email/name are resolved
from the users table (NULL when the admin was deleted).

2FA/session management is intentionally out of scope for this phase.
"""

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AuditLog, User
from ..routes.deps import get_current_admin
from ..schemas.admin import AuditLogList, AuditLogOut

router = APIRouter(prefix="/admin/security", tags=["admin-security"])

logger = logging.getLogger("uvicorn.error")


def _parse_details(raw: str | None) -> dict | None:
    """Parse the audit details JSON blob. Never surfaces secrets — the writer
    already restricts contents to non-sensitive before/after context."""
    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except (TypeError, ValueError):
        return None


@router.get("/audit", response_model=AuditLogList)
def list_audit(
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str | None = Query(None, max_length=200),
    action: str | None = Query(None, max_length=120),
    target_type: str | None = Query(None, max_length=120),
    admin_user_id: str | None = Query(None, max_length=200),
    from_ms: int | None = Query(None, ge=0),
    to_ms: int | None = Query(None, ge=0),
    sort_dir: str = Query("desc"),
):
    """Paginated audit log for the Admin Security page.

    Filters: ``search`` (action/target id/IP substring), exact ``action``,
    ``target_type``, ``admin_user_id`` and an optional ``from_ms``/``to_ms``
    window. Ordered newest-first by default (``sort_dir=asc`` for oldest).
    """
    if from_ms is not None and to_ms is not None and from_ms > to_ms:
        raise HTTPException(status_code=400, detail="'from' must not be after 'to'")
    if sort_dir not in ("asc", "desc"):
        raise HTTPException(status_code=400, detail="sort_dir must be 'asc' or 'desc'")

    conditions = []
    if search:
        term = f"%{search}%"
        conditions.append(
            or_(
                AuditLog.action.ilike(term),
                AuditLog.target_id.ilike(term),
                AuditLog.ip_address.ilike(term),
            )
        )
    if action is not None:
        conditions.append(AuditLog.action == action)
    if target_type is not None:
        conditions.append(AuditLog.target_type == target_type)
    if admin_user_id is not None:
        conditions.append(AuditLog.admin_user_id == admin_user_id)
    if from_ms is not None:
        conditions.append(AuditLog.created_at >= from_ms)
    if to_ms is not None:
        conditions.append(AuditLog.created_at <= to_ms)

    total = (
        db.scalar(select(func.count()).select_from(AuditLog).where(*conditions)) or 0
    )

    order = AuditLog.created_at.asc() if sort_dir == "asc" else AuditLog.created_at.desc()
    rows = db.execute(
        select(AuditLog, User.email, User.name)
        .outerjoin(User, User.id == AuditLog.admin_user_id)
        .where(*conditions)
        .order_by(order)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    items = [
        AuditLogOut(
            id=entry.id,
            admin_user_id=entry.admin_user_id,
            admin_email=email,
            admin_name=name,
            action=entry.action,
            target_type=entry.target_type,
            target_id=entry.target_id,
            details=_parse_details(entry.details),
            ip_address=entry.ip_address,
            created_at=entry.created_at,
        )
        for entry, email, name in rows
    ]

    pages = (total + page_size - 1) // page_size if total else 0
    return AuditLogList(
        items=items, total=total, page=page, page_size=page_size, pages=pages
    )