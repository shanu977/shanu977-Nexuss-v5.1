from sqlalchemy.orm import Session

from ..models import User
from ..schemas.chat import ChatRequest, ChatResponse, FallbackAttempt
from ..schemas.settings import (
    ALLOWED_MODELS,
    ALLOWED_PROVIDERS,
    VISION_CAPABLE_MODELS,
    VISION_MODELS,
)
from ..utils.reasoning import filter_reasoning
from . import fallback_service, llm_service, prompt_service, settings_service, usage_service


def _resolve_vision_model(provider: str, selected_model: str) -> str | None:
    """Pick the model that actually receives a frame+question request.

    Uses the user's selected model when it accepts images, otherwise the
    provider's server-side vision default. Returns None when the provider has
    no vision-capable model configured.
    """
    capable = VISION_CAPABLE_MODELS.get(provider, set())
    if selected_model in capable:
        return selected_model
    return VISION_MODELS.get(provider)


def handle_chat(db: Session, user: User, payload: ChatRequest) -> ChatResponse:
    """Answer a single message. Stateless by design: chat history lives on the
    client (IndexedDB), so the backend never persists conversations/messages.
    The client sends the relevant prior turns in `history` for context.

    The provider/model come from the request (authoritative UI selection) or
    the user's saved settings, and the API key is resolved from Supabase for
    that provider. This keeps the UI indicator and the actual call in lockstep
    and removes any need for the client to handle keys.

    When `payload.image` carries a single screen-share frame, the request is
    routed to a vision-capable model (the selected model if it accepts images,
    otherwise the provider's vision default). The frame is processed transiently
    and never stored.

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

    history = [
        {"role": turn.role, "content": turn.content}
        for turn in payload.history
        if turn.content.strip()
    ]

    # Distinguish the two real request paths for analytics: a frame+question
    # (screen analysis) vs a plain text chat.
    request_type = "screen_share" if payload.image else "chat"

    fallback_models = None
    if payload.image:
        # A frame+question must never be sent to a text-only model. Route to a
        # vision-capable model and keep every fallback candidate vision-capable.
        primary_model = _resolve_vision_model(provider, model)
        if primary_model is None:
            raise llm_service.BadRequestError(
                f"Provider '{provider}' has no vision-capable model configured "
                "for screen analysis. Select a different provider or model."
            )
        messages = prompt_service.build_vision_messages(
            history, payload.message, payload.image
        )
        fallback_models = VISION_MODELS
    else:
        primary_model = model
        messages = prompt_service.build_messages(history, payload.message)

    # Optional workspace context (relevant local files selected by the client's
    # Path engine) is attached as its own prompt region before the user message,
    # keeping chat history and workspace context distinct.
    if payload.workspace_context:
        messages = prompt_service.attach_workspace_context(
            messages, payload.workspace_context
        )

    try:
        result = fallback_service.execute_with_fallback(
            db,
            user,
            messages,
            primary_provider=provider,
            primary_model=primary_model,
            fallback_models=fallback_models,
        )
    except fallback_service.ProviderFailureError as exc:
        # Every attempt failed: persist the usage metadata for the attempts
        # that were made, then re-raise. Persistence is best-effort and never
        # changes the error surfaced to the client.
        usage_service.record_attempts(db, user, request_type, exc.attempts)
        raise

    # Best-effort analytics persistence (success path). record_attempts never
    # raises, so a database problem cannot fail the chat request.
    usage_service.record_attempts(db, user, request_type, result["attempts"])

    return ChatResponse(
        reply=filter_reasoning(result["reply"]),
        provider=result["provider"],
        model=result["model"],
        usage=result["usage"].to_dict(),
        fallback_used=result["fallback_used"],
        attempts=[FallbackAttempt(**attempt) for attempt in result["attempts"]],
    )
