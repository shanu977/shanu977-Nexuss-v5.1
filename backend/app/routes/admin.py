from fastapi import APIRouter, Depends

from ..models import User
from ..models.models import utc_now_ms
from ..routes.deps import get_current_admin

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/health")
def admin_health(admin: User = Depends(get_current_admin)):
    """Admin authorization probe.

    Verifies that the full admin chain works end to end:
      401 -> unauthenticated (handled by ``get_current_user``)
      403 -> authenticated but ``role != "admin"``
      200 -> authorized admin

    The role is read from the server-side user record only. This endpoint
    exists purely to prove Admin authorization; it returns no business data.
    """
    return {
        "status": "ok",
        "admin": {"email": admin.email, "role": admin.role},
        "timestamp": utc_now_ms(),
    }
