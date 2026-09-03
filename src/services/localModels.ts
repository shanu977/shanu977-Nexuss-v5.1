"use client";

import { normalizeEndpoint, validateEndpoint, isDesktop } from "@/types/localModels";

export interface LocalTestResult {
  ok: boolean;
  message: string;
  models?: string[];
  endpointReachable: boolean;
  modelsDiscoverable: boolean;
}

export interface LocalChatMessage {
  role: string;
  content: string;
}

const MODEL_DISCOVERY_TIMEOUT_MS = 6000;

function timeoutFetch(url: string, opts: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  const finalSignal: AbortSignal = controller.signal;
  if (opts.signal) {
    const orig = opts.signal as AbortSignal;
    if (orig.aborted) controller.abort();
    else orig.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return fetch(url, { ...opts, signal: finalSignal }).finally(() => clearTimeout(id));
}

const CONNECTOR_ENDPOINT = "http://127.0.0.1:11435/v1";
const CONNECTOR_HEALTH_TIMEOUT_MS = 1500;

async function isConnectorAvailable(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  // Only try connector for Ollama on localhost:11434
  try {
    const res = await timeoutFetch(`http://127.0.0.1:11435/health`, { method: "GET" }, CONNECTOR_HEALTH_TIMEOUT_MS);
    return res.ok;
  } catch {
    return false;
  }
}

export async function testLocalEndpoint(
  rawEndpoint: string,
  providerType: string = "generic",
  apiKey?: string
): Promise<LocalTestResult> {
  const err = validateEndpoint(rawEndpoint);
  if (err) {
    return { ok: false, message: err, endpointReachable: false, modelsDiscoverable: false };
  }
  let endpoint = normalizeEndpoint(rawEndpoint, providerType as never);
  // For Ollama on localhost:11434, try the Nexuss Local Connector first (handles CORS/PNA for https://www.nexuss.in)
  if (providerType === "ollama" && (endpoint === "http://localhost:11434/v1" || endpoint === "http://127.0.0.1:11434/v1")) {
    try {
      const connectorAvailable = await isConnectorAvailable();
      if (connectorAvailable) {
        endpoint = CONNECTOR_ENDPOINT;
      }
    } catch {}
  }

  // Try desktop IPC first if available (Electron main process fetches without CORS/mixed-content)
  const desktopOllama = (typeof window !== "undefined"
    ? (window as unknown as { nexussDesktop?: { ollama?: { test?: (url: string, key?: string) => Promise<LocalTestResult> } } }).nexussDesktop?.ollama
    : undefined) as { test?: (url: string, key?: string) => Promise<LocalTestResult> } | undefined;
  if (isDesktop() && desktopOllama?.test) {
    try {
      const res = await desktopOllama.test(endpoint, apiKey);
      return res;
    } catch {
      // Fall through to direct fetch
    }
  }
  // 1. Try /models discovery
  const modelsUrl = `${endpoint.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey?.trim()) headers["Authorization"] = `Bearer ${apiKey.trim()}`;

  try {
    const res = await timeoutFetch(modelsUrl, { method: "GET", headers }, MODEL_DISCOVERY_TIMEOUT_MS);
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const models: string[] = [];
      if (data) {
        // OpenAI format: { data: [{id: "llama3.2:3b"}, ...] } or { models: [...] } or array
        const rawList = Array.isArray(data) ? data : data.data || data.models || [];
        for (const m of rawList) {
          if (typeof m === "string") models.push(m);
          else if (m && typeof m.id === "string") models.push(m.id);
          else if (m && typeof m.name === "string") models.push(m.name);
        }
      }
      if (models.length > 0) {
        return {
          ok: true,
          message: `Connected. Found ${models.length} model${models.length === 1 ? "" : "s"}.`,
          models,
          endpointReachable: true,
          modelsDiscoverable: true,
        };
      }
      return {
        ok: true,
        message: "Endpoint reachable. Model discovery returned no models — you can enter the model ID manually.",
        models: [],
        endpointReachable: true,
        modelsDiscoverable: false,
      };
    }
    // Non-2xx: check if endpoint reachable but /models unsupported
    if (res.status === 404 || res.status === 405) {
      // Try a lightweight chat completion probe? Just report reachable but discovery unavailable
      return {
        ok: true,
        message: "Endpoint reachable. Model discovery unavailable (404) — you can manually enter the model ID.",
        endpointReachable: true,
        modelsDiscoverable: false,
      };
    }
    if (res.status === 401) {
      return {
        ok: false,
        message: "Endpoint requires authentication (401). Check API key.",
        endpointReachable: true,
        modelsDiscoverable: false,
      };
    }
    // Other error
    return {
      ok: false,
      message: `Endpoint responded with ${res.status}. Check endpoint URL.`,
      endpointReachable: true,
      modelsDiscoverable: false,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const isAbort = msg.toLowerCase().includes("abort") || (e as Error).name === "AbortError";
    if (isAbort) {
      return {
        ok: false,
        message: "Cannot connect to endpoint (timeout). Is the server running? Check port and that CORS allows this origin.",
        endpointReachable: false,
        modelsDiscoverable: false,
      };
    }
    //NetworkError often CORS
    const lower = msg.toLowerCase();
    if (lower.includes("failed to fetch") || lower.includes("networkerror") || lower.includes("cors")) {
      return {
        ok: false,
        message: "Cannot connect to endpoint. Check that the server is running and allows CORS. For Ollama, set OLLAMA_ORIGINS=* or allow this origin.",
        endpointReachable: false,
        modelsDiscoverable: false,
      };
    }
    return {
      ok: false,
      message: `Cannot connect: ${msg}`,
      endpointReachable: false,
      modelsDiscoverable: false,
    };
  }
}

export async function discoverLocalModels(endpoint: string, apiKey?: string): Promise<string[]> {
  const result = await testLocalEndpoint(endpoint, "generic", apiKey);
  return result.models ?? [];
}

export interface DiscoveredOllamaModelDetailed {
  id: string;
  modelId: string;
  size?: number;
  modified?: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  created?: number;
}

/** For Ollama, fetch both /v1/models and /api/tags to enrich metadata. */
export async function discoverOllamaModelsDetailed(
  rawEndpoint: string,
  providerType: string = "ollama",
  apiKey?: string
): Promise<{ models: DiscoveredOllamaModelDetailed[]; endpointReachable: boolean }> {
  let endpoint = normalizeEndpoint(rawEndpoint, providerType as never);
  // For Ollama on localhost:11434, try the Nexuss Local Connector first (handles CORS/PNA for https://www.nexuss.in)
  if (providerType === "ollama" && (endpoint === "http://localhost:11434/v1" || endpoint === "http://127.0.0.1:11434/v1")) {
    try {
      const connectorAvailable = await isConnectorAvailable();
      if (connectorAvailable) {
        endpoint = CONNECTOR_ENDPOINT;
      }
    } catch {}
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey?.trim()) headers["Authorization"] = `Bearer ${apiKey.trim()}`;

  // Try desktop IPC first
  const desktopOllama = (typeof window !== "undefined"
    ? (window as unknown as { nexussDesktop?: { ollama?: { test?: (url: string, key?: string) => Promise<{ models?: string[] }> } } }).nexussDesktop?.ollama
    : undefined) as { test?: (url: string, key?: string) => Promise<{ models?: string[] }> } | undefined;
  if (isDesktop() && desktopOllama?.test) {
    try {
      const res = await desktopOllama.test(endpoint, apiKey);
      if (res.models && res.models.length > 0) {
        return {
          models: res.models.map((id) => ({ id, modelId: id })),
          endpointReachable: true,
        };
      }
    } catch {
      // fall through
    }
  }

  // Browser-direct: try /v1/models for IDs, then /api/tags for metadata (Ollama native)
  const modelIds: string[] = [];
  let endpointReachable = false;
  try {
    const modelsUrl = `${endpoint.replace(/\/$/, "")}/models`;
    const res = await timeoutFetch(modelsUrl, { method: "GET", headers }, MODEL_DISCOVERY_TIMEOUT_MS);
    if (res.ok) {
      endpointReachable = true;
      const data = await res.json().catch(() => null) as { data?: { id: string; created?: number }[]; models?: unknown[] } | null;
      const rawList = data ? (Array.isArray(data) ? data : data.data || (data as { models?: unknown[] }).models || []) : [];
      for (const m of rawList as unknown[]) {
        if (typeof m === "string") modelIds.push(m);
        else if (m && typeof (m as { id?: string }).id === "string") modelIds.push((m as { id: string }).id);
      }
    } else if (res.status === 404 || res.status === 405) {
      endpointReachable = true;
    } else {
      endpointReachable = res.ok;
    }
  } catch {
    // not reachable
  }

  // Try to enrich with /api/tags for Ollama (only for ollama provider)
  if (providerType === "ollama") {
    try {
      const base = endpoint.replace(/\/v1\/?$/, "");
      const tagsUrl = `${base.replace(/\/$/, "")}/api/tags`;
      const res = await timeoutFetch(tagsUrl, { method: "GET", headers }, MODEL_DISCOVERY_TIMEOUT_MS);
      if (res.ok) {
        endpointReachable = true;
        const data = await res.json().catch(() => null) as { models?: { name: string; size?: number; modified_at?: string; details?: { family?: string; parameter_size?: string; quantization_level?: string } }[] } | null;
        if (data?.models && Array.isArray(data.models)) {
          const detailed: DiscoveredOllamaModelDetailed[] = data.models.map((m) => ({
            id: m.name,
            modelId: m.name,
            size: m.size,
            modified: m.modified_at,
            family: m.details?.family,
            parameterSize: m.details?.parameter_size,
            quantization: m.details?.quantization_level,
          }));
          // Merge with modelIds: prefer detailed list if available
          if (detailed.length > 0) {
            return { models: detailed, endpointReachable: true };
          }
        }
      }
    } catch {
      // ignore, use modelIds
    }
  }

  if (modelIds.length > 0) {
    return { models: modelIds.map((id) => ({ id, modelId: id })), endpointReachable };
  }
  return { models: [], endpointReachable };
}

/** OpenAI-compatible streaming directly from browser to local endpoint.
 * Works from both http://localhost:3000 (local dev) and https://www.nexuss.in
 * (production) to http://localhost:11434. Requires Ollama CORS to allow the
 * Nexuss origin and Private Network Access. See docs/local-models.md.
 */
export async function* streamLocalChat(params: {
  endpoint: string;
  modelId: string;
  messages: LocalChatMessage[];
  apiKey?: string;
  signal?: AbortSignal;
}): AsyncGenerator<{ type: "chunk"; content: string } | { type: "done" }> {
  let endpoint = normalizeEndpoint(params.endpoint);
  // For Ollama, try connector first (production https → http localhost needs PNA handling)
  if (endpoint === "http://localhost:11434/v1" || endpoint === "http://127.0.0.1:11434/v1") {
    try {
      const connectorAvailable = await isConnectorAvailable();
      if (connectorAvailable) {
        endpoint = CONNECTOR_ENDPOINT;
      }
    } catch {}
  }
  // Try desktop IPC first (Electron main process fetches without CORS/mixed-content)
  const desktopOllama = (typeof window !== "undefined"
    ? (window as unknown as {
        nexussDesktop?: {
          ollama?: {
            chat?: (p: {
              endpoint: string;
              modelId: string;
              messages: LocalChatMessage[];
              apiKey?: string;
            }) => Promise<{ content: string }>;
          };
        };
      }).nexussDesktop?.ollama
    : undefined) as
    | { chat?: (p: { endpoint: string; modelId: string; messages: LocalChatMessage[]; apiKey?: string }) => Promise<{ content: string }> }
    | undefined;
  if (isDesktop() && desktopOllama?.chat) {
    try {
      const result = await desktopOllama.chat({
        endpoint,
        modelId: params.modelId,
        messages: params.messages,
        apiKey: params.apiKey,
      });
      if (result?.content) {
        // Simulate streaming by yielding in ~20 char chunks to keep incremental UX
        const content = result.content;
        for (let i = 0; i < content.length; i += 20) {
          if (params.signal?.aborted) throw new Error("Request aborted.");
          yield { type: "chunk", content: content.slice(i, i + 20) };
        }
      }
      yield { type: "done" };
      return;
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
  const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (params.apiKey?.trim()) headers["Authorization"] = `Bearer ${params.apiKey.trim()}`;

  const body = JSON.stringify({
    model: params.modelId,
    messages: params.messages,
    stream: true,
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: params.signal,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if ((e as Error).name === "AbortError") throw new Error("Request aborted.");
    if (msg.toLowerCase().includes("failed to fetch") || msg.toLowerCase().includes("cors")) {
      throw new Error("Cannot connect to local model. Check that the server is running and CORS is configured (e.g., OLLAMA_ORIGINS=*).");
    }
    throw new Error(`Cannot connect to local model: ${msg}`);
  }

  if (!res.ok) {
    let detail = `Local model error (${res.status})`;
    try {
      const j = await res.json();
      if (j?.error?.message) detail = j.error.message;
      else if (typeof j?.detail === "string") detail = j.detail;
    } catch {}
    if (res.status === 401) throw new Error("Local model authentication failed (401). Check API key.");
    if (res.status === 404) throw new Error("Model not found (404). Check model ID and that the model is pulled.");
    throw new Error(detail);
  }
  if (!res.body) throw new Error("Streaming not supported by browser.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          yield { type: "done" };
          return;
        }
        try {
          const obj = JSON.parse(data);
          const delta = obj?.choices?.[0]?.delta?.content ?? obj?.choices?.[0]?.text ?? "";
          if (typeof delta === "string" && delta) yield { type: "chunk", content: delta };
          if (obj?.choices?.[0]?.finish_reason) {
            // stream ended
          }
        } catch {
          // ignore malformed
        }
      }
    }
    // flush remaining buffer
    if (buffer.trim().startsWith("data:")) {
      const data = buffer.trim().slice(5).trim();
      if (data && data !== "[DONE]") {
        try {
          const obj = JSON.parse(data);
          const delta = obj?.choices?.[0]?.delta?.content ?? "";
          if (delta) yield { type: "chunk", content: delta };
        } catch {}
      }
    }
    yield { type: "done" };
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}
