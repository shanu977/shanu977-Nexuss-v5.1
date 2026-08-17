"""Admin global settings API (app_settings).

Distinct from the per-user ``/settings`` endpoint: ``/admin/settings`` manages
global application settings and feature flags. Admin-only, validated via
Pydantic, and never stores secrets or API keys.
"""

import uuid

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AppSetting, User
from ..models.models import utc_now_ms
from ..routes.deps import get_current_admin
from ..schemas.admin import (
    AdminSettingOut,
    AdminSettingsResponse,
    AdminSettingUpsert,
)
from ..services import audit_service

router = APIRouter(prefix="/admin/settings", tags=["admin-settings"])


def _to_out(db: Session, setting: AppSetting) -> AdminSettingOut:
    updated_by_email = None
    if setting.updated_by is not None:
        updated_by_email = db.scalar(
            select(User.email).where(User.id == setting.updated_by)
        )
    return AdminSettingOut(
        id=setting.id,
        key=setting.key,
        value=setting.value,
        value_type=setting.value_type,
        description=setting.description,
        updated_by_email=updated_by_email,
        created_at=setting.created_at,
        updated_at=setting.updated_at,
    )


@router.get("", response_model=AdminSettingsResponse)
def get_settings(
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """List all global application settings."""
    settings = db.scalars(select(AppSetting).order_by(AppSetting.key)).all()
    return AdminSettingsResponse(items=[_to_out(db, s) for s in settings])


@router.put("", response_model=AdminSettingsResponse)
def put_settings(
    payload: list[AdminSettingUpsert],
    request: Request,
    admin: User = Depends(get_current_admin),
    db: Session = Depends(get_db),
):
    """Upsert global settings by key (validated by AdminSettingUpsert).

    Keys not present in the payload are left unchanged (no destructive
    deletion). Each changed/created setting is audited.
    """
    now = utc_now_ms()
    for item in payload:
        setting = db.scalar(select(AppSetting).where(AppSetting.key == item.key))
        old_value = None
        if setting is None:
            setting = AppSetting(
                id=str(uuid.uuid4()), key=item.key, created_at=now, updated_at=now
            )
            db.add(setting)
        else:
            old_value = setting.value

        setting.value = item.value
        setting.value_type = item.value_type
        setting.description = item.description
        setting.updated_by = admin.id
        setting.updated_at = now

        audit_service.add_admin_action(
            db,
            admin,
            "settings.update",
            target_type="app_settings",
            target_id=item.key,
            details={"key": item.key, "from": old_value, "to": item.value},
            ip_address=audit_service.client_ip(request),
        )

    db.commit()
    all_settings = db.scalars(select(AppSetting).order_by(AppSetting.key)).all()
    return AdminSettingsResponse(items=[_to_out(db, s) for s in all_settings])
