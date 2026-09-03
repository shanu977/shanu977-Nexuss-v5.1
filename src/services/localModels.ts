"use client";

import { normalizeEndpoint, validateEndpoint } from "@/types/localModels";

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

const FETCH_TIMEOUT_MS = 8000;
const MODEL_DISCOVERY_TIMEOUT_MS = 6000;

function timeoutFetch(url: string, opts: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  const signal = opts.signal ? (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([opts.signal as AbortSignal, controller.signal]) : controller.signal;
  // Fallback for browsers without AbortSignal.any
  let finalSignal: AbortSignal = controller.signal;
  if (opts.signal) {
    // composite abort
    const orig = opts.signal as AbortSignal;
    if (orig.aborted) controller.abort();
    else orig.addEventListener("abort", () => controller.abort(), { once: true });
  } else {
    finalSignal = controller.signal;
  }
  return fetch(url, { ...opts, signal: finalSignal }).finally(() => clearTimeout(id));
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
  const endpoint = normalizeEndpoint(rawEndpoint, providerType as never);
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

/** OpenAI-compatible streaming directly from browser to local endpoint. */
export async function* streamLocalChat(params: {
  endpoint: string;
  modelId: string;
  messages: LocalChatMessage[];
  apiKey?: string;
  signal?: AbortSignal;
}): AsyncGenerator<{ type: "chunk"; content: string } | { type: "done" }> {
  const endpoint = normalizeEndpoint(params.endpoint);
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
