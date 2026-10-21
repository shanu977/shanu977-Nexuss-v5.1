
"use client";

import {
  normalizeEndpoint,
  validateEndpoint,
  isDesktop,
  LOCAL_PROVIDER_DEFAULT_ENDPOINTS,
} from "@/types/localModels";

import {
  isLocalConnectorAvailable as sharedIsConnectorAvailable,
} from "@/workspace/localTerminalRuntime";

import {
  startLocalConnection,
  resumeLocalConnection,
  updateLocalConnection,
  markLocalConnectionVerified,
  finishLocalConnection,
} from "@/store/localConnectionStore";

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

export function timeoutFetch(
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

// The shared connector probe gained an optional `{ force }` option (bypasses
// the short health cache). Older runtimes still export the original 0-arg
// signature, which harmlessly ignores the option. A locally typed alias keeps
// both implementations compatible without casts at the call sites.
type ConnectorProbe = (opts?: { force?: boolean }) => Promise<boolean>;
const sharedConnectorProbe: ConnectorProbe = sharedIsConnectorAvailable;

/**
 * Fresh connector availability probe for flows that must not trust a cached
 * answer (setup detection, model download). Passes `{ force: true }`; runtimes
 * that predate the option fall back to their normal 5s TTL behaviour.
 */
export function probeLocalConnectorFresh(): Promise<boolean> {
  return sharedConnectorProbe({ force: true });
}

// ---------------------------------------------------------------------------
// Automatic Ollama connection / startup / recovery (web browser).
//
// The browser cannot launch a Windows executable, so the actual startup lives
// in the local connector (`POST /v1/ollama/ensure`, origin-checked, single
// server-side spawn, fixed trusted executable path). This module drives the
// connection lifecycle:
//
//   idle → checking → starting → waiting_for_health → connected → idle
//
// and surfaces structured, user-safe failures (not installed / could not
// start / health check failed / connector unreachable) so the chat can show
// an actionable error and a retry instead of a bare HTTP status.
// ---------------------------------------------------------------------------

const CONNECTOR_BASE_URL = "http://127.0.0.1:11435";
const CONNECTOR_STATUS_URL = `${CONNECTOR_BASE_URL}/v1/ollama/status`;
const CONNECTOR_ENSURE_URL = `${CONNECTOR_BASE_URL}/v1/ollama/ensure`;
const DIRECT_OLLAMA_HEALTH_URL = "http://127.0.0.1:11434/api/version";

const CONNECTOR_STATUS_TIMEOUT_MS = 4000;
const CONNECTOR_ENSURE_TIMEOUT_MS = 30000;
const DIRECT_HEALTH_TIMEOUT_MS = 1500;
const READY_POLL_INTERVAL_MS = 500;
/** Bounded frontend wait when the connector reports Ollama still starting. */
const READY_POLL_TIMEOUT_MS = 15000;

export type LocalConnectionFailureReason =
  | "cancelled"
  | "not_installed"
  | "not_started"
  | "startup_failed"
  | "startup_timeout"
  | "connector_unreachable"
  | "connector_outdated"
  | "unavailable"
  | "error";

/** Actionable, user-safe copy per failure state — no stack traces or internals. */
export const LOCAL_CONNECTION_MESSAGES: Record<Exclude<LocalConnectionFailureReason, "cancelled">, string> = {
  not_installed:
    "Ollama isn't installed on this computer. Install it from ollama.com, then send your message again.",
  not_started:
    "Ollama is installed but didn't start. Open the Ollama app once, then send your message again.",
  startup_failed:
    "Ollama couldn't be started automatically. Open the Ollama app once, then send your message again.",
  startup_timeout:
    "Ollama is taking longer than expected to start. Wait a few seconds, then send your message again.",
  connector_unreachable:
    "Nexuss couldn't reach your local connector, so Ollama couldn't be started automatically. Start Ollama on your computer (or re-run the Nexuss one-time setup), then send your message again.",
  connector_outdated:
    "Your local connector doesn't support automatic Ollama startup yet. Re-run the Nexuss one-time setup to update it, then send your message again.",
  unavailable:
    "Couldn't reach your local AI model. Check that Ollama is running, then send your message again.",
  error:
    "Couldn't connect to your local AI model. Check that Ollama is running, then send your message again.",
};

/** Connection-state failures are safe to retry via the "Try again" action. */
export class LocalConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalConnectionError";
  }
}

export function isLocalConnectionError(e: unknown): e is LocalConnectionError {
  return (
    e instanceof LocalConnectionError ||
    (e instanceof Error && e.name === "LocalConnectionError")
  );
}

export type EnsureLocalConnectionResult =
  | { ok: true; via: "already_running" | "connector" | "desktop" | "direct" | "skipped"; alreadyRunning: boolean }
  | { ok: false; reason: LocalConnectionFailureReason; message: string };

/** Only the default local Ollama loopback endpoint gets automatic startup. */
export function isDefaultOllamaLoopbackEndpoint(endpoint: string): boolean {
  const norm = normalizeEndpoint(endpoint, "ollama");
  return (
    norm === "http://localhost:11434/v1" ||
    norm === "http://127.0.0.1:11434/v1"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonSafe(
  url: string,
  ms: number,
  signal?: AbortSignal
): Promise<unknown | null> {
  try {
    const res = await timeoutFetch(url, { method: "GET", signal }, ms);
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as unknown;
  } catch {
    return null;
  }
}

interface ConnectorOllamaStatusBody {
  installed: boolean | null;
  running: boolean;
}

/** Server-side Ollama status via the connector (fs + /api/version probe). */
async function fetchOllamaStatusViaConnector(
  signal?: AbortSignal
): Promise<ConnectorOllamaStatusBody | null> {
  const body = (await fetchJsonSafe(CONNECTOR_STATUS_URL, CONNECTOR_STATUS_TIMEOUT_MS, signal)) as {
    ollama?: { installed?: unknown; running?: unknown };
  } | null;
  const ollama = body?.ollama;
  if (!ollama || typeof ollama.running !== "boolean") return null;
  return {
    installed: typeof ollama.installed === "boolean" ? ollama.installed : null,
    running: ollama.running,
  };
}

/** Direct browser probe of Ollama's own API (dev / permissive CORS only). */
async function probeDirectOllamaHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await timeoutFetch(
      DIRECT_OLLAMA_HEALTH_URL,
      { method: "GET", signal },
      DIRECT_HEALTH_TIMEOUT_MS
    );
    return res.ok;
  } catch {
    return false;
  }
}

type ConnectorEnsureOutcome =
  | "running"
  | "starting"
  | "stopped"
  | "missing"
  | "failed"
  | "outdated"
  | "unreachable"
  | "unexpected";

/**
 * Ask the connector to start Ollama (single server-side spawn) and wait for
 * its bounded startup poll. A 404 means the user's connector predates the
 * ensure endpoint and must be updated via the one-time setup.
 */
async function postConnectorEnsure(signal?: AbortSignal): Promise<ConnectorEnsureOutcome> {
  let res: Response;
  try {
    res = await timeoutFetch(
      CONNECTOR_ENSURE_URL,
      { method: "POST", signal },
      CONNECTOR_ENSURE_TIMEOUT_MS
    );
  } catch {
    return "unreachable";
  }
  if (res.status === 404) return "outdated";
  if (!res.ok) return "unexpected";
  const body = (await res.json().catch(() => null)) as {
    ollama?: { status?: unknown; running?: unknown };
  } | null;
  const status = body?.ollama?.status;
  if (
    status === "running" ||
    status === "starting" ||
    status === "stopped" ||
    status === "missing" ||
    status === "failed"
  ) {
    return status;
  }
  if (body?.ollama?.running === true) return "running";
  return "unexpected";
}

interface DesktopEnsureBridge {
  ensureRunning?: () => Promise<{
    status?: string;
    message?: string;
    installed?: boolean;
    running?: boolean;
  }>;
}

function getDesktopEnsureBridge(): DesktopEnsureBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { nexussDesktop?: { ollama?: DesktopEnsureBridge } })
    .nexussDesktop?.ollama;
}

type SharedEnsureOutcome =
  | { ok: true; via: "already_running" | "connector" | "desktop" | "direct"; alreadyRunning: boolean }
  | { ok: false; reason: LocalConnectionFailureReason; message: string };

let ensureInFlight: Promise<SharedEnsureOutcome> | null = null;

function connectionFailure(reason: LocalConnectionFailureReason): SharedEnsureOutcome {
  return {
    ok: false,
    reason,
    message: reason === "cancelled" ? "Request cancelled." : LOCAL_CONNECTION_MESSAGES[reason],
  };
}

function markConnectorReachable(): void {
  // Keep the local connector cache in sync so the chat request that follows
  // this verification prefers the connector endpoint without an extra probe.
  cachedAvailable = true;
  lastCheck = Date.now();
}

/**
 * The single-flight startup/recovery operation. Concurrent callers share one
 * execution (one status check / one spawn / one poll loop), so parallel
 * messages during startup can never start multiple Ollama processes.
 * Never rejects — every failure is a structured outcome.
 */
async function runSharedOllamaEnsure(): Promise<SharedEnsureOutcome> {
  try {
    // Desktop (Electron) knows install state precisely and has its own
    // verified launcher — reuse it; the web connector path is the fallback.
    if (isDesktop()) {
      const ensure = getDesktopEnsureBridge()?.ensureRunning;
      if (ensure) {
        try {
          const state = await ensure();
          if (state.status === "running" || state.running === true) {
            return { ok: true, via: "desktop", alreadyRunning: true };
          }
          if (state.status === "not_installed" || state.installed === false) {
            return connectionFailure("not_installed");
          }
          if (state.status === "error") {
            return connectionFailure("startup_failed");
          }
          // checking/starting: fall through to the connector/direct path.
        } catch {
          // Bridge failed — continue with connector/direct probing.
        }
      }
    }

    // 1. Server-side status (fast path: Ollama already healthy).
    const status = await fetchOllamaStatusViaConnector();
    if (status) {
      if (status.running) {
        markConnectorReachable();
        return { ok: true, via: "already_running", alreadyRunning: true };
      }
      if (status.installed === false) {
        return connectionFailure("not_installed");
      }

      // 2. Installed but stopped: ask the connector to start it and wait for
      //    its bounded startup poll (single-flight server-side as well).
      updateLocalConnection("starting");
      const outcome = await postConnectorEnsure();
      switch (outcome) {
        case "running":
          markConnectorReachable();
          return { ok: true, via: "connector", alreadyRunning: false };
        case "missing":
          return connectionFailure("not_installed");
        case "stopped":
          return connectionFailure("not_started");
        case "failed":
          return connectionFailure("startup_failed");
        case "outdated":
          return connectionFailure("connector_outdated");
        case "unreachable":
          return connectionFailure("connector_unreachable");
        case "starting": {
          // The process is alive but its API is not up yet within the
          // connector's window: keep waiting with real health polls for a
          // bounded frontend budget instead of claiming success.
          updateLocalConnection("waiting_for_health");
          const deadline = Date.now() + READY_POLL_TIMEOUT_MS;
          while (Date.now() < deadline) {
            await sleep(READY_POLL_INTERVAL_MS);
            const s = await fetchOllamaStatusViaConnector();
            if (s?.running) {
              markConnectorReachable();
              return { ok: true, via: "connector", alreadyRunning: false };
            }
          }
          return connectionFailure("startup_timeout");
        }
        default:
          return connectionFailure("error");
      }
    }

    // 3. Connector absent: Ollama may still be directly reachable (local dev
    //    or permissive CORS). Otherwise we cannot verify or start anything.
    if (await probeDirectOllamaHealth()) {
      return { ok: true, via: "direct", alreadyRunning: true };
    }
    return connectionFailure("connector_unreachable");
  } catch {
    return connectionFailure("error");
  }
}

async function raceWithAbort<T>(
  p: Promise<T>,
  signal?: AbortSignal
): Promise<{ aborted: boolean; value?: T }> {
  if (signal?.aborted) return { aborted: true };
  return new Promise((resolve) => {
    const onAbort = () => resolve({ aborted: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (value) => {
        signal?.removeEventListener("abort", onAbort);
        resolve({ aborted: false, value });
      },
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve({ aborted: true });
      }
    );
  });
}

/**
 * Ensure the local Ollama service is running and healthy before a chat
 * request. Shows the connection lifecycle in the store (temporary card),
 * shares one in-flight attempt across concurrent callers, and returns a
 * structured, user-safe result. Cancellation resolves as `cancelled`
 * without tearing down the shared attempt other callers may still need.
 */
export async function ensureLocalModelConnection(
  opts: {
    endpoint?: string;
    providerType?: string;
    signal?: AbortSignal;
  } = {}
): Promise<EnsureLocalConnectionResult> {
  const providerType = opts.providerType ?? "ollama";
  const endpoint = opts.endpoint ?? LOCAL_PROVIDER_DEFAULT_ENDPOINTS.ollama;

  // Automatic startup only applies to the default local Ollama endpoint.
  // Other local providers (LM Studio, vLLM, custom hosts) keep the normal path.
  if (providerType !== "ollama" || !isDefaultOllamaLoopbackEndpoint(endpoint)) {
    return { ok: true, via: "skipped", alreadyRunning: true };
  }
  if (opts.signal?.aborted) {
    return { ok: false, reason: "cancelled", message: "Request cancelled." };
  }

  let op = ensureInFlight;
  if (op) {
    // A connection attempt is already running: join it instead of starting
    // another one (concurrent messages coordinate instead of re-spawning).
    resumeLocalConnection();
  } else {
    startLocalConnection();
    op = runSharedOllamaEnsure();
    ensureInFlight = op;
    void op.finally(() => {
      if (ensureInFlight === op) ensureInFlight = null;
    });
  }

  const raced = await raceWithAbort(op, opts.signal);
  if (raced.aborted || !raced.value) {
    finishLocalConnection();
    return { ok: false, reason: "cancelled", message: "Request cancelled." };
  }
  if (raced.value.ok) {
    markLocalConnectionVerified();
    return raced.value;
  }
  finishLocalConnection();
  return raced.value;
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
  /** Bytes/sec measured from real download events — only set when known. */
  bytesPerSecond?: number;
}

/** Thrown when the user cancels an in-flight model download. */
export class PullCancelledError extends Error {
  constructor() {
    super("Download cancelled.");
    this.name = "PullCancelledError";
  }
}

export function isPullCancelled(e: unknown): boolean {
  return (
    e instanceof PullCancelledError ||
    (e instanceof Error && (e.name === "PullCancelledError" || e.name === "AbortError"))
  );
}

/** Conservative model id check — registry names, never shell input. */
const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,127}$/;

interface ActivePull {
  model: string;
  promise: Promise<DiscoveredOllamaModelDetailed>;
  controller: AbortController;
}

let activePull: ActivePull | null = null;

/** Model id of the download currently in flight, if any. */
export function activeOllamaPullModel(): string | null {
  return activePull?.model ?? null;
}

/** Cancel the in-flight download when the underlying transport supports it. */
export function cancelOllamaPull(): void {
  activePull?.controller.abort();
}

interface DesktopPullApi {
  pullModel?: (model: string) => Promise<{
    name: string;
    size?: number;
    modifiedAt?: string;
    family?: string;
    parameterSize?: string;
    quantization?: string;
  }>;
  onPullProgress?: (
    callback: (progress: OllamaPullProgress) => void
  ) => () => void;
}

function getDesktopPullApi(): DesktopPullApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { nexussDesktop?: { ollama?: DesktopPullApi } })
    .nexussDesktop?.ollama;
}

/**
 * Download an Ollama model with real progress and cancellation support.
 * Works in the desktop app (IPC) and in the browser (Ollama's NDJSON
 * `/api/pull` stream, via the local connector when available so production
 * browsers are not blocked by CORS). Duplicate pulls of the same model
 * share one in-flight promise; a different model is rejected.
 */
export async function pullOllamaModel(
  model: string,
  onProgress?: (progress: OllamaPullProgress) => void
): Promise<DiscoveredOllamaModelDetailed> {
  const id = model.trim();
  if (!MODEL_ID_PATTERN.test(id)) {
    throw new Error("That model name isn't valid. Pick a model from the list.");
  }
  if (activePull) {
    if (activePull.model === id) return activePull.promise;
    throw new Error("Another model download is already in progress.");
  }

  const controller = new AbortController();
  const promise = runOllamaPull(id, onProgress, controller.signal);
  activePull = { model: id, promise, controller };
  try {
    return await promise;
  } finally {
    if (activePull?.promise === promise) activePull = null;
  }
}

async function runOllamaPull(
  model: string,
  onProgress?: (progress: OllamaPullProgress) => void,
  signal?: AbortSignal
): Promise<DiscoveredOllamaModelDetailed> {
  const desktop = getDesktopPullApi();
  if (isDesktop() && desktop?.pullModel) {
    // Desktop IPC has no safe cancellation: we can only refuse to start or
    // discard the result after it completes.
    if (signal?.aborted) throw new PullCancelledError();
    const remove = desktop.onPullProgress?.((progress) => {
      onProgress?.({ ...progress, model: progress.model || model });
    });
    try {
      const result = await desktop.pullModel(model);
      if (signal?.aborted) throw new PullCancelledError();
      return {
        id: result.name,
        modelId: result.name,
        size: result.size,
        modified: result.modifiedAt,
        family: result.family,
        parameterSize: result.parameterSize,
        quantization: result.quantization,
      };
    } finally {
      remove?.();
    }
  }
  return pullViaHttp(model, onProgress, signal);
}

function friendlyPullError(raw: string): string {
  if (/pull model manifest|model.*not found|does not exist|no such model/i.test(raw)) {
    return "That model wasn't found in the Ollama registry. Pick another model.";
  }
  if (/connection refused|econnrefused|fetch failed/i.test(raw)) {
    return "Couldn't reach Ollama. Make sure it's running and try again.";
  }
  if (/not found/i.test(raw)) {
    return "That model wasn't found in the Ollama registry. Pick another model.";
  }
  return raw.length > 160 ? "The download failed. Please try again." : raw;
}

async function readPullError(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      return typeof parsed?.error === "string" ? parsed.error : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function pullViaHttp(
  model: string,
  onProgress?: (progress: OllamaPullProgress) => void,
  signal?: AbortSignal
): Promise<DiscoveredOllamaModelDetailed> {
  const connectorUp = await probeLocalConnectorFresh();
  const urls = connectorUp
    ? ["http://127.0.0.1:11435/api/pull", "http://localhost:11434/api/pull"]
    : ["http://localhost:11434/api/pull"];

  let lastError: unknown = null;
  for (const url of urls) {
    if (signal?.aborted) throw new PullCancelledError();

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: true }),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw new PullCancelledError();
      lastError = e;
      continue;
    }

    if (!res.ok) {
      const detail = await readPullError(res);
      if (res.status === 404) {
        throw new Error("That model wasn't found in the Ollama registry. Pick another model.");
      }
      lastError = new Error(
        detail ? friendlyPullError(detail) : `Ollama returned ${res.status} for the download request.`
      );
      continue;
    }

    try {
      await consumePullStream(res, model, onProgress, signal);
    } catch (e) {
      if (signal?.aborted) throw new PullCancelledError();
      throw e;
    }
    return { id: model, modelId: model };
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error("Couldn't reach Ollama to download the model. Make sure Ollama is running and try again.");
}

async function consumePullStream(
  res: Response,
  model: string,
  onProgress?: (progress: OllamaPullProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!res.body) throw new Error("Ollama returned an empty download stream.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let speedRef: { t: number; bytes: number } | null = null;
  let sawSuccess = false;

  try {
    while (true) {
      if (signal?.aborted) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancel failures.
        }
        throw new PullCancelledError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let event: {
          status?: unknown;
          total?: unknown;
          completed?: unknown;
          error?: unknown;
        };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof event.error === "string" && event.error) {
          throw new Error(friendlyPullError(event.error));
        }

        const status = typeof event.status === "string" ? event.status : "";
        const total = typeof event.total === "number" ? event.total : undefined;
        const completed = typeof event.completed === "number" ? event.completed : undefined;

        let bytesPerSecond: number | undefined;
        if (completed != null) {
          const now = Date.now();
          if (!speedRef) {
            speedRef = { t: now, bytes: completed };
          } else if (now > speedRef.t) {
            const delta = completed - speedRef.bytes;
            if (delta >= 0) {
              bytesPerSecond = Math.round(delta / ((now - speedRef.t) / 1000));
            }
            speedRef = { t: now, bytes: completed };
          }
        }

        const percent =
          total != null && total > 0 && completed != null
            ? Math.min(100, (completed / total) * 100)
            : undefined;

        onProgress?.({ model, status, completed, total, percent, bytesPerSecond });
        if (status === "success") sawSuccess = true;
      }
    }

    if (signal?.aborted) throw new PullCancelledError();
    if (!sawSuccess) {
      throw new Error("The download ended before it finished. Please try again.");
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Lock may already be released after cancel().
    }
  }
}

/**
 * Extract a user-safe error message from a local/connector error body.
 * Handles string-valued `error` (the connector's `{"error":"Cannot connect
 * to Ollama at ..."}` 502), object-valued `error.message`, `detail`, other
 * message fields, and empty/malformed/unexpected bodies (→ null).
 */
export function extractLocalErrorDetail(raw: string): string | null {
  const text = (raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as { error?: unknown; detail?: unknown; message?: unknown };
    if (typeof p.error === "string" && p.error.trim()) {
      return p.error.trim();
    }
    if (p.error && typeof p.error === "object") {
      const msg = (p.error as { message?: unknown }).message;
      if (typeof msg === "string" && msg.trim()) return msg.trim();
    }
    if (typeof p.detail === "string" && p.detail.trim()) {
      return p.detail.trim();
    }
    if (typeof p.message === "string" && p.message.trim()) {
      return p.message.trim();
    }
    return null;
  } catch {
    // Not JSON (proxy error page or truncated body) — nothing safe to extract.
    return null;
  }
}

/** True when an error detail describes a lost local connection (not a model error). */
export function isConnectionishDetail(detail: string): boolean {
  return /cannot connect|connection refused|econnrefused|failed to fetch|fetch failed|is ollama running|bad gateway|socket hang up/i.test(
    detail
  );
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

  // One request attempt: POST to the current endpoint, falling back through
  // the connector when a direct Ollama request fails with a network/CORS
  // error. Extracted so the connection-recovery retry below reuses the exact
  // same request (same body, headers and options) without duplicating logic.
  // The URL is built per attempt because the 502 recovery may switch
  // `endpoint` from direct Ollama to the local connector before the retry.
  const requestCompletion = async (): Promise<Response> => {
    const isDirect = endpoint !== CONNECTOR_ENDPOINT;
    const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;

    try {
      return await fetch(url, {
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

          const fallbackRes = await fetch(
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
          return fallbackRes;
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
  };

  res = await requestCompletion();

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

  // Read the error body and extract a user-safe detail. Supports every shape
  // the connector and OpenAI-compatible servers emit: string-valued `error`
  // (the connector's 502 body), object-valued `error.message`, `detail`,
  // empty, malformed and unexpected bodies.
  const readErrorDetail = async (r: Response): Promise<string | null> => {
    const raw = await r.text().catch(() => "");
    return extractLocalErrorDetail(raw);
  };

  // Connection-level failure: the connector could not reach Ollama (HTTP 502).
  // Verify health, restart Ollama if needed, and retry the exact request at
  // most once. Model errors (404), auth (401) and unrelated HTTP failures are
  // never retried. The first response's body is deliberately not consumed
  // here: only the status code drives the recovery decision, and the retry
  // produces its own response (or its own error).
  if (
    res.status === 502 &&
    isDefaultOllamaLoopbackEndpoint(params.endpoint) &&
    !params.signal?.aborted
  ) {
    const recovery = await ensureLocalModelConnection({
      endpoint: params.endpoint,
      signal: params.signal,
    });

    if (!recovery.ok) {
      if (recovery.reason === "cancelled") {
        throw new Error("Request aborted.");
      }
      throw new LocalConnectionError(recovery.message);
    }

    // Health was just verified through the connector: prefer its endpoint so
    // the retry does not repeat a CORS-blocked direct round-trip.
    if (
      recovery.via === "connector" ||
      recovery.via === "already_running"
    ) {
      endpoint = CONNECTOR_ENDPOINT;
    }

    res = await requestCompletion();

    if (res.status === 502) {
      const retryDetail = await readErrorDetail(res);
      throw new LocalConnectionError(
        !retryDetail || isConnectionishDetail(retryDetail)
          ? LOCAL_CONNECTION_MESSAGES.unavailable
          : retryDetail
      );
    }
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);

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

    if (res.status === 502) {
      // A gateway/connection failure we could not (or did not) recover from.
      // Never surface a bare status: connection-shaped bodies map to the
      // actionable recovery copy instead of raw connector internals.
      throw new LocalConnectionError(
        !detail || isConnectionishDetail(detail)
          ? LOCAL_CONNECTION_MESSAGES.unavailable
          : detail
      );
    }

    throw new Error(detail || `Local model error (${res.status})`);
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
