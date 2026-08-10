from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User, UserSettings
from ..routes.deps import get_current_user
from ..schemas.settings import (
    ALLOWED_MODELS,
    UserSettingsOut,
    UserSettingsUpdate,
)
from ..services import settings_service
from ..models.models import utc_now_ms

router = APIRouter(prefix="/settings", tags=["settings"])


def _out(s: UserSettings) -> UserSettingsOut:
    return UserSettingsOut(
        theme=s.theme,
        language=s.language,
        provider=s.provider,
        model=s.model,
        updatedAt=s.updated_at,
    )


@router.get("", response_model=UserSettingsOut)
def get_settings(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return _out(settings_service.get_or_create_settings(db, user))


@router.put("", response_model=UserSettingsOut)
def update_settings(
    payload: UserSettingsUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    settings = settings_service.get_or_create_settings(db, user)
    data = payload.model_dump(exclude_unset=True)
    # Skip explicit nulls: these columns are NOT NULL and setting them to None
    # would raise a 500 IntegrityError.
    data = {k: v for k, v in data.items() if v is not None}

    # Resolve the effective provider/model and reject mismatches so the model
    # indicator can never drift from a combination the backend can serve.
    provider = data.get("provider", settings.provider)
    if provider not in ALLOWED_MODELS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unsupported provider: {provider}",
        )
    if "provider" in data and "model" not in data:
        data["model"] = settings_service.DEFAULT_MODELS[provider]
    model = data.get("model", settings.model)
    if model not in ALLOWED_MODELS.get(provider, set()):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Model {model!r} is not supported by provider {provider!r}",
        )

    for field, value in data.items():
        setattr(settings, field, value)
    if data:
        settings.updated_at = utc_now_ms()
    db.commit()
    db.refresh(settings)
    return _out(settings)
