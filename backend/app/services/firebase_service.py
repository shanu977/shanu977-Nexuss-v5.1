import logging
import os
from urllib.parse import quote

from ..config import settings

logger = logging.getLogger("uvicorn.error")

_firebase_initialized = False


def _build_credential_from_components():
    """Build a service-account Certificate from the component env vars.

    Returns (cred, project_id), or (None, None) when any component is missing
    or the key cannot be parsed. The private key is stored as a single line in
    the environment (escaped `\\n` sequences), so they are converted to real
    newlines before being handed to the SDK.
    """
    if not (
        settings.firebase_project_id
        and settings.firebase_private_key
        and settings.firebase_client_email
    ):
        return None, None

    try:
        from firebase_admin import credentials

        private_key = settings.firebase_private_key.replace("\\n", "\n")
        # google-auth validates the service-account info dict as a whole and
        # rejects a minimal dict missing token_uri ("Service account info was
        # not in the expected format"). The missing fields are public, fixed
        # Google service-account endpoints, so supply the standard values.
        client_x509 = (
            "https://www.googleapis.com/robot/v1/metadata/x509/"
            + quote(settings.firebase_client_email, safe="")
        )
        cred = credentials.Certificate(
            {
                "type": "service_account",
                "project_id": settings.firebase_project_id,
                "private_key": private_key,
                "client_email": settings.firebase_client_email,
                "token_uri": "https://oauth2.googleapis.com/token",
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "auth_provider_x509_cert_url": (
                    "https://www.googleapis.com/oauth2/v1/certs"
                ),
                "client_x509_cert_url": client_x509,
            }
        )
        return cred, settings.firebase_project_id
    except Exception as e:
        logger.error(
            "Failed to build Firebase credential from FIREBASE_PROJECT_ID / "
            "FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY: %s",
            type(e).__name__,
        )
        return None, None


def _load_credentials():
    """Resolve Firebase Admin credentials and the project id to verify against.

    Priority:
      1. FIREBASE_CREDENTIALS_PATH — the key file must exist on disk.
      2. FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.

    Returns (cred, project_id). project_id is always set so the Admin SDK is
    pinned to one Firebase project (frontend and backend must match).
    Raises ValueError with a safe, actionable message when no usable
    credential could be built.
    """
    from firebase_admin import credentials

    # 1. Path-based credential file.
    if settings.firebase_credentials_path:
        path = settings.firebase_credentials_path
        if os.path.exists(path):
            cred = credentials.Certificate(path)
            project_id = (
                getattr(cred, "project_id", None)
                or settings.firebase_project_id
                or None
            )
            if not project_id:
                raise ValueError(
                    "Could not determine the Firebase project_id from the "
                    "service-account credential. Set FIREBASE_PROJECT_ID or "
                    "use a valid key file."
                )
            return cred, project_id

        # File configured but missing in the running environment. Try the
        # component env vars; otherwise fail loudly instead of silently
        # starting with a project that can never verify this app's tokens.
        logger.error(
            "FIREBASE_CREDENTIALS_PATH is configured but the file does not "
            "exist: %s",
            path,
        )
        cred, project_id = _build_credential_from_components()
        if cred:
            return cred, project_id
        raise ValueError(
            "FIREBASE_CREDENTIALS_PATH (%s) does not exist and the fallback "
            "FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY "
            "are not all set. Firebase token verification cannot work."
            % path
        )

    # 2. Component env vars.
    return _build_credential_from_components()


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

        if firebase_admin._apps:
            _firebase_initialized = True
            return

        cred, project_id = _load_credentials()

        if cred is None:
            if settings.environment == "production":
                raise RuntimeError(
                    "Firebase Admin SDK has no service-account credential in "
                    "production. Set FIREBASE_CREDENTIALS_PATH (deployed key "
                    "file) or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + "
                    "FIREBASE_PRIVATE_KEY. Without them every authenticated "
                    "request will 401."
                )
            # Development/other: never initialize a default app, otherwise it
            # would verify tokens against an unrelated/no project and silently
            # 401 every request. Warn loudly and keep retrying-friendly state.
            logger.warning(
                "Firebase Admin SDK is NOT initialized: no service-account "
                "credential is configured. Authenticated API requests will "
                "fail until FIREBASE_CREDENTIALS_PATH (or the project/email/"
                "private-key vars) is set."
            )
            _firebase_initialized = False
            return

        # Pin the Admin SDK to the exact Firebase project so ID-token
        # verification matches the frontend's Firebase config.
        firebase_admin.initialize_app(cred, options={"projectId": project_id})
        logger.info(
            "Firebase Admin SDK initialized successfully for project=%s",
            project_id,
        )
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
        logger.warning(
            f"Firebase Admin SDK initialization warning: {type(e).__name__}: {e}"
        )


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
