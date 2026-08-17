import logging
import os
import uuid
from fastapi import Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import User, UserSettings
from ..models.models import utc_now_ms
from ..services import firebase_service

logger = logging.getLogger("uvicorn.error")

LOCAL_USER_ID = "test-uid-1"

BLOCKED_MESSAGE = "This account has been blocked. Contact support for help."


def _ensure_not_blocked(user: User) -> User:
    """Server-side block enforcement for ``users.status == "blocked"``.

    Runs for every authenticated request via ``get_current_user`` so a blocked
    user cannot use the application. Administrators are exempt so a blocked
    status can never lock out the admin team (the block API itself refuses to
    block admins, and the exemption is a safety net).
    """
    if user.status == "blocked" and user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=BLOCKED_MESSAGE,
        )
    return user


def get_current_user(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> User:
    """Centralized authentication dependency.

    1. Reads Authorization header (`Bearer <Firebase ID Token>`).
    2. Verifies token with Firebase Admin SDK.
    3. Extracts verified Firebase UID, email, and name.
    4. Looks up application user by firebase_uid (or email fallback).
    5. Syncs/provisions user and default UserSettings if new.
    6. Returns verified User instance.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization header. Expected Bearer token.",
        )

    token = authorization.split("Bearer ", 1)[1].strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Empty Authorization token.",
        )

    # Handle test environment / mock tokens during unit test execution ONLY.
    # Guarded by PYTEST_CURRENT_TEST so mock tokens can never authenticate in
    # development or production (they bypass Firebase token verification).
    if os.environ.get("PYTEST_CURRENT_TEST") and token.startswith("test-mock-token"):
        # Allow test tokens such as "test-mock-token" or "test-mock-token-user2"
        mock_uid = "test-uid-1" if token == "test-mock-token" else f"test-uid-{token}"
        mock_email = "test@example.com" if token == "test-mock-token" else f"{token}@example.com"
        decoded = {
            "uid": mock_uid,
            "email": mock_email,
            "name": "Test User",
            "picture": None,
        }
    else:
        try:
            decoded = firebase_service.verify_id_token(token)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail=str(exc),
            )

    uid = decoded.get("uid")
    if not uid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token payload missing uid",
        )

    email = decoded.get("email") or f"{uid}@firebase.user"
    name = decoded.get("name") or email.split("@")[0]
    photo_url = decoded.get("picture")

    # 1. Search user by firebase_uid
    user = db.scalar(select(User).where(User.firebase_uid == uid))
    if user is not None:
        return _ensure_not_blocked(user)

    # 2. Search user by email as fallback
    user = db.scalar(select(User).where(User.email == email))
    if user is not None:
        user.firebase_uid = uid
        if photo_url:
            user.photo_url = photo_url
        user.updated_at = utc_now_ms()
        db.commit()
        db.refresh(user)
        return _ensure_not_blocked(user)

    # 3. Create new application user
    new_id = uid
    user = User(
        id=new_id,
        firebase_uid=uid,
        email=email,
        name=name,
        photo_url=photo_url,
        provider="firebase",
        created_at=utc_now_ms(),
        updated_at=utc_now_ms(),
    )
    db.add(user)
    try:
        db.flush()
        settings = UserSettings(
            id=str(uuid.uuid4()),
            user_id=user.id,
            theme="light",
            language="en",
            provider="groq",
            model="llama-3.3-70b-versatile",
            updated_at=utc_now_ms(),
        )
        db.add(settings)
        db.commit()
        db.refresh(user)
    except IntegrityError:
        db.rollback()
        user = db.scalar(select(User).where(User.firebase_uid == uid))
        if user is None:
            user = db.scalar(select(User).where(User.email == email))
        if user is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="User provisioning race condition failed.",
            )
    return _ensure_not_blocked(user)


def get_current_admin(user: User = Depends(get_current_user)) -> User:
    """Require an authenticated user with the server-side 'admin' role.

    Reuses ``get_current_user`` for Firebase token verification and user
    resolution. The role is always read from the application's user record in
    the database — never from client-provided state, localStorage, or any
    frontend flag.

    Additionally enforces the following identity checks (all five must pass):

    1. Firebase authenticated         — already verified by ``get_current_user``
    2. Firebase email == admin_email  — compared against the configured
                                       admin email (may be overridden via
                                       ``ADMIN_EMAIL`` env var)
    3. server-side User name == admin_name — compared against the configured
                                       admin name (may be overridden via
                                       ``ADMIN_NAME`` env var)
    4. User role == "admin"
    5. User status == "active"

    Returns:
        The verified admin User.

    Raises:
        401: unauthenticated (from ``get_current_user``).
        403: authenticated, but any of the five identity checks failed.
    """
    # 1. Role check
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required.",
        )

    # 2. Email check — use the configured admin email from settings
    if user.email != settings.admin_email:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin email verification failed.",
        )

    # 3. Name check — use the configured admin name from settings
    if user.name != settings.admin_name:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin name verification failed.",
        )

    # 4. Status check — admins must have active status
    if user.status != "active":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin account is not active.",
        )

    return user
