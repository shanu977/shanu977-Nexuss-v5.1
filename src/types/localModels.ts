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
