from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import User, UserSettings
from ..models.models import utc_now_ms

DEFAULT_MODELS = {
    "groq": "llama-3.3-70b-versatile",
    "gemini": "gemini-3.6-flash",
    "openrouter": "openai/gpt-oss-120b:free",
}


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
