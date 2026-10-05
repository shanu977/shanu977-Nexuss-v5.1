
"use client";

import {
  normalizeEndpoint,
  validateEndpoint,
  isDesktop,
} from "@/types/localModels";

import {
  isLocalConnectorAvailable as sharedIsConnectorAvailable,
} from "@/workspace/localTerminalRuntime";

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

function timeoutFetch(
  url: string,
  opts: RequestInit,
  ms: number
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);

  const finalSignal: AbortSignal = controller.signal;

  if (opts.signal) {
    const orig = opts.signal as AbortSignal;

    if (orig.aborted) {
      controller.abort();
    } else {
      orig.addEventListener(
        "abort",
        () => controller.abort(),
        { once: true }
      );
    }
  }

  return fetch(url, {
    ...opts,
    signal: finalSignal,
  }).finally(() => clearTimeout(id));
}

const CONNECTOR_ENDPOINT = "http://127.0.0.1:11435/v1";

// Local cache mirrors shared connector cache – avoids duplicate health probes per message
let cachedAvailable: boolean | null = null;
let lastCheck = 0;
const CACHE_TTL_MS = 5000;

async function isConnectorAvailable(): Promise<boolean> {
  try {
    const avail = await sharedIsConnectorAvailable();

    // Mirror shared result into local vars for sync fast-path in streamLocalChat
    cachedAvailable = avail;
    lastCheck = Date.now();

    return avail;
  } catch {
    cachedAvailable = false;
    lastCheck = Date.now();

    return false;
  }
}

// ---------------------------------------------------------------------------
// Desktop (Electron) bridge surface.
//
// The preload bridge exposes `window.nexussDesktop.ollama` whose methods all
// take a single object payload (see desktop/ipc-bridge.ts). Declaring the exact
// shapes here keeps renderer and preload contracts in sync instead of silently
// sending positional arguments into an object-parameter handler.
// ---------------------------------------------------------------------------

interface DesktopOllamaApi {
  test?: (req: { endpoint: string; apiKey?: string }) => Promise<LocalTestResult>;
}

function getDesktopOllama(): DesktopOllamaApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { nexussDesktop?: { ollama?: DesktopOllamaApi } })
    .nexussDesktop?.ollama;
}

/** The desktop bridge only ever talks to loopback; everything else uses fetch. */
function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
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
    return {
      ok: false,
      message: err,
      endpointReachable: false,
      modelsDiscoverable: false,
    };
  }

  let endpoint = normalizeEndpoint(
    rawEndpoint,
    providerType as never
  );

  // Try the desktop IPC bridge first — the Electron main process fetches
  // loopback endpoints without CORS/PNA restrictions, so this works even when
  // the browser cannot reach Ollama directly. Non-loopback endpoints are not
  // handled by the bridge and fall through to the normal fetch path.
  const desktopOllama = getDesktopOllama();

  if (isDesktop() && desktopOllama?.test && isLoopbackEndpoint(endpoint)) {
    try {
      return await desktopOllama.test({ endpoint, apiKey });
    } catch {
      // Fall through to the connector / direct fetch path
    }
  }

  // For Ollama on localhost:11434, try the Nexuss Local Connector first.
  if (
    providerType === "ollama" &&
    (
      endpoint === "http://localhost:11434/v1" ||
      endpoint === "http://127.0.0.1:11434/v1"
    )
  ) {
    try {
      const connectorAvailable = await isConnectorAvailable();

      if (connectorAvailable) {
        endpoint = CONNECTOR_ENDPOINT;
      }
    } catch {}
  }

  // 1. Try /models discovery
  const modelsUrl = `${endpoint.replace(/\/$/, "")}/models`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey?.trim()) {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`;
  }

  try {
    const res = await timeoutFetch(
      modelsUrl,
      {
        method: "GET",
        headers,
      },
      MODEL_DISCOVERY_TIMEOUT_MS
    );

    if (res.ok) {
      const data = await res.json().catch(() => null);

      const models: string[] = [];

      if (data) {
        // OpenAI format:
        // { data: [{id: "llama3.2:3b"}, ...] }
        // or { models: [...] } or array
        const rawList = Array.isArray(data)
          ? data
          : data.data || data.models || [];

        for (const m of rawList) {
          if (typeof m === "string") {
            models.push(m);
          } else if (
            m &&
            typeof m.id === "string"
          ) {
            models.push(m.id);
          } else if (
            m &&
            typeof m.name === "string"
          ) {
            models.push(m.name);
          }
        }
      }

      if (models.length > 0) {
        return {
          ok: true,
          message: `Connected. Found ${models.length} model${
            models.length === 1 ? "" : "s"
          }.`,
          models,
          endpointReachable: true,
          modelsDiscoverable: true,
        };
      }

      return {
        ok: true,
        message:
          "Endpoint reachable. Model discovery returned no models — you can enter the model ID manually.",
        models: [],
        endpointReachable: true,
        modelsDiscoverable: false,
      };
    }

    // Non-2xx: check if endpoint reachable but /models unsupported
    if (res.status === 404 || res.status === 405) {
      return {
        ok: true,
        message:
          "Endpoint reachable. Model discovery unavailable (404) — you can manually enter the model ID.",
        endpointReachable: true,
        modelsDiscoverable: false,
      };
    }

    if (res.status === 401) {
      return {
        ok: false,
        message:
          "Endpoint requires authentication (401). Check API key.",
        endpointReachable: true,
        modelsDiscoverable: false,
      };
    }

    return {
      ok: false,
      message: `Endpoint responded with ${res.status}. Check endpoint URL.`,
      endpointReachable: true,
      modelsDiscoverable: false,
    };
  } catch (e: unknown) {
    const msg =
      e instanceof Error ? e.message : String(e);

    const isAbort =
      msg.toLowerCase().includes("abort") ||
      (e as Error).name === "AbortError";

    if (isAbort) {
      return {
        ok: false,
        message:
          "Cannot connect to endpoint (timeout). Is the server running? Check port and that CORS allows this origin.",
        endpointReachable: false,
        modelsDiscoverable: false,
      };
    }

    // NetworkError often means CORS
    const lower = msg.toLowerCase();

    if (
      lower.includes("failed to fetch") ||
      lower.includes("networkerror") ||
      lower.includes("cors")
    ) {
      return {
        ok: false,
        message:
          "Cannot connect to endpoint. Check that the server is running and allows CORS. For Ollama, set OLLAMA_ORIGINS=* or allow this origin.",
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

export async function discoverLocalModels(
  endpoint: string,
  apiKey?: string
): Promise<string[]> {
  const result = await testLocalEndpoint(
    endpoint,
    "generic",
    apiKey
  );

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
): Promise<{
  models: DiscoveredOllamaModelDetailed[];
  endpointReachable: boolean;
}> {
  let endpoint = normalizeEndpoint(
    rawEndpoint,
    providerType as never
  );

  // For Ollama on localhost:11434, try the Nexuss Local Connector first.
  if (
    providerType === "ollama" &&
    (
      endpoint === "http://localhost:11434/v1" ||
      endpoint === "http://127.0.0.1:11434/v1"
    )
  ) {
    try {
      const connectorAvailable =
        await isConnectorAvailable();

      if (connectorAvailable) {
        endpoint = CONNECTOR_ENDPOINT;
      }
    } catch {}
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey?.trim()) {
    headers["Authorization"] =
      `Bearer ${apiKey.trim()}`;
  }

  // Try dedicated desktop IPC model discovery first.
  // Electron talks directly to Ollama, avoiding browser CORS/PNA restrictions.
  const desktopOllama = (
    typeof window !== "undefined"
      ? (
          window as unknown as {
            nexussDesktop?: {
              ollama?: {
                discoverModels?: () => Promise<
                  {
                    name: string;
                    size?: number;
                    modifiedAt?: string;
                    family?: string;
                    parameterSize?: string;
                    quantization?: string;
                  }[]
                >;
              };
            };
          }
        ).nexussDesktop?.ollama
      : undefined
  ) as
    | {
        discoverModels?: () => Promise<
          {
            name: string;
            size?: number;
            modifiedAt?: string;
            family?: string;
            parameterSize?: string;
            quantization?: string;
          }[]
        >;

        pullModel?: (model: string) => Promise<{
          name: string;
          size?: number;
          modifiedAt?: string;
          family?: string;
          parameterSize?: string;
          quantization?: string;
        }>;

        onPullProgress?: (
          callback: (progress: {
            model: string;
            status: string;
            completed?: number;
            total?: number;
            percent?: number;
          }) => void
        ) => () => void;
      }
    | undefined;

  if (
    isDesktop() &&
    desktopOllama?.discoverModels
  ) {
    try {
      const res =
        await desktopOllama.discoverModels();

      if (res.length > 0) {
        return {
          models: res.map((model) => ({
            id: model.name,
            modelId: model.name,
            size: model.size,
            modified: model.modifiedAt,
            family: model.family,
            parameterSize:
              model.parameterSize,
            quantization:
              model.quantization,
          })),
          endpointReachable: true,
        };
      }

      // Ollama is reachable but no models are installed.
      return {
        models: [],
        endpointReachable: true,
      };
    } catch {
      // Fall through to browser/connector discovery.
    }
  }

  // Browser-direct: try /v1/models for IDs,
  // then /api/tags for metadata.
  const modelIds: string[] = [];
  let endpointReachable = false;

  try {
    const modelsUrl =
      `${endpoint.replace(/\/$/, "")}/models`;

    const res = await timeoutFetch(
      modelsUrl,
      {
        method: "GET",
        headers,
      },
      MODEL_DISCOVERY_TIMEOUT_MS
    );

    if (res.ok) {
      endpointReachable = true;

      const data = await res
        .json()
        .catch(() => null) as
        | {
            data?: {
              id: string;
              created?: number;
            }[];
            models?: unknown[];
          }
        | null;

      const rawList = data
        ? Array.isArray(data)
          ? data
          : data.data ||
            (
              data as {
                models?: unknown[];
              }
            ).models ||
            []
        : [];

      for (const m of rawList as unknown[]) {
        if (typeof m === "string") {
          modelIds.push(m);
        } else if (
          m &&
          typeof (
            m as { id?: string }
          ).id === "string"
        ) {
          modelIds.push(
            (m as { id: string }).id
          );
        } else if (
          m &&
          typeof (
            m as { name?: string }
          ).name === "string"
        ) {
          modelIds.push(
            (m as { name: string }).name
          );
        }
      }
    } else if (
      res.status === 404 ||
      res.status === 405
    ) {
      endpointReachable = true;
    } else {
      endpointReachable = res.ok;
    }
  } catch {
    // Not reachable
  }

  // Try to enrich with /api/tags for Ollama.
  if (providerType === "ollama") {
    try {
      const base = endpoint.replace(
        /\/v1\/?$/,
        ""
      );

      const tagsUrl =
        `${base.replace(/\/$/, "")}/api/tags`;

      const res = await timeoutFetch(
        tagsUrl,
        {
          method: "GET",
          headers,
        },
        MODEL_DISCOVERY_TIMEOUT_MS
      );

      if (res.ok) {
        endpointReachable = true;

        const data = await res
          .json()
          .catch(() => null) as
          | {
              models?: {
                name: string;
                size?: number;
                modified_at?: string;
                details?: {
                  family?: string;
                  parameter_size?: string;
                  quantization_level?: string;
                };
              }[];
            }
          | null;

        if (
          data?.models &&
          Array.isArray(data.models)
        ) {
          const detailed:
            DiscoveredOllamaModelDetailed[] =
            data.models.map((m) => ({
              id: m.name,
              modelId: m.name,
              size: m.size,
              modified: m.modified_at,
              family: m.details?.family,
              parameterSize:
                m.details?.parameter_size,
              quantization:
                m.details?.quantization_level,
            }));

          // Prefer detailed list if available.
          if (detailed.length > 0) {
            return {
              models: detailed,
              endpointReachable: true,
            };
          }
        }
      }
    } catch {
      // Ignore and use modelIds.
    }
  }

  if (modelIds.length > 0) {
    return {
      models: modelIds.map((id) => ({
        id,
        modelId: id,
      })),
      endpointReachable,
    };
  }

  return {
    models: [],
    endpointReachable,
  };
}

export interface OllamaPullProgress {
  model: string;
  status: string;
  completed?: number;
  total?: number;
  percent?: number;
}

export async function pullOllamaModel(
  model: string,
  onProgress?: (
    progress: OllamaPullProgress
  ) => void
): Promise<DiscoveredOllamaModelDetailed> {
  const desktopOllama = (
    typeof window !== "undefined"
      ? (
          window as unknown as {
            nexussDesktop?: {
              ollama?: {
                pullModel?: (
                  model: string
                ) => Promise<{
                  name: string;
                  size?: number;
                  modifiedAt?: string;
                  family?: string;
                  parameterSize?: string;
                  quantization?: string;
                }>;

                onPullProgress?: (
                  callback: (
                    progress: OllamaPullProgress
                  ) => void
                ) => () => void;
              };
            };
          }
        ).nexussDesktop?.ollama
      : undefined
  );

  if (
    !isDesktop() ||
    !desktopOllama?.pullModel
  ) {
    throw new Error(
      "Local model download is only available in the Nexuss desktop app."
    );
  }

  const removeListener =
    desktopOllama.onPullProgress?.(
      (progress) => {
        onProgress?.(progress);
      }
    );

  try {
    const result =
      await desktopOllama.pullModel(model);

    return {
      id: result.name,
      modelId: result.name,
      size: result.size,
      modified: result.modifiedAt,
      family: result.family,
      parameterSize:
        result.parameterSize,
      quantization:
        result.quantization,
    };
  } finally {
    removeListener?.();
  }
}

/**
 * OpenAI-compatible streaming directly from browser to local endpoint.
 *
 * Works from both local development and production
 * when Ollama CORS / Private Network Access is configured.
 */
export async function* streamLocalChat(
  params: {
    endpoint: string;
    modelId: string;
    messages: LocalChatMessage[];
    apiKey?: string;
    signal?: AbortSignal;
    numPredict?: number;
    keepAlive?: string;
  }
): AsyncGenerator<
  { type: "chunk"; content: string } |
  { type: "done" }
> {
  let endpoint = normalizeEndpoint(
    params.endpoint
  );

  // For Ollama on localhost, prefer connector if available.
  // Don't block on health check.

  if (
    endpoint === "http://localhost:11434/v1" ||
    endpoint === "http://127.0.0.1:11434/v1"
  ) {
    const now = Date.now();

    const isCachedAvailable =
      cachedAvailable === true &&
      now - lastCheck < CACHE_TTL_MS;

    if (isCachedAvailable) {
      endpoint = CONNECTOR_ENDPOINT;
    } else if (cachedAvailable === null) {
      // First time: try connector in background.
      isConnectorAvailable()
        .then((avail) => {
          if (avail) {
            // Next chat will use connector.
          }
        })
        .catch(() => {});
    } else if (
      cachedAvailable === false &&
      now - lastCheck < CACHE_TTL_MS
    ) {
      // Recently checked and not available, use direct endpoint.
    }
  }

  // Desktop IPC is also available for local Ollama.
  // Keep browser streaming path here.

  const url =
    `${endpoint.replace(/\/$/, "")}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (params.apiKey?.trim()) {
    headers["Authorization"] =
      `Bearer ${params.apiKey.trim()}`;
  }

  const body = JSON.stringify({
    model: params.modelId,
    messages: params.messages,
    stream: true,
    keep_alive: params.keepAlive ?? "5m",

    options: {
      num_predict:
        params.numPredict ?? 1024,
      temperature: 0.7,
    },

    max_tokens:
      params.numPredict ?? 1024,
  });

  const perfStart = performance.now();

  const globalT3 =
    typeof window !== "undefined"
      ? (
          window as unknown as Record<
            string,
            number
          >
        ).__nexussT0
      : perfStart;

  if (
    process.env.NODE_ENV !== "production"
  ) {
    console.debug(
      `[Perf][T3] fetch_start model=${params.modelId} endpoint=${endpoint} t0=${perfStart.toFixed(
        1
      )} delta_T0=${(
        perfStart -
        (globalT3 as number)
      ).toFixed(1)}ms`
    );
  }

  let res: Response;
  let firstTokenFired = false;

  const markFirstToken = () => {
    if (!firstTokenFired) {
      firstTokenFired = true;

      const ttft =
        performance.now() - perfStart;

      const t0 =
        typeof window !== "undefined"
          ? (
              window as unknown as Record<
                string,
                number
              >
            ).__nexussT0
          : perfStart;

      const t0delta =
        performance.now() -
        (t0 as number);

      if (
        process.env.NODE_ENV !==
        "production"
      ) {
        console.debug(
          `[Perf][T7] first_token TTFT ${ttft.toFixed(
            1
          )}ms T0→token ${t0delta.toFixed(
            1
          )}ms model=${params.modelId}`
        );
      }
    }
  };

  const isDirect =
    endpoint !== CONNECTOR_ENDPOINT;

  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: params.signal,
    });
  } catch (e: unknown) {
    const msg =
      e instanceof Error
        ? e.message
        : String(e);

    if (
      (e as Error).name ===
      "AbortError"
    ) {
      throw new Error(
        "Request aborted."
      );
    }

    const isNetwork =
      msg
        .toLowerCase()
        .includes("failed to fetch") ||
      msg
        .toLowerCase()
        .includes("cors") ||
      msg
        .toLowerCase()
        .includes("networkerror");

    if (!isNetwork) {
      throw new Error(
        `Cannot connect to local model: ${msg}`
      );
    }

    // Network/CORS failure on a direct Ollama endpoint: retry through the
    // local connector, which proxies to Ollama without browser CORS limits.
    if (
      isDirect &&
      (
        endpoint ===
          "http://localhost:11434/v1" ||
        endpoint ===
          "http://127.0.0.1:11434/v1"
      )
    ) {
      const fallbackUrl =
        `${CONNECTOR_ENDPOINT}/chat/completions`;

      try {
        if (
          process.env.NODE_ENV !==
          "production"
        ) {
          console.debug(
            "[Perf] retry via connector after direct failed"
          );
        }

        res = await fetch(
          fallbackUrl,
          {
            method: "POST",
            headers,
            body,
            signal: params.signal,
          }
        );

        cachedAvailable = true;
        lastCheck = Date.now();
      } catch (e2: unknown) {
        if (
          (e2 as Error).name ===
          "AbortError"
        ) {
          throw new Error(
            "Request aborted."
          );
        }

        throw new Error(
          "Cannot connect to local model. Check that Ollama is running and the Nexuss connector is started."
        );
      }
    } else {
      throw new Error(
        "Cannot connect to local model. Check that the server is running and CORS is configured (e.g., OLLAMA_ORIGINS=*)."
      );
    }
  }

  if (
    process.env.NODE_ENV !==
    "production"
  ) {
    const hdrDelta =
      performance.now() - perfStart;

    const t0 =
      typeof window !== "undefined"
        ? (
            window as unknown as Record<
              string,
              number
            >
          ).__nexussT0
        : perfStart;

    console.debug(
      `[Perf][T5] headers_arrived ${hdrDelta.toFixed(
        1
      )}ms T0→headers ${(
        performance.now() -
        (t0 as number)
      ).toFixed(1)}ms status=${
        res.status
      } ok=${res.ok}`
    );
  }

  if (!res.ok) {
    let detail =
      `Local model error (${res.status})`;

    try {
      const j = await res.json();

      if (j?.error?.message) {
        detail = j.error.message;
      } else if (
        typeof j?.detail === "string"
      ) {
        detail = j.detail;
      }
    } catch {}

    if (res.status === 401) {
      throw new Error(
        "Local model authentication failed (401). Check API key."
      );
    }

    if (res.status === 404) {
      throw new Error(
        "Model not found (404). Check model ID and that the model is pulled."
      );
    }

    throw new Error(detail);
  }

  if (!res.body) {
    throw new Error(
      "Streaming not supported by browser."
    );
  }

  const reader =
    res.body.getReader();

  const decoder =
    new TextDecoder();

  let buffer = "";

  try {
    while (true) {
      const {
        done,
        value,
      } = await reader.read();

      if (done) break;

      buffer += decoder.decode(
        value,
        { stream: true }
      );

      const lines =
        buffer.split("\n");

      buffer =
        lines.pop() ?? "";

      for (const rawLine of lines) {
        const line =
          rawLine.trim();

        if (
          !line ||
          !line.startsWith("data:")
        ) {
          continue;
        }

        const data =
          line.slice(5).trim();

        if (data === "[DONE]") {
          yield {
            type: "done",
          };

          return;
        }

        try {
          const obj =
            JSON.parse(data);

          const delta =
            obj?.choices?.[0]
              ?.delta?.content ??
            obj?.choices?.[0]
              ?.text ??
            "";

          if (
            typeof delta ===
              "string" &&
            delta
          ) {
            markFirstToken();

            yield {
              type: "chunk",
              content: delta,
            };
          }

          if (
            obj?.choices?.[0]
              ?.finish_reason
          ) {
            // Stream ended.
          }
        } catch {
          // Ignore malformed chunks.
        }
      }
    }

    // Flush remaining buffer.
    if (
      buffer
        .trim()
        .startsWith("data:")
    ) {
      const data =
        buffer
          .trim()
          .slice(5)
          .trim();

      if (
        data &&
        data !== "[DONE]"
      ) {
        try {
          const obj =
            JSON.parse(data);

          const delta =
            obj?.choices?.[0]
              ?.delta?.content ??
            "";

          if (delta) {
            yield {
              type: "chunk",
              content: delta,
            };
          }
        } catch {}
      }
    }

    yield {
      type: "done",
    };
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}
