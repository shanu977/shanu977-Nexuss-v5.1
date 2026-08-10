from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User
from ..routes.deps import get_current_user
from ..schemas.sync import (
    SyncPullResponse,
    SyncPushRequest,
    SyncPushResponse,
)
from ..services.sync import apply_push, pull
from ..models.models import utc_now_ms

router = APIRouter(prefix="/sync", tags=["sync"])


@router.post("/push", response_model=SyncPushResponse)
def push(
    payload: SyncPushRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    apply_push(db, user.id, payload)
    return SyncPushResponse(accepted=True, serverTime=utc_now_ms())


@router.get("/pull", response_model=SyncPullResponse)
def pull_endpoint(
    since: int = Query(0, ge=0),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return pull(db, user.id, since)
