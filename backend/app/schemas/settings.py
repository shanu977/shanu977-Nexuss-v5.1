from pydantic import BaseModel, field_validator

ALLOWED_PROVIDERS = ("groq", "gemini", "openrouter")

# Models the UI exposes per provider. The backend validates the combination
# server-side so a request can never mix a provider with another's model.
ALLOWED_MODELS = {
    "groq": {
        "llama-3.1-8b-instant",
        "llama-3.3-70b-versatile",
        "openai/gpt-oss-20b",
        "openai/gpt-oss-120b",
        "qwen/qwen3.6-27b",
        "groq/compound",
        "groq/compound-mini",
    },
    "gemini": {
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-2.5-pro",
        "gemma-4",
    },
    "openrouter": {
        "openai/gpt-oss-120b:free",
        "openai/gpt-oss-20b:free",
        "nvidia/nemotron-3-ultra:free",
        "nvidia/nemotron-3-super:free",
        "nex-agi/nex-n2-pro:free",
        "liquid/lfm2.5-1.2b-instruct:free",
        "openrouter/free",
    },
}

# Server-side vision models used by the screen-share feature. When a user
# sends a frame+question, the backend routes to a vision-capable model instead
# of blindly sending the image to a text-only model. The selected model is used
# when it supports images; otherwise the provider's vision default below is used.
#
# NOTE: Groq decommissioned the llama-3.2 vision-preview models on 2025-04-14
# and later removed the Llama 4 models (calling a retired ID returns a provider
# 400). The ONLY vision-capable model currently on Groq is qwen/qwen3.6-27b
# (see Groq docs "Images and Vision"). OpenRouter's llama-3.2 vision instruct
# model was also retired; the free multimodal default is a Nemotron 3 Nano Omni
# model (verified present in OpenRouter's current /models catalog).
VISION_MODELS = {
    "groq": "qwen/qwen3.6-27b",
    "gemini": "gemini-3.6-flash",
    "openrouter": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
}

# Model IDs that accept image input. A request with an image uses the user's
# selected model only if it is listed here (Gemini models are all multimodal).
# qwen/qwen3.6-27b is the sole Groq vision model and is user-selectable.
VISION_CAPABLE_MODELS = {
    "groq": {"qwen/qwen3.6-27b"},
    "gemini": set(ALLOWED_MODELS["gemini"]),
    "openrouter": {"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"},
}


class UserSettingsOut(BaseModel):
    theme: str
    language: str
    provider: str
    model: str
    updatedAt: int


class UserSettingsUpdate(BaseModel):
    theme: str | None = None
    language: str | None = None
    provider: str | None = None
    model: str | None = None

    model_config = {"extra": "forbid"}

    @field_validator("provider")
    @classmethod
    def provider_is_supported(cls, v: str | None) -> str | None:
        if v is not None and v not in ALLOWED_PROVIDERS:
            raise ValueError(
                f"provider must be one of {', '.join(ALLOWED_PROVIDERS)}"
            )
        return v
