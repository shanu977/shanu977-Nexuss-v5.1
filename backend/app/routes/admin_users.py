"""Admin Users API.

All endpoints require ``get_current_admin`` (server-side role check only).
Role/status changes are audited via ``audit_service``.

Security rules implemented here:

* role changes are limited to ``user``/``admin`` (Pydantic Literal).
* the last remaining admin can never be demoted.
* administrators can never be blocked or deleted (demote first).
* blocking/unblocking only toggles ``users.status``; enforcement lives in
  ``get_current_user`` so a blocked user cannot use the application.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User
from ..models.models import utc_now_ms
from ..routes.deps import get_current_admin
from ..schemas.admin import AdminUserList, AdminUserOut, DeleteResult, RoleUpdate
from ..services import audit_service

router = APIRouter(prefix="/admin/users", tags=["admin-users"])

SORTABLE_FIELDS = ("created_at", "email", "name", "role", "status")


def _get_user_or_404(db: Session, user_id: str) -> User:
    user = db.scalar(select(User).where(User.id == user_id))
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.get("", response_model=AdminUserList)
def list_users(
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str | None = Query(None, max_length=200),
    role: str | None = Query(None),
    status: str | None = Query(None),
    sort_by: str = Query("created_at"),
    sort_dir: str = Query("desc"),
):
    """Paginated, searchable user list for the Admin Users page.

    Response shape: ``{items, total, page, page_size, pages}`` where each item
    is an ``AdminUserOut``. Search matches email/name (case-insensitive).
    Never exposes tokens, API keys, or encrypted key values.
    """
    if role is not None and role not in ("user", "admin"):
        raise HTTPException(status_code=400, detail="role must be 'user' or 'admin'")
    if status is not None and status not in ("active", "blocked"):
        raise HTTPException(
            status_code=400, detail="status must be 'active' or 'blocked'"
        )
    if sort_by not in SORTABLE_FIELDS:
        raise HTTPException(
            status_code=400,
            detail=f"sort_by must be one of {', '.join(SORTABLE_FIELDS)}",
        )
    if sort_dir not in ("asc", "desc"):
        raise HTTPException(status_code=400, detail="sort_dir must be 'asc' or 'desc'")

    conditions = []
    if search:
        term = f"%{search}%"
        conditions.append(or_(User.email.ilike(term), User.name.ilike(term)))
    if role is not None:
        conditions.append(User.role == role)
    if status is not None:
        conditions.append(User.status == status)

    total = db.scalar(select(func.count()).select_from(User).where(*conditions)) or 0

    order_col = getattr(User, sort_by)
    order = order_col.asc() if sort_dir == "asc" else order_col.desc()
    users = db.scalars(
        select(User)
        .where(*conditions)
        .order_by(order)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    pages = (total + page_size - 1) // page_size if total else 0
    return AdminUserList(
        items=[AdminUserOut.model_validate(u) for u in users],
        total=total,
        page=page,
        page_size=page_size,
        pages=pages,
    )


@router.patch("/{user_id}/role", response_model=AdminUserOut)
def update_role(
    user_id: str,
    payload: RoleUpdate,
    request: Request,
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Promote/demote a user's role. The last remaining admin cannot be demoted."""
    user = _get_user_or_404(db, user_id)
    old_role = user.role

    if user.role == "admin" and payload.role != "admin":
        admin_count = (
            db.scalar(select(func.count()).select_from(User).where(User.role == "admin"))
            or 0
        )
        if admin_count <= 1:
            raise HTTPException(
                status_code=400,
                detail="Cannot demote the only remaining admin.",
            )

    user.role = payload.role
    user.updated_at = utc_now_ms()
    audit_service.add_admin_action(
        db,
        admin,
        "user.role.change",
        target_type="user",
        target_id=user.id,
        details={"from": old_role, "to": payload.role},
        ip_address=audit_service.client_ip(request),
    )
    db.commit()
    db.refresh(user)
    return user


@router.post("/{user_id}/block", response_model=AdminUserOut)
def block_user(
    user_id: str,
    request: Request,
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Block a user (``users.status = "blocked"``). Administrators cannot be
    blocked, so the admin team can never lock itself out."""
    user = _get_user_or_404(db, user_id)
    if user.role == "admin":
        raise HTTPException(
            status_code=400, detail="Cannot block an administrator."
        )
    if user.id == admin.id:
        raise HTTPException(
            status_code=400, detail="Cannot block your own account."
        )

    if user.status != "blocked":
        user.status = "blocked"
        user.updated_at = utc_now_ms()
        audit_service.add_admin_action(
            db,
            admin,
            "user.block",
            target_type="user",
            target_id=user.id,
            details={"email": user.email},
            ip_address=audit_service.client_ip(request),
        )
        db.commit()
        db.refresh(user)
    return user


@router.post("/{user_id}/unblock", response_model=AdminUserOut)
def unblock_user(
    user_id: str,
    request: Request,
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Unblock a user (``users.status = "active"``). Idempotent."""
    user = _get_user_or_404(db, user_id)

    if user.status != "active":
        user.status = "active"
        user.updated_at = utc_now_ms()
        audit_service.add_admin_action(
            db,
            admin,
            "user.unblock",
            target_type="user",
            target_id=user.id,
            details={"email": user.email},
            ip_address=audit_service.client_ip(request),
        )
        db.commit()
        db.refresh(user)
    return user


@router.delete("/{user_id}", response_model=DeleteResult)
def delete_user(
    user_id: str,
    request: Request,
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Delete a user's account and all CASCADEd user-owned data.

    Safe in this schema: conversations/messages/user_settings/user_api_keys/
    usage_records/feedback CASCADE on user delete; audit_log and app_settings
    keep their rows via SET NULL. Note: because the application user id equals
    the Firebase uid, a deleted user is silently re-provisioned as a fresh
    account on their next login — so this is effectively a "reset user data"
    operation. Administrators must be demoted to 'user' before deletion.
    """
    user = _get_user_or_404(db, user_id)
    if user.id == admin.id:
        raise HTTPException(
            status_code=400, detail="You cannot delete your own account."
        )
    if user.role == "admin":
        raise HTTPException(
            status_code=400,
            detail="Cannot delete an administrator. Demote the user to 'user' first.",
        )

    audit_service.add_admin_action(
        db,
        admin,
        "user.delete",
        target_type="user",
        target_id=user.id,
        details={"email": user.email},
        ip_address=audit_service.client_ip(request),
    )
    db.delete(user)
    db.commit()
    return DeleteResult(status="deleted", id=user_id)
