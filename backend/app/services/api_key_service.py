from typing import Dict, List

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import User, UserApiKey
from ..models.models import utc_now_ms
from .key_crypto import decrypt_api_key, encrypt_api_key

# All providers a user can save a key for.
ALL_PROVIDERS = ("groq", "gemini", "openrouter")

# Provider endpoints for key validation (lightweight model list requests).
_VALIDATION_ENDPOINTS = {
    "groq": "https://api.groq.com/openai/v1/models",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/models",
    "openrouter": "https://openrouter.ai/api/v1/models",
}


def upsert_key(db: Session, user: User, provider: str, api_key: str) -> UserApiKey:
    """Create or update a user's API key for a provider. Always encrypted."""
    raw = api_key.strip()
    now = utc_now_ms()
    row = db.scalar(
        select(UserApiKey).where(
            UserApiKey.firebase_uid == user.id, UserApiKey.provider == provider
        )
    )
    if row is None:
        row = UserApiKey(
            firebase_uid=user.id,
            provider=provider,
            encrypted_api_key=encrypt_api_key(raw),
            created_at=now,
            updated_at=now,
        )
        db.add(row)
    else:
        row.encrypted_api_key = encrypt_api_key(raw)
        row.updated_at = now
    db.commit()
    db.refresh(row)
    return row


def get_decrypted_key(db: Session, user: User, provider: str) -> str | None:
    """Return the user's raw key for a provider, decrypted in memory.

    Returns None if the user has no key saved. Raises ValueError if a stored
    ciphertext cannot be decrypted (encryption key was rotated).
    """
    row = db.scalar(
        select(UserApiKey).where(
            UserApiKey.firebase_uid == user.id, UserApiKey.provider == provider
        )
    )
    if row is None:
        return None
    return decrypt_api_key(row.encrypted_api_key)


def list_keys(db: Session, user: User) -> List[UserApiKey]:
    """Return all of a user's stored (encrypted) key rows."""
    return db.scalars(
        select(UserApiKey).where(UserApiKey.firebase_uid == user.id)
    ).all()


def list_key_status(db: Session, user: User) -> List[Dict]:
    """Return per-provider presence/metadata. Never includes the raw key."""
    rows = list_keys(db, user)
    by_provider = {r.provider: r.updated_at for r in rows}
    return [
        {
            "provider": p,
            "has_key": p in by_provider,
            "updatedAt": by_provider.get(p, 0),
        }
        for p in ALL_PROVIDERS
    ]


def delete_key(db: Session, user: User, provider: str) -> bool:
    """Delete a user's key for a provider. Returns False if none existed."""
    row = db.scalar(
        select(UserApiKey).where(
            UserApiKey.firebase_uid == user.id, UserApiKey.provider == provider
        )
    )
    if row is None:
        return False
    db.delete(row)
    db.commit()
    return True


def test_key(provider: str, api_key: str) -> Dict[str, object]:
    """Validate an API key by making a lightweight request to the provider.

    Returns {"valid": True, "message": "..."} on success or
    {"valid": False, "message": "..."} on failure. Never logs the key.
    """
    if provider not in _VALIDATION_ENDPOINTS:
        return {"valid": False, "message": f"Unsupported provider: {provider}"}

    url = _VALIDATION_ENDPOINTS[provider]
    # Gemini's classic REST API authenticates via X-Goog-Api-Key, not a Bearer
    # token (Bearer is only accepted by its OpenAI-compatible endpoints). Sending
    # the key as Bearer would make a valid Gemini key always appear invalid.
    if provider == "gemini":
        headers = {
            "X-Goog-Api-Key": api_key,
            "Content-Type": "application/json",
        }
    else:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    try:
        resp = httpx.get(url, headers=headers, timeout=15.0)
    except httpx.TimeoutException:
        return {"valid": False, "message": "Provider timed out. Please try again."}
    except httpx.HTTPError:
        return {"valid": False, "message": "Network error. Check your connection."}

    if resp.status_code == 200:
        return {"valid": True, "message": f"{provider.capitalize()} API key is valid."}

    if resp.status_code in (401, 403):
        return {
            "valid": False,
            "message": "Invalid API key. Please check your key and try again.",
        }

    if resp.status_code == 429:
        return {
            "valid": False,
            "message": "Rate limited by provider. Please try again later.",
        }

    return {
        "valid": False,
        "message": f"Provider returned status {resp.status_code}. Please check your key.",
    }