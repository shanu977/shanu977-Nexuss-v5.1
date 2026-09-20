import hashlib
import logging
import re
import secrets
import time
import uuid
from typing import List, Literal

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import EmailOTP
from ..models.models import utc_now_ms
from ..services import email_service, firebase_service

logger = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/auth", tags=["auth"])


# Schemas
class UserStatusRequest(BaseModel):
    email: EmailStr


class UserStatusResponse(BaseModel):
    exists: bool
    providers: List[str]
    has_password: bool


class SendOtpRequest(BaseModel):
    email: EmailStr
    purpose: Literal["link_password", "reset_password"] = "link_password"


class SendOtpResponse(BaseModel):
    message: str
    cooldown_seconds: int


class VerifyOtpRequest(BaseModel):
    email: EmailStr
    otp: str = Field(..., min_length=6, max_length=6)


class VerifyOtpResponse(BaseModel):
    verified: bool
    verification_token: str


class SetPasswordRequest(BaseModel):
    email: EmailStr
    verification_token: str
    password: str = Field(..., min_length=6)


def _compute_otp_hash(otp: str, email: str) -> str:
    salt = settings.otp_secret_key
    raw = f"{otp}:{salt}:{email.lower().strip()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@router.post("/user-status", response_model=UserStatusResponse)
def get_user_status(payload: UserStatusRequest):
    """Check provider status for an email address in Firebase Auth."""
    email = payload.email.lower().strip()
    fb_user = firebase_service.get_user_by_email(email)
    if not fb_user:
        return UserStatusResponse(exists=False, providers=[], has_password=False)

    providers = fb_user.get("provider_ids", [])
    has_password = "password" in providers
    return UserStatusResponse(
        exists=True,
        providers=providers,
        has_password=has_password,
    )


@router.post("/otp/send", response_model=SendOtpResponse)
def send_otp(
    payload: SendOtpRequest,
    db: Session = Depends(get_db),
):
    """Generate and send a single-use 6-digit OTP for email verification."""
    email = payload.email.lower().strip()
    now_ms = utc_now_ms()

    # The Forgot Password flow must never mail an OTP for an address that has
    # no account (or an account with no password to reset). The account is
    # resolved securely on the server from the email address - a client-supplied
    # identity is never trusted. Google-only accounts are handled by the Set
    # Password flow instead; unknown addresses get a clear error and no email.
    if payload.purpose == "reset_password":
        fb_user = firebase_service.get_user_by_email(email)
        if not fb_user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No account found with this email address.",
            )
        if "password" not in fb_user.get("provider_ids", []):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This account has no password to reset. Please sign in with Google instead.",
            )

    # Check for active cooldown on recent unexpired OTP
    recent_otp = db.scalar(
        select(EmailOTP)
        .where(
            EmailOTP.email == email,
            EmailOTP.purpose == "link_password",
            EmailOTP.used == False,
        )
        .order_by(EmailOTP.created_at.desc())
    )

    if recent_otp and recent_otp.resend_available_at > now_ms:
        remaining_sec = int((recent_otp.resend_available_at - now_ms) / 1000)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Please wait {max(1, remaining_sec)} seconds before requesting another code.",
        )

    # Invalidate previous unused OTPs for this email
    db.execute(
        update(EmailOTP)
        .where(EmailOTP.email == email, EmailOTP.used == False)
        .values(used=True)
    )

    # Generate secure 6-digit random OTP
    otp_code = "".join(secrets.choice("0123456789") for _ in range(6))
    otp_hash = _compute_otp_hash(otp_code, email)

    expires_at = now_ms + (10 * 60 * 1000)  # 10 minutes
    resend_available_at = now_ms + (60 * 1000)  # 60 seconds cooldown

    new_otp = EmailOTP(
        id=str(uuid.uuid4()),
        email=email,
        otp_hash=otp_hash,
        purpose="link_password",
        expires_at=expires_at,
        attempts=0,
        max_attempts=3,
        resend_available_at=resend_available_at,
        used=False,
        created_at=now_ms,
    )
    db.add(new_otp)

    # Deliver the code by email. The plaintext OTP exists only transiently in
    # the outbound message: it is never logged, returned by the API, or stored
    # (only a salted hash is persisted). If delivery fails, the whole
    # transaction is rolled back so no valid-but-undeliverable OTP is left
    # behind, and the caller receives a safe error that exposes no SMTP
    # credentials or internal details.
    try:
        email_service.send_otp_email(email, otp_code)
    except Exception as exc:
        logger.warning(
            "Verification email could not be delivered (%s). No OTP was issued.",
            type(exc).__name__,
        )
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="We couldn't send the verification email. Please try again.",
        ) from exc

    db.commit()

    return SendOtpResponse(
        message="Verification code sent to email.",
        cooldown_seconds=60,
    )


@router.post("/otp/verify", response_model=VerifyOtpResponse)
def verify_otp(
    payload: VerifyOtpRequest,
    db: Session = Depends(get_db),
):
    """Verify single-use OTP and return a signed verification token."""
    email = payload.email.lower().strip()
    otp_input = payload.otp.strip()
    now_ms = utc_now_ms()

    record = db.scalar(
        select(EmailOTP)
        .where(
            EmailOTP.email == email,
            EmailOTP.purpose == "link_password",
            EmailOTP.used == False,
        )
        .order_by(EmailOTP.created_at.desc())
    )

    if not record or record.expires_at < now_ms:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired verification code.",
        )

    if record.attempts >= record.max_attempts:
        record.used = True
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Too many failed attempts. Please request a new verification code.",
        )

    expected_hash = _compute_otp_hash(otp_input, email)
    if not secrets.compare_digest(record.otp_hash, expected_hash):
        record.attempts += 1
        remaining_attempts = record.max_attempts - record.attempts
        if record.attempts >= record.max_attempts:
            record.used = True
        db.commit()
        if remaining_attempts <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Too many failed attempts. Please request a new verification code.",
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid verification code. {remaining_attempts} attempt(s) remaining.",
        )

    # Successfully verified OTP
    record.used = True
    db.commit()

    # Generate signed verification ticket valid for 15 minutes
    exp_timestamp = int(time.time()) + (15 * 60)
    token_payload = {
        "email": email,
        "purpose": "password_linking",
        "jti": record.id,
        "exp": exp_timestamp,
    }
    verification_token = jwt.encode(
        token_payload, settings.otp_secret_key, algorithm="HS256"
    )

    return VerifyOtpResponse(
        verified=True,
        verification_token=verification_token,
    )


def _verify_verification_token(email: str, token: str, db: Session):
    try:
        decoded = jwt.decode(
            token, settings.otp_secret_key, algorithms=["HS256"]
        )

        if (
            decoded.get("email") != email
            or decoded.get("purpose") != "password_linking"
        ):
            raise ValueError("Token verification failed")

        ticket_id = decoded.get("jti")
        if not ticket_id:
            raise ValueError("Missing verification ticket")

        record = db.query(EmailOTP).filter(EmailOTP.id == ticket_id).first()

        if not record:
            raise ValueError("Verification ticket not found")

        if record.email != email:
            raise ValueError("Verification ticket email mismatch")

        if record.verification_ticket_used:
            raise ValueError("Verification ticket already used")

        return record

    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired verification session. Please verify your email again.",
        )


@router.post("/set-password")
def set_password(
    payload: SetPasswordRequest,
    db: Session = Depends(get_db),
):
    """Set password for an existing account after OTP email verification.

    Links the password provider to the existing Firebase account (same Firebase UID).
    """
    email = payload.email.lower().strip()
    password = payload.password

    if len(password) < 6:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password must be at least 6 characters long.",
        )

    record=_verify_verification_token(email, payload.verification_token,db)

    # Fetch user from Firebase to find existing UID
    fb_user = firebase_service.get_user_by_email(email)
    if fb_user:
        uid = fb_user["uid"]
        firebase_service.update_user_password(uid, password)
        record.verification_ticket_used = True
        db.commit()
        return {
            "success": True,
            "message": "Password successfully created and linked to your account.",
        }
    else:
        # Create user in Firebase if not existing
        try:
            from firebase_admin import auth
            auth.create_user(email=email, password=password)
            record.verification_ticket_used = True
            db.commit()  
            return {
                "success": True,
                "message": "Account created successfully with email and password.",
            }
        except Exception:
            logger.exception("Failed to create Firebase user in set-password")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Failed to set password. Please try again.",
            )


@router.post("/reset-password")
def reset_password(
    payload: SetPasswordRequest,
     db: Session = Depends(get_db),
):
    """Reset the password of an EXISTING account after OTP email verification.

    The account is resolved securely on the backend by email (a client-supplied
    UID is never trusted), and the password is updated on the EXISTING Firebase
    UID so the UID and every existing provider (e.g. google.com) are preserved.
    A new Firebase account is NEVER created. If no account exists for the email,
    a generic error is returned that does not reveal whether the address is
    registered.
    """
    email = payload.email.lower().strip()
    password = payload.password

    if len(password) < 6:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password must be at least 6 characters long.",
        )

    record=_verify_verification_token(email, payload.verification_token,db)

    # Resolve the account server-side. Never trust a UID from the client.
    fb_user = firebase_service.get_user_by_email(email)
    if not fb_user:
        # Never call account creation. Keep the message generic.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password reset failed. Please try again.",
        )

    uid = fb_user["uid"]
    firebase_service.update_user_password(uid, password)
    record.verification_ticket_used = True
    db.commit()
    return {
        "success": True,
        "message": "Password reset successfully.",
    }
