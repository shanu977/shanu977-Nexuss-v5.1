from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import User, UserSettings
from ..models.models import utc_now_ms
from ..schemas.settings import DEPRECATED_MODEL_REPLACEMENTS

DEFAULT_MODELS = {
    "groq": "openai/gpt-oss-120b",
    "gemini": "gemini-3.6-flash",
    "openrouter": "openai/gpt-oss-120b:free",
}


def _upgrade_deprecated_model(settings: UserSettings) -> bool:
    """Replace a retired Groq model id stored in a user's settings with the
    supported replacement. Returns True when the row was upgraded."""
    replacement = DEPRECATED_MODEL_REPLACEMENTS.get(settings.model)
    if replacement is None:
        return False
    settings.model = replacement
    settings.updated_at = utc_now_ms()
    return True


def get_or_create_settings(db: Session, user: User) -> UserSettings:
    """Return the user's settings row, creating it with safe defaults on first use."""
    settings = db.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
    if settings is None:
        settings = UserSettings(
            user_id=user.id,
            theme="light",
            language="en",
            provider="groq",
            model=DEFAULT_MODELS["groq"],
            updated_at=utc_now_ms(),
        )
        db.add(settings)
        db.commit()
        db.refresh(settings)
        return settings

    # Lazy migration: upgrade any retired model id persisted before the
    # provider removed it, so existing selections keep working automatically.
    if _upgrade_deprecated_model(settings):
        db.commit()
        db.refresh(settings)
    return settings
