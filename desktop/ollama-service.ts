// Ollama desktop bridge: main-process fetch for http://localhost:11434
// Bypasses browser CORS/mixed-content and ensures only localhost is ever fetched.
// Self-contained normalize (copied from src/types/localModels to avoid src import in main process).

function normalizeEndpoint(input: string, providerType: string = "generic"): string {
  let raw = input.trim();
  if (!raw) return raw;
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    const url = new URL(raw);
    let pathname = url.pathname.replace(/\/+$/, "");
    if (providerType === "ollama" && (pathname === "" || pathname === "/")) {
      pathname = "/v1";
    } else if (pathname === "") {
      pathname = "/v1";
    } else if (pathname === "/v1") {
      // already correct
    } else if (!pathname.endsWith("/v1")) {
      if (pathname.includes("/v1")) {
        pathname = pathname.slice(0, pathname.indexOf("/v1") + 3);
      }
    }
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function isAllowedOllamaEndpoint(input: string): boolean {
  try {
    const normalized = normalizeEndpoint(input);
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    // Only allow loopback for Ollama desktop bridge
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return false;
    if (host === "169.254.169.254" || host === "metadata.google.internal" || host.endsWith(".internal")) return false;
    if (!["http:", "https:"].includes(url.protocol)) return false;
    return true;
  } catch {
    return false;
  }
}

export interface OllamaTestRequest {
  endpoint: string;
  apiKey?: string;
}

export interface OllamaChatRequest {
  endpoint: string;
  modelId: string;
  messages: { role: string; content: string }[];
  apiKey?: string;
}

export async function handleOllamaTest(req: OllamaTestRequest): Promise<{ ok: boolean; message: string; models?: string[]; endpointReachable: boolean; modelsDiscoverable: boolean }> {
  if (!isAllowedOllamaEndpoint(req.endpoint)) {
    return { ok: false, message: "Endpoint host is not allowed. Only localhost Ollama is allowed via desktop bridge.", endpointReachable: false, modelsDiscoverable: false };
  }
  const endpoint = normalizeEndpoint(req.endpoint, "ollama");
  const url = `${endpoint.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (req.apiKey?.trim()) headers["Authorization"] = `Bearer ${req.apiKey.trim()}`;
  try {
    const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const data = await res.json().catch(() => null) as unknown;
      const models: string[] = [];
      if (data) {
        const rawList = Array.isArray(data) ? data : (data as { data?: unknown[]; models?: unknown[] }).data || (data as { models?: unknown[] }).models || [];
        for (const m of rawList as unknown[]) {
          if (typeof m === "string") models.push(m);
          else if (m && typeof (m as { id?: unknown }).id === "string") models.push((m as { id: string }).id);
          else if (m && typeof (m as { name?: unknown }).name === "string") models.push((m as { name: string }).name);
        }
      }
      if (models.length > 0) {
        return { ok: true, message: `Connected. Found ${models.length} model${models.length === 1 ? "" : "s"}.`, models, endpointReachable: true, modelsDiscoverable: true };
      }
      return { ok: true, message: "Endpoint reachable. Model discovery returned no models — you can enter the model ID manually.", models: [], endpointReachable: true, modelsDiscoverable: false };
    }
    if (res.status === 404 || res.status === 405) {
      return { ok: true, message: "Endpoint reachable. Model discovery unavailable (404) — you can manually enter the model ID.", endpointReachable: true, modelsDiscoverable: false };
    }
    if (res.status === 401) {
      return { ok: false, message: "Endpoint requires authentication (401). Check API key.", endpointReachable: true, modelsDiscoverable: false };
    }
    return { ok: false, message: `Endpoint responded with ${res.status}. Check endpoint URL.`, endpointReachable: true, modelsDiscoverable: false };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes("abort")) {
      return { ok: false, message: "Cannot connect to endpoint (timeout). Is Ollama running?", endpointReachable: false, modelsDiscoverable: false };
    }
    return { ok: false, message: `Cannot connect: ${msg}`, endpointReachable: false, modelsDiscoverable: false };
  }
}

export async function handleOllamaChat(req: OllamaChatRequest): Promise<{ content: string }> {
  if (!isAllowedOllamaEndpoint(req.endpoint)) {
    throw new Error("Endpoint host is not allowed. Only localhost Ollama via desktop bridge.");
  }
  const endpoint = normalizeEndpoint(req.endpoint, "ollama");
  const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (req.apiKey?.trim()) headers["Authorization"] = `Bearer ${req.apiKey.trim()}`;
  const body = JSON.stringify({ model: req.modelId, messages: req.messages, stream: false });
  const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    let detail = `Local model error (${res.status})`;
    try {
      const j = await res.json() as { error?: { message?: string }; detail?: string };
      if (j?.error?.message) detail = j.error.message;
      else if (typeof j?.detail === "string") detail = j.detail;
    } catch {}
    if (res.status === 401) throw new Error("Local model authentication failed (401). Check API key.");
    if (res.status === 404) throw new Error("Model not found (404). Check model ID and that the model is pulled.");
    throw new Error(detail);
  }
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const content = data?.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("Empty response from local model.");
  return { content };
}
