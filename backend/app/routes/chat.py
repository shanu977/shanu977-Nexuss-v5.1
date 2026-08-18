import json
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import User
from ..routes.deps import get_current_user
from ..schemas.chat import ChatRequest, ChatResponse
from ..services import ai_service, fallback_service, llm_service, usage_service
from ..services.prompt_service import ContextLimitError

logger = logging.getLogger("uvicorn.error")

router = APIRouter(prefix="/chat", tags=["chat"])


def _sse(payload: dict) -> str:
    """Serialize one server-sent event (single-line JSON in a `data:` field)."""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _http_error(exc: Exception) -> HTTPException | None:
    """Map a known backend exception to its HTTP error, or None if it must be
    handled elsewhere (e.g. ProviderFailureError, handled app-level with the
    attempt log)."""
    if isinstance(exc, fallback_service.ProviderFailureError):
        return None
    if isinstance(exc, ValueError):
        return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    if isinstance(exc, ContextLimitError):
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        )
    if isinstance(exc, llm_service.BadRequestError):
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        )
    if isinstance(exc, llm_service.InvalidModelError):
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        )
    if isinstance(exc, llm_service.EmptyResponseError):
        return HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
        )
    if isinstance(exc, llm_service.MissingAPIKeyError):
        return HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        )
    if isinstance(exc, llm_service.UnsupportedProviderError):
        return HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        )
    if isinstance(exc, llm_service.InvalidAPIKeyError):
        return HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
        )
    if isinstance(exc, llm_service.RateLimitError):
        return HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)
        )
    if isinstance(exc, llm_service.AIProviderError):
        return HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
        )
    return None


@router.post("", response_model=ChatResponse)
def chat(
    payload: ChatRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Send a message to the AI assistant. Creates/uses a conversation,
    stores both messages, and returns the assistant reply."""
    try:
        return ai_service.handle_chat(db, user, payload)
    except fallback_service.ProviderFailureError:
        # Handled by the app-level exception handler, which includes the full
        # attempt log so the client can record usage for every provider tried.
        raise
    except Exception as exc:
        http_error = _http_error(exc)
        if http_error is not None:
            raise http_error
        logger.exception("Unexpected error in /chat")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="An unexpected error occurred. Please try again.",
        )


@router.post("/stream")
def chat_stream(
    payload: ChatRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """SSE stream of the assistant answer.

    Same authentication, provider routing, model selection and fallback rules
    as POST /chat, but each content delta is forwarded to the client
    immediately as it is generated. Events are single-line JSON:

      - ``{"type":"chunk","content":...}``  content delta
      - ``{"type":"usage", ...}``           final event on success (carries the
                                            attempt log and usage metadata)
      - ``{"type":"error", ...}``           provider failure (carries the
                                            attempt log; ``partial`` is true
                                            when some content was already sent)

    Request-level validation errors raise before any bytes are sent, so they
    surface as normal JSON error responses. Once streaming has started the
    response status is fixed at 200, so provider failures are delivered as
    ``error`` events instead.
    """
    # Validation and prompt building run here (before streaming starts), so
    # request-level errors keep their proper HTTP status via normal handling.
    try:
        events = ai_service.handle_chat_stream(db, user, payload)
    except Exception as exc:
        http_error = _http_error(exc)
        if http_error is not None:
            raise http_error
        logger.exception("Unexpected error starting /chat/stream")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="An unexpected error occurred. Please try again.",
        )
    request_type = "screen_share" if payload.image else "chat"

    def event_stream():
        try:
            for event in events:
                if event["type"] == "usage":
                    # Best-effort analytics persistence (never fails the stream).
                    usage_service.record_attempts(
                        db, user, request_type, event.get("attempts")
                    )
                yield _sse(event)
        except Exception:
            # The provider-error path is fully handled inside ai_service (SSE
            # error events); anything reaching here is unexpected.
            logger.exception("Unexpected error in /chat/stream")
            yield _sse(
                {
                    "type": "error",
                    "status": 500,
                    "message": "An unexpected error occurred. Please try again.",
                    "attempts": [],
                    "partial": False,
                }
            )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
