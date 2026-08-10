"""Encryption at rest for user API keys (Fernet).

Keys are stored encrypted in Supabase and decrypted only in memory, for the
duration of a single provider request. The decrypted value is never returned
to the frontend and never logged.
"""

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from ..config import settings

# Development-only fallback so local SQLite installs work without extra env.
# Production is blocked from starting without API_KEY_ENCRYPTION_KEY (config).
_DEV_KEY = "dev-only-fallback-key-never-use-in-production"


def _fernet() -> Fernet:
    secret = settings.api_key_encryption_key.strip() or _DEV_KEY
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
    return Fernet(key)


def encrypt_api_key(plaintext: str) -> str:
    """Encrypt a raw API key for storage. Returns the ciphertext string."""
    if not plaintext:
        raise ValueError("Cannot encrypt an empty API key")
    return _fernet().encrypt(plaintext.encode()).decode()


def decrypt_api_key(token: str) -> str:
    """Decrypt a stored ciphertext back to the raw key.

    Raises ValueError if the ciphertext cannot be decrypted (e.g. the
    encryption key was rotated).
    """
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken as exc:
        raise ValueError("Stored API key could not be decrypted") from exc
