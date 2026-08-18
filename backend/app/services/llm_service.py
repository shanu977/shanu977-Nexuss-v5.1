from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import json
import time
from typing import Dict, Iterator, List, Tuple

import httpx

from ..config import settings

GROQ_TIMEOUT_SECONDS = 60.0

# Per-provider cap for a SINGLE provider attempt (seconds). These bound the
# request the backend makes to each provider, so one hung provider cannot stall
# the chain. The fallback chain additionally caps the TOTAL across all
# sequential attempts via `ai_total_deadline_seconds`, so a request can never
# accumulate unbounded sequential waits.
PROVIDER_TIMEOUT_SECONDS = {
    "groq": 60.0,
    "gemini": 60.0,
    "openrouter": 60.0,
}


def provider_timeout(provider: str) -> float:
    """Per-attempt timeout cap for a provider (seconds)."""
    return PROVIDER_TIMEOUT_SECONDS.get(provider, GROQ_TIMEOUT_SECONDS)

# OpenAI-compatible chat completion endpoints per provider. User-selected
# models are validated server-side before a request is ever sent.
PROVIDER_ENDPOINTS = {
    "groq": "groq_base_url/chat/completions",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    "openrouter": "https://openrouter.ai/api/v1/chat/completions",
}

# Server-side default models per provider (used only when a user has not yet
# chosen a model). Keys must match PROVIDER_ENDPOINTS.
PROVIDER_DEFAULT_MODELS = {
    "groq": "openai/gpt-oss-120b",
    "gemini": "gemini-3.6-flash",
    "openrouter": "openai/gpt-oss-120b:free",
}

_client: httpx.Client | None = None


class AIProviderError(Exception):
    """Base error for AI provider failures. Never carries the API key.

    `http_status` is the provider's HTTP status when known (None for network
    failures). `category` is a machine-readable reason used by the centralized
    fallback engine to decide whether the failure is temporary.
    """

    def __init__(
        self,
        message: str = "",
        *,
        http_status: int | None = None,
        category: str | None = None,
    ) -> None:
        super().__init__(message)
        self.http_status = http_status
        self.category = category


class MissingAPIKeyError(AIProviderError):
    def __init__(self, message: str | None = None) -> None:
        super().__init__(
            message or "AI provider API key is not configured on the server.",
            category="missing_key",
        )


class InvalidAPIKeyError(AIProviderError):
    def __init__(self) -> None:
        super().__init__(
            "AI provider rejected the API key.", category="invalid_key"
        )


class RateLimitError(AIProviderError):
    def __init__(
        self,
        *,
        retry_after: float | None = None,
        http_status: int | None = 429,
    ) -> None:
        super().__init__(
            "AI provider rate limit exceeded. Try again later.",
            http_status=http_status or 429,
            category="rate_limit",
        )
        self.retry_after = retry_after


class ProviderUnavailableError(AIProviderError):
    def __init__(
        self,
        message: str | None = None,
        *,
        http_status: int | None = None,
        category: str | None = None,
    ) -> None:
        super().__init__(
            message or "AI provider is unavailable. Please try again.",
            http_status=http_status,
            category=category or "provider_unavailable",
        )


class BadRequestError(AIProviderError):
    def __init__(
        self, message: str | None = None, *, http_status: int | None = None
    ) -> None:
        super().__init__(
            message
            or (
                "The AI provider rejected the request. It may be too large or "
                "malformed; please shorten the message and try again."
            ),
            http_status=http_status,
            category="bad_request",
        )


class InvalidModelError(AIProviderError):
    def __init__(self, message: str | None = None) -> None:
        super().__init__(
            message or "The AI provider does not recognize the requested model.",
            http_status=404,
            category="invalid_model",
        )


class EmptyResponseError(AIProviderError):
    def __init__(self) -> None:
        super().__init__(
            "The AI provider returned an empty response. Try again.",
            category="empty_response",
        )


class UnsupportedProviderError(AIProviderError):
    def __init__(self) -> None:
        super().__init__(
            "Unsupported AI provider selected.", category="unsupported_provider"
        )


class UsageInfo:
    """Token usage returned by an AI provider. All fields default to 0 when
    the provider does not return usage data."""

    def __init__(
        self,
        input_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int = 0,
    ) -> None:
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.total_tokens = total_tokens

    def to_dict(self) -> dict:
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
        }


def get_api_key() -> str:
    """Return the server-side Groq API key. Never logs or returns it anywhere else."""
    key = settings.groq_api_key.strip()
    if not key:
        raise MissingAPIKeyError()
    return key


def get_model() -> str:
    return settings.ai_model.strip() or "openai/gpt-oss-120b"


def resolve_endpoint(provider: str) -> str:
    """Absolute chat-completion URL for a provider. Raises for unknown providers."""
    template = PROVIDER_ENDPOINTS.get(provider)
    if template is None:
        raise UnsupportedProviderError()
    if template == "groq_base_url/chat/completions":
        return f"{settings.groq_base_url.rstrip('/')}/chat/completions"
    return template


def get_max_tokens() -> int:
    # Clamp so a misconfigured value can never produce an absurd request
    # (or a provider 400) that would break every chat call.
    return max(1, min(settings.ai_max_tokens, 4096))


def _get_client() -> httpx.Client:
    """Return a shared, thread-safe HTTP client (reused across requests)."""
    global _client
    if _client is None:
        _client = httpx.Client(timeout=GROQ_TIMEOUT_SECONDS)
    return _client


def _usage_from_dict(data) -> UsageInfo:
    return UsageInfo(
        input_tokens=data.get("prompt_tokens", 0),
        output_tokens=data.get("completion_tokens", 0),
        total_tokens=data.get("total_tokens", 0),
    )


def _stream_timeout(timeout: float | None) -> httpx.Timeout:
    """Timeout for a streaming request.

    Connect/write/pool phases stay short so a dead provider is detected fast;
    the read phase is the per-chunk ceiling (capped so one hung chunk cannot
    stall the whole chain). The overall wall-clock deadline is enforced by the
    fallback engine between chunks, so a healthy stream keeps flowing while a
    silent one still fails quickly.
    """
    read = min(timeout or GROQ_TIMEOUT_SECONDS, 30.0)
    return httpx.Timeout(connect=10.0, read=read, write=10.0, pool=10.0)


def _extract_retry_after(resp) -> float | None:
    """Best-effort cooldown hint from a 429 response.

    Checks the `Retry-After` header (seconds or HTTP-date) then the
    `X-RateLimit-Reset` header (epoch seconds or milliseconds). Returns seconds
    to wait, or None when the provider gave no usable hint.
    """
    raw_headers = getattr(resp, "headers", None) or {}
    if not isinstance(raw_headers, dict):
        try:
            raw_headers = dict(raw_headers)
        except Exception:
            raw_headers = {}
    headers = {k.lower(): v for k, v in raw_headers.items()}

    retry_after = headers.get("retry-after")
    if retry_after:
        try:
            return max(0.0, float(retry_after))
        except (TypeError, ValueError):
            try:
                delta = parsedate_to_datetime(retry_after) - datetime.now(timezone.utc)
                return max(0.0, delta.total_seconds())
            except Exception:
                return None

    reset = headers.get("x-ratelimit-reset")
    if reset:
        try:
            reset_ts = float(reset)
            if reset_ts > 1_000_000_000_000:
                reset_ts /= 1000.0  # milliseconds -> seconds
            return max(0.0, reset_ts - time.time())
        except (TypeError, ValueError):
            return None

    return None


def _map_error(status_code: int | None, resp=None) -> AIProviderError:
    if status_code in (400, 422):
        return BadRequestError(http_status=status_code)
    if status_code in (401, 403):
        return InvalidAPIKeyError()
    if status_code == 404:
        # Unknown model or wrong endpoint: permanent, never a fallback trigger.
        return InvalidModelError()
    if status_code == 429:
        return RateLimitError(retry_after=_extract_retry_after(resp), http_status=429)
    # 5xx and anything unexpected: temporary server-side failure.
    category = "overload" if status_code in (500, 503) else "provider_unavailable"
    return ProviderUnavailableError(http_status=status_code, category=category)


def complete(
    messages: List[Dict],
    *,
    provider: str = "groq",
    model: str | None = None,
    api_key: str | None = None,
    timeout: float | None = None,
) -> tuple[str, UsageInfo]:
    """Send a chat completion request to the selected provider.

    `messages` is OpenAI-style: [{"role": "system"|"user"|"assistant",
    "content": ...}]. `content` may be a string (text chat) or a list of
    content parts (e.g. a text + image_url pair for screen analysis); the
    payload is passed through unchanged to the provider's OpenAI-compatible
    endpoint.

    - provider: one of "groq", "gemini", "openrouter"
    - model: user-selected model id; falls back to a provider default when absent
    - api_key: the user's key for the provider; falls back to the server Groq
      key for groq when absent. Never logged.
    - timeout: hard per-attempt ceiling in seconds. When None, the provider's
      own cap (``PROVIDER_TIMEOUT_SECONDS``) applies. The fallback engine passes
      the remaining chain budget so a single attempt can never exceed it.

    Returns (reply_text, usage_info) where usage_info contains token counts.
    """
    if provider not in PROVIDER_ENDPOINTS:
        raise UnsupportedProviderError()

    if not api_key:
        if provider == "groq":
            api_key = get_api_key()
        else:
            raise MissingAPIKeyError()

    resolved_model = model or (
        get_model() if provider == "groq" else PROVIDER_DEFAULT_MODELS[provider]
    )

    payload = {
        "model": resolved_model,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": get_max_tokens(),
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    url = resolve_endpoint(provider)

    request_kwargs: Dict = {"json": payload, "headers": headers}
    if timeout is not None:
        request_kwargs["timeout"] = timeout

    try:
        resp = _get_client().post(url, **request_kwargs)
    except httpx.TimeoutException:
        raise ProviderUnavailableError(
            "The AI provider timed out. Please try again.", category="network"
        ) from None
    except httpx.HTTPError:
        raise ProviderUnavailableError(
            "Network error reaching the AI provider. Please try again.",
            category="network",
        ) from None

    if resp.status_code != 200:
        raise _map_error(resp.status_code, resp)

    try:
        data = resp.json()
        message = data["choices"][0].get("message") or {}
        raw = message.get("content")
    except (KeyError, IndexError, TypeError, ValueError):
        raise ProviderUnavailableError() from None

    if not isinstance(raw, str) or not raw.strip():
        raise EmptyResponseError()

    usage_data = data.get("usage") or {}
    usage = _usage_from_dict(usage_data)

    return raw.strip(), usage


def complete_stream(
    messages: List[Dict],
    *,
    provider: str = "groq",
    model: str | None = None,
    api_key: str | None = None,
    timeout: float | None = None,
) -> Iterator[Tuple[str | None, UsageInfo | None]]:
    """Stream a chat completion from the selected provider.

    Returns a generator yielding ``(delta, usage)`` tuples:
      - ``(text, None)`` for each content delta (already stripped of trailing
        whitespace; deltas are streamed exactly as the provider sends them)
      - ``(None, UsageInfo)`` as the final item once the stream completes

    Raises the same ``AIProviderError`` hierarchy as ``complete`` for setup
    problems (unsupported provider, missing key, empty response) and maps
    transport / HTTP failures the same way. A failure while the stream is
    already producing content is raised from the generator's iteration; any
    text already yielded is preserved by the caller.
    """
    if provider not in PROVIDER_ENDPOINTS:
        raise UnsupportedProviderError()

    if not api_key:
        if provider == "groq":
            api_key = get_api_key()
        else:
            raise MissingAPIKeyError()

    resolved_model = model or (
        get_model() if provider == "groq" else PROVIDER_DEFAULT_MODELS[provider]
    )

    payload = {
        "model": resolved_model,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": get_max_tokens(),
        "stream": True,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    url = resolve_endpoint(provider)

    return _stream_payload(
        url,
        {"json": payload, "headers": headers, "timeout": _stream_timeout(timeout)},
    )


def _stream_payload(
    url: str, request_kwargs: Dict
) -> Iterator[Tuple[str | None, UsageInfo | None]]:
    """Generator that reads an OpenAI-style SSE stream from a provider."""
    client = _get_client()
    produced = False
    usage: UsageInfo | None = None
    try:
        with client.stream("POST", url, **request_kwargs) as resp:
            if resp.status_code != 200:
                raise _map_error(resp.status_code, resp)

            for line in resp.iter_lines():
                if not line:
                    continue
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except ValueError:
                    continue  # ignore malformed keep-alive chunks
                if obj.get("usage"):
                    usage = _usage_from_dict(obj["usage"])
                choices = obj.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                text = delta.get("content")
                if isinstance(text, str) and text:
                    produced = True
                    yield text, None
    except httpx.TimeoutException:
        raise ProviderUnavailableError(
            "The AI provider timed out. Please try again.", category="network"
        ) from None
    except httpx.HTTPError:
        raise ProviderUnavailableError(
            "Network error reaching the AI provider. Please try again.",
            category="network",
        ) from None

    if not produced:
        raise EmptyResponseError()
    yield None, usage or UsageInfo()
