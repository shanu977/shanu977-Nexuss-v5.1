import logging
import os

from ..config import settings

logger = logging.getLogger("uvicorn.error")

_firebase_initialized = False


def initialize_firebase():
    global _firebase_initialized
    if _firebase_initialized:
        return

    # Skip live initialization in test environment
    if "PYTEST_CURRENT_TEST" in os.environ:
        _firebase_initialized = True
        return

    try:
        import firebase_admin
        from firebase_admin import credentials

        if firebase_admin._apps:
            _firebase_initialized = True
            return

        cred = None
        if settings.firebase_credentials_path and os.path.exists(settings.firebase_credentials_path):
            cred = credentials.Certificate(settings.firebase_credentials_path)
        elif settings.firebase_project_id and settings.firebase_private_key and settings.firebase_client_email:
            private_key = settings.firebase_private_key.replace("\\n", "\n")
            cred_dict = {
                "type": "service_account",
                "project_id": settings.firebase_project_id,
                "private_key": private_key,
                "client_email": settings.firebase_client_email,
            }
            cred = credentials.Certificate(cred_dict)

        if cred:
            firebase_admin.initialize_app(cred)
            logger.info("Firebase Admin SDK initialized successfully")
        else:
            firebase_admin.initialize_app()
            logger.warning("Firebase Admin SDK initialized with default credentials")
        _firebase_initialized = True
    except Exception as e:
        # Do NOT mark initialized on failure: allow a later retry if the
        # environment is fixed. In production this must be fatal so a broken
        # auth setup can never silently 401 every request.
        _firebase_initialized = False
        if settings.environment == "production":
            raise RuntimeError(
                "Firebase Admin SDK failed to initialize in production. "
                "Check FIREBASE_CREDENTIALS_PATH or FIREBASE_PROJECT_ID / "
                "FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY."
            ) from e
        logger.warning(f"Firebase Admin SDK initialization warning: {e}")


def verify_id_token(token: str) -> dict:
    """Verify a Firebase ID Token using Firebase Admin SDK.

    Returns decoded token dictionary containing `uid`, `email`, etc.
    Raises ValueError on invalid token.
    """
    initialize_firebase()
    if not token or not token.strip():
        raise ValueError("Token is required")

    try:
        from firebase_admin import auth
        decoded = auth.verify_id_token(token)
        return decoded
    except Exception as e:
        logger.error(f"Firebase token verification failed: {e}")
        raise ValueError("Invalid authentication token.")


def get_user_by_email(email: str) -> dict | None:
    """Fetch Firebase user by email address."""
    initialize_firebase()
    try:
        from firebase_admin import auth
        user = auth.get_user_by_email(email)
        provider_ids = [p.provider_id for p in user.provider_data]
        return {
            "uid": user.uid,
            "email": user.email,
            "display_name": user.display_name,
            "provider_ids": provider_ids,
        }
    except Exception as e:
        logger.debug(f"Firebase user lookup by email {email} failed: {e}")
        return None


def update_user_password(uid: str, password: str) -> bool:
    """Attach/update password credential for existing Firebase user."""
    initialize_firebase()
    try:
        from firebase_admin import auth
        auth.update_user(uid, password=password)
        return True
    except Exception as e:
        logger.error(f"Failed to update Firebase password for UID {uid}: {e}")
        raise ValueError(f"Failed to update password: {str(e)}")
