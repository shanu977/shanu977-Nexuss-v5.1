from sqlalchemy.orm import Session

from ..models import User
from ..schemas.chat import ChatRequest, ChatResponse, FallbackAttempt
from ..schemas.settings import ALLOWED_MODELS, ALLOWED_PROVIDERS
from . import fallback_service, llm_service, prompt_service, settings_service


def handle_chat(db: Session, user: User, payload: ChatRequest) -> ChatResponse:
    """Answer a single message. Stateless by design: chat history lives on the
    client (IndexedDB), so the backend never persists conversations/messages.
    The client sends the relevant prior turns in `history` for context.

    The provider/model come from the request (authoritative UI selection) or
    the user's saved settings, and the API key is resolved from Supabase for
    that provider. This keeps the UI indicator and the actual call in lockstep
    and removes any need for the client to handle keys.

    If the primary provider/model hits a temporary failure (rate limit,
    overload, 5xx, network), the centralized fallback engine retries the next
    configured provider. The user's saved provider/model are never changed.
    """
    settings = settings_service.get_or_create_settings(db, user)
    provider = payload.provider or settings.provider or "groq"
    if provider not in ALLOWED_PROVIDERS:
        raise llm_service.UnsupportedProviderError()

    model = payload.model or settings.model
    if model not in ALLOWED_MODELS.get(provider, set()):
        if payload.model:
            # An explicitly selected model must never be silently swapped.
            # Reject loudly so the UI stays in lockstep with the backend.
            raise llm_service.BadRequestError(
                f"Model '{model}' is not supported by provider '{provider}'. "
                "Select a valid model for this provider in Settings."
            )
        # No explicit model: guard against a stale saved value (e.g. a model
        # removed from the allowed list) by using the provider default.
        model = settings_service.DEFAULT_MODELS.get(
            provider, settings_service.DEFAULT_MODELS["groq"]
        )

    history = [{"role": turn.role, "content": turn.content} for turn in payload.history]
    messages = prompt_service.build_messages(history, payload.message)

    result = fallback_service.execute_with_fallback(
        db, user, messages, primary_provider=provider, primary_model=model
    )

    return ChatResponse(
        reply=result["reply"],
        provider=result["provider"],
        model=result["model"],
        usage=result["usage"].to_dict(),
        fallback_used=result["fallback_used"],
        attempts=[FallbackAttempt(**attempt) for attempt in result["attempts"]],
    )
