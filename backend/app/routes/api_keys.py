from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User
from ..routes.deps import get_current_user
from ..schemas.api_keys import ApiKeyOut, ApiKeyTest, ApiKeyTestResponse, ApiKeyUpsert
from ..services import api_key_service
from ..services.api_key_service import ALL_PROVIDERS

router = APIRouter(prefix="/api-keys", tags=["api-keys"])


@router.get("", response_model=List[ApiKeyOut])
def list_api_keys(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Per-provider key status. Never contains the raw key."""
    return api_key_service.list_key_status(db, user)


@router.post("/test", response_model=ApiKeyTestResponse)
def test_api_key(
    payload: ApiKeyTest,
    user: User = Depends(get_current_user),
):
    """Validate an API key against the provider without saving it."""
    result = api_key_service.test_key(payload.provider, payload.api_key)
    return ApiKeyTestResponse(**result)


@router.put("", response_model=ApiKeyOut)
def save_api_key(
    payload: ApiKeyUpsert,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Save (or replace) a user's API key for a provider. Validated first, then stored encrypted."""
    result = api_key_service.test_key(payload.provider, payload.api_key)
    if not result["valid"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=result["message"],
        )
    row = api_key_service.upsert_key(db, user, payload.provider, payload.api_key)
    return ApiKeyOut(provider=row.provider, has_key=True, updatedAt=row.updated_at)


@router.delete("/{provider}", status_code=status.HTTP_204_NO_CONTENT)
def delete_api_key(
    provider: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if provider not in ALL_PROVIDERS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unsupported provider: {provider}",
        )
    if not api_key_service.delete_key(db, user, provider):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No API key saved for this provider",
        )
    return None
