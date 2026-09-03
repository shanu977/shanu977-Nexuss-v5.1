export type LocalProviderType = "ollama" | "lmstudio" | "vllm" | "generic";

export const LOCAL_PROVIDER_LABELS: Record<LocalProviderType, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  vllm: "vLLM",
  generic: "Generic OpenAI-compatible",
};

export const LOCAL_PROVIDER_DEFAULT_ENDPOINTS: Record<LocalProviderType, string> = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
  vllm: "http://localhost:8000/v1",
  generic: "http://localhost:8000/v1",
};

export interface LocalProvider {
  id: string;
  userId: string;
  name: string;
  providerType: LocalProviderType;
  endpoint: string; // normalized, always ends with /v1
  apiKey?: string; // optional, for authenticated local servers
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LocalModel {
  id: string;
  userId: string;
  providerId: string;
  modelId: string; // as reported by /models, e.g. "llama3.2:3b"
  displayName: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type LocalHealthStatus = "connected" | "not_connected" | "error" | "disabled";

/** Normalize endpoint: handle Ollama bare host, trailing slash, etc. */
export function normalizeEndpoint(input: string, providerType: LocalProviderType = "generic"): string {
  let raw = input.trim();
  if (!raw) return raw;
  // Add scheme if missing
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    const url = new URL(raw);
    let pathname = url.pathname.replace(/\/+$/, "");
    // Ollama special: bare http://localhost:11434 -> /v1
    if (providerType === "ollama" && (pathname === "" || pathname === "/")) {
      pathname = "/v1";
    } else if (pathname === "") {
      pathname = "/v1";
    } else if (pathname === "/v1") {
      // already correct
    } else if (!pathname.endsWith("/v1")) {
      // If user typed .../v1/models or .../v1/chat/completions, strip to /v1
      if (pathname.includes("/v1")) {
        pathname = pathname.slice(0, pathname.indexOf("/v1") + 3);
      } else if (!pathname.endsWith("/v1")) {
        // keep as is, but ensure /v1 suffix for most cases
        // For generic, if they typed /api or root, leave? We normalize to /v1 only for known local types
        // Do nothing – user knows what they're doing
      }
    }
    // Remove trailing slash except after host
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

export function validateEndpoint(input: string): string | null {
  if (!input.trim()) return "Endpoint is required.";
  try {
    const normalized = normalizeEndpoint(input);
    const url = new URL(normalized);
    if (!["http:", "https:"].includes(url.protocol)) return "Endpoint must be http:// or https://";
    if (!url.hostname) return "Invalid endpoint URL.";
    // Block cloud metadata endpoints (SSRF defense, even though we do browser-direct)
    const host = url.hostname.toLowerCase();
    if (host === "169.254.169.254" || host === "metadata.google.internal" || host.endsWith(".internal")) {
      return "Endpoint host is not allowed.";
    }
    return null;
  } catch {
    return "Invalid endpoint URL.";
  }
}

// --- Environment helpers for Ollama local vs production ---

/** True when running inside Nexuss Desktop (Electron) where window.nexussDesktop is exposed. */
export function isDesktop(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window as unknown as { nexussDesktop?: unknown }).nexussDesktop;
}

/** True when running on http://localhost:3000 or http://127.0.0.1:3000 (local dev). */
export function isLocalDev(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** True when running on production web (https://www.nexuss.in, https://nexuss.in, https://*.vercel.app). */
export function isProductionWeb(): boolean {
  if (typeof window === "undefined") return false;
  if (isDesktop()) return false;
  if (isLocalDev()) return false;
  const protocol = window.location.protocol;
  const host = window.location.hostname;
  // Any https host that is not localhost is considered production web
  if (protocol === "https:") return true;
  // Also treat vercel preview and nexuss.in as production even if http (should not happen)
  if (host.includes("nexuss.in") || host.includes("vercel.app")) return true;
  return false;
}

/** Whether the browser can directly fetch http://localhost:11434 (local dev or desktop). */
export function canUseLocalModelsDirect(): boolean {
  if (typeof window === "undefined") return true; // for tests/SSR, allow
  return isDesktop() || isLocalDev();
}

export function getLocalModelProductionMessage(): string {
  return "Ollama runs locally on your own machine. Local models are only available when using Nexuss Desktop or running Nexuss locally at http://localhost:3000. Production https://www.nexuss.in cannot directly access your localhost Ollama. Please use Nexuss Desktop or run npm run dev locally to chat with Ollama at http://localhost:11434.";
}
