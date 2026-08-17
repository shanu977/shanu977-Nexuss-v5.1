"""Admin Feedback API.

Lists user-submitted feedback and lets admins update the triage status.
Feedback is never created from the admin side.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Feedback, User
from ..routes.deps import get_current_admin
from ..schemas.admin import (
    AdminFeedbackList,
    AdminFeedbackOut,
    FeedbackStatusUpdate,
    FeedbackUser,
)
from ..services import audit_service

router = APIRouter(prefix="/admin/feedback", tags=["admin-feedback"])

SORTABLE_FIELDS = ("created_at", "rating")


@router.get("", response_model=AdminFeedbackList)
def list_feedback(
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: str | None = Query(None),
    rating: int | None = Query(None, ge=1, le=5),
    from_ms: int | None = Query(None, ge=0),
    to_ms: int | None = Query(None, ge=0),
    search: str | None = Query(None, max_length=200),
    sort_by: str = Query("created_at"),
    sort_dir: str = Query("desc"),
):
    """Paginated feedback list with filters (status, rating, date, message)."""
    if status is not None and status not in ("new", "reviewed", "closed"):
        raise HTTPException(
            status_code=400, detail="status must be 'new', 'reviewed' or 'closed'"
        )
    if from_ms is not None and to_ms is not None and from_ms > to_ms:
        raise HTTPException(status_code=400, detail="'from' must not be after 'to'")
    if sort_by not in SORTABLE_FIELDS:
        raise HTTPException(
            status_code=400,
            detail=f"sort_by must be one of {', '.join(SORTABLE_FIELDS)}",
        )
    if sort_dir not in ("asc", "desc"):
        raise HTTPException(status_code=400, detail="sort_dir must be 'asc' or 'desc'")

    conditions = []
    if status is not None:
        conditions.append(Feedback.status == status)
    if rating is not None:
        conditions.append(Feedback.rating == rating)
    if from_ms is not None:
        conditions.append(Feedback.created_at >= from_ms)
    if to_ms is not None:
        conditions.append(Feedback.created_at <= to_ms)
    if search:
        conditions.append(Feedback.message.ilike(f"%{search}%"))

    total = db.scalar(select(func.count()).select_from(Feedback).where(*conditions)) or 0

    order_col = getattr(Feedback, sort_by)
    order = order_col.asc() if sort_dir == "asc" else order_col.desc()
    rows = db.execute(
        select(Feedback, User.email, User.name)
        .join(User, User.id == Feedback.user_id)
        .where(*conditions)
        .order_by(order)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()

    items = [
        AdminFeedbackOut(
            id=fb.id,
            user=FeedbackUser(id=fb.user_id, email=email, name=name),
            rating=fb.rating,
            message=fb.message,
            status=fb.status,
            created_at=fb.created_at,
        )
        for fb, email, name in rows
    ]

    pages = (total + page_size - 1) // page_size if total else 0
    return AdminFeedbackList(
        items=items, total=total, page=page, page_size=page_size, pages=pages
    )


@router.patch("/{feedback_id}", response_model=AdminFeedbackOut)
def update_feedback_status(
    feedback_id: str,
    payload: FeedbackStatusUpdate,
    request: Request,
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Update a feedback item's triage status."""
    fb = db.scalar(select(Feedback).where(Feedback.id == feedback_id))
    if fb is None:
        raise HTTPException(status_code=404, detail="Feedback not found")

    old_status = fb.status
    fb.status = payload.status
    audit_service.add_admin_action(
        db,
        admin,
        "feedback.status.change",
        target_type="feedback",
        target_id=fb.id,
        details={"from": old_status, "to": payload.status},
        ip_address=audit_service.client_ip(request),
    )
    db.commit()
    db.refresh(fb)

    user = db.scalar(select(User).where(User.id == fb.user_id))
    email = user.email if user is not None else ""
    name = user.name if user is not None else ""
    return AdminFeedbackOut(
        id=fb.id,
        user=FeedbackUser(id=fb.user_id, email=email, name=name),
        rating=fb.rating,
        message=fb.message,
        status=fb.status,
        created_at=fb.created_at,
    )
