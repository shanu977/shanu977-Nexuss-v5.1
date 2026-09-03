export const PROVIDERS = {
  groq: {
    name: "Groq",
    model: "openai/gpt-oss-120b",
    icon: "groq"
  },
  gemini: {
    name: "Gemini",
    model: "gemini-3.6-flash",
    icon: "gemini"
  },
  openrouter: {
    name: "OpenRouter",
    model: "openai/gpt-oss-120b",
    icon: "openrouter"
  },
  local: {
    name: "Local",
    model: "",
    icon: "local"
  }
} as const;

export type ProviderType = keyof typeof PROVIDERS;

export const PROVIDER_LIST: ProviderType[] = ["groq", "gemini", "openrouter", "local"];

export interface ProviderModelOption {
  id: string;
  label: string;
  badge?: "FREE" | "FREE*";
}

// Models exposed in the settings UI per provider, with human-readable labels
// and free-tier badges. Must stay in sync with the ALLOWED_MODELS map in
// backend/app/schemas/settings.py.
export const PROVIDER_MODEL_OPTIONS: Record<ProviderType, readonly ProviderModelOption[]> = {
  groq: [
    { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", badge: "FREE" },
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", badge: "FREE" },
    { id: "qwen/qwen3.6-27b", label: "Qwen 3.6 27B", badge: "FREE" },
    { id: "groq/compound", label: "Groq Compound", badge: "FREE" },
    { id: "groq/compound-mini", label: "Groq Compound Mini", badge: "FREE" }
  ],
  gemini: [
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", badge: "FREE*" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", badge: "FREE*" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", badge: "FREE*" },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", badge: "FREE*" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", badge: "FREE*" },
    { id: "gemma-4", label: "Gemma 4", badge: "FREE*" }
  ],
  openrouter: [
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", badge: "FREE" },
    { id: "openai/gpt-oss-20b:free", label: "GPT-OSS 20B", badge: "FREE" },
    { id: "nvidia/nemotron-3-ultra:free", label: "Nemotron 3 Ultra", badge: "FREE" },
    { id: "nvidia/nemotron-3-super:free", label: "Nemotron 3 Super", badge: "FREE" },
    { id: "nex-agi/nex-n2-pro:free", label: "Nex-N2-Pro", badge: "FREE" },
    { id: "liquid/lfm2.5-1.2b-instruct:free", label: "LFM2.5 1.2B Instruct", badge: "FREE" },
    { id: "openrouter/free", label: "OpenRouter Free Router", badge: "FREE" }
  ],
  local: []
};

export const DEFAULT_PROVIDER_MODELS: Record<ProviderType, string> = {
  groq: "openai/gpt-oss-120b",
  gemini: "gemini-3.6-flash",
  openrouter: "openai/gpt-oss-120b",
  local: ""
};

// A provider and model must always be a valid combination: a model from one
// provider is never valid for another, so invalid combos are rejected up front
// instead of being silently rewritten downstream.
export function isValidModelForProvider(
  provider: ProviderType,
  model: string
): boolean {
  if (provider === "local") {
    if (!model || !model.trim()) return false;
    // For local, check dynamic store if available (lazy import to avoid circular deps)
    try {
      // Dynamic require to avoid bundling issues in tests without store
      const { useLocalModelStore } = require("@/store/localModelStore") as {
        useLocalModelStore: { getState: () => { models: { modelId: string; enabled: boolean }[] } };
      };
      const models = useLocalModelStore.getState().models;
      // If no local models configured, allow any non-empty (manual entry case)
      if (models.length === 0) return true;
      return models.some((m) => m.modelId === model && m.enabled);
    } catch {
      return true;
    }
  }
  return PROVIDER_MODEL_OPTIONS[provider].some((m) => m.id === model);
}

export function getModelLabel(
  provider: ProviderType,
  model: string
): string {
  const option = PROVIDER_MODEL_OPTIONS[provider].find((m) => m.id === model);
  if (option) return option.badge ? `${option.label} (${option.badge})` : option.label;
  // For local, return modelId as label
  if (model) return model;
  return model;
}
