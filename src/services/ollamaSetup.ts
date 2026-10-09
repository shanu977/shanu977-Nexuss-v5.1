// Automatic local AI setup: detect Ollama, classify its state honestly and
// verify that a model actually replies through Nexuss before we ever show a
// "Connected"/"Ready" state.
//
// Detection never guesses: every failure to reach the local stack is
// reported as `unknown` with a reason (connector unreachable, timeout,
// blocked), never as "not installed". "Not installed" is only returned from
// sources that really know (the desktop bridge, or the connector's
// server-side filesystem probe on a supported platform).

"use client";

import { LOCAL_PROVIDER_DEFAULT_ENDPOINTS, isDesktop } from "@/types/localModels";
import {
  discoverOllamaModelsDetailed,
  probeLocalConnectorFresh,
  streamLocalChat,
  timeoutFetch,
  type DiscoveredOllamaModelDetailed,
} from "./localModels";

export const CONNECTOR_BASE = "http://127.0.0.1:11435";

const CONNECTOR_STATUS_TIMEOUT_MS = 3000;
const CHAT_VERIFY_TIMEOUT_MS = 45000;
const CHAT_VERIFY_MAX_CHARS = 200;

/**
 * Setup states shown by the setup panel.
 * - `models`: Ollama running with at least one installed model.
 * - `no_models`: Ollama running, zero models installed.
 * - `stopped`: Ollama installed but not running.
 * - `not_installed`: a trustworthy source says Ollama is missing.
 * - `unknown`: we could not find out — always accompanied by `reason`.
 */
export type SetupDetectionState = "models" | "no_models" | "stopped" | "not_installed" | "unknown";

export type SetupDetectionReason = "connector_unreachable" | "timeout" | "blocked";

export type SetupDetectionVia = "connector" | "direct" | "desktop";

export interface SetupDetection {
  state: SetupDetectionState;
  models?: DiscoveredOllamaModelDetailed[];
  /** Only meaningful for `stopped`/`not_installed`. */
  installed?: boolean;
  reason?: SetupDetectionReason;
  via: SetupDetectionVia;
}

export interface ConnectorOllamaStatus {
  installed: boolean | null;
  running: boolean;
}

interface DesktopOllamaEnsure {
  ensureRunning?: () => Promise<{
    status: "checking" | "not_installed" | "starting" | "running" | "error";
    message: string;
    installed: boolean;
    running: boolean;
  }>;
}

function desktopOllamaBridge(): DesktopOllamaEnsure | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { nexussDesktop?: { ollama?: DesktopOllamaEnsure } })
    .nexussDesktop?.ollama;
}

/** Server-side Ollama status from the Nexuss local connector, if reachable. */
export async function fetchConnectorOllamaStatus(
  signal?: AbortSignal
): Promise<ConnectorOllamaStatus | null> {
  try {
    const res = await timeoutFetch(
      `${CONNECTOR_BASE}/v1/ollama/status`,
      { method: "GET", signal },
      CONNECTOR_STATUS_TIMEOUT_MS
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ollama?: { installed?: unknown; running?: unknown };
    };
    const ollama = body?.ollama;
    if (!ollama || typeof ollama.running !== "boolean") return null;
    return {
      installed: typeof ollama.installed === "boolean" ? ollama.installed : null,
      running: ollama.running,
    };
  } catch {
    return null;
  }
}

function classifyThrown(e: unknown, via: SetupDetectionVia): SetupDetection {
  const err = e as { name?: string; message?: string } | null;
  const aborted =
    err?.name === "AbortError" ||
    err?.name === "TimeoutError" ||
    /abort|timed? ?out/i.test(err?.message ?? "");
  return { state: "unknown", reason: aborted ? "timeout" : "blocked", via };
}

/**
 * Detect the local Ollama setup. Resolution order:
 * 1. Desktop bridge (Electron knows install state precisely).
 * 2. Nexuss local connector status + discovery (works in production browsers).
 * 3. Direct browser probes against the endpoint (dev / permissive CORS).
 */
export async function detectOllamaSetup(
  opts: { endpoint?: string; signal?: AbortSignal } = {}
): Promise<SetupDetection> {
  const endpoint = opts.endpoint ?? LOCAL_PROVIDER_DEFAULT_ENDPOINTS.ollama;

  if (isDesktop()) {
    const ensure = desktopOllamaBridge()?.ensureRunning;
    if (ensure) {
      try {
        const state = await ensure();
        if (state.status === "not_installed") {
          return { state: "not_installed", installed: false, via: "desktop" };
        }
        if (state.status === "error") {
          return { state: "unknown", reason: "blocked", via: "desktop" };
        }
        // running/starting/checking: fall through to model discovery.
      } catch {
        // Bridge failed — continue with connector/direct probing.
      }
    }
  }

  const connectorUp = await probeLocalConnectorFresh();

  if (connectorUp) {
    const status = await fetchConnectorOllamaStatus(opts.signal);
    if (status && !status.running) {
      return status.installed === false
        ? { state: "not_installed", installed: false, via: "connector" }
        : { state: "stopped", installed: status.installed ?? true, via: "connector" };
    }

    try {
      const disc = await discoverOllamaModelsDetailed(endpoint, "ollama", undefined);
      if (disc.endpointReachable) {
        return disc.models.length > 0
          ? { state: "models", models: disc.models, via: "connector" }
          : { state: "no_models", via: "connector" };
      }
      if (status && !status.running) {
        return { state: "stopped", installed: status.installed ?? true, via: "connector" };
      }
      return { state: "unknown", reason: "connector_unreachable", via: "connector" };
    } catch (e) {
      return classifyThrown(e, "connector");
    }
  }

  // Connector unavailable: try a direct probe (local dev or permissive CORS).
  try {
    const disc = await discoverOllamaModelsDetailed(endpoint, "ollama", undefined);
    if (disc.endpointReachable) {
      return disc.models.length > 0
        ? { state: "models", models: disc.models, via: "direct" }
        : { state: "no_models", via: "direct" };
    }
    return { state: "unknown", reason: "connector_unreachable", via: "direct" };
  } catch (e) {
    return classifyThrown(e, "direct");
  }
}

export interface ChatVerification {
  ok: boolean;
  /** Short, user-safe failure description when not ok. */
  message?: string;
}

/**
 * End-to-end setup verification: send one tiny chat request and require real
 * output. This is the only thing allowed to produce a "Ready"/connected
 * success state — reachability alone is not enough.
 */
export async function verifyLocalChat(
  endpoint: string,
  modelId: string,
  signal?: AbortSignal
): Promise<ChatVerification> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_VERIFY_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    let text = "";
    for await (const event of streamLocalChat({
      endpoint,
      modelId,
      messages: [{ role: "user", content: "Reply with the single word: OK" }],
      numPredict: 12,
      signal: controller.signal,
    })) {
      if (event.type === "chunk") {
        text += event.content;
        if (text.length > CHAT_VERIFY_MAX_CHARS) break;
      }
    }
    if (!text.trim()) {
      return { ok: false, message: "The model did not reply. Check that it is installed and try again." };
    }
    return { ok: true };
  } catch (e) {
    const err = e as { name?: string; message?: string } | null;
    if (err?.name === "AbortError") {
      return { ok: false, message: "The connection test timed out. Check that Ollama is running and try again." };
    }
    return {
      ok: false,
      message: "Couldn't talk to the model. Make sure Ollama is running and try again.",
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Short, user-safe title for an unknown/blocked detection result. */
export function unknownReasonCopy(reason?: SetupDetectionReason): string {
  switch (reason) {
    case "timeout":
      return "Checking your device timed out.";
    case "connector_unreachable":
      return "Nexuss couldn't reach Ollama on this device.";
    default:
      return "We couldn't check your device.";
  }
}

/** Map a thrown setup error to a short, user-safe message. */
export function friendlySetupError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/fetch|network|Failed to fetch|ECONNREFUSED/i.test(raw)) {
    return "Couldn't reach Ollama. Make sure it's running and try again.";
  }
  if (/abort|timed? ?out/i.test(raw)) {
    return "The request timed out. Check that Ollama is running and try again.";
  }
  if (/model/i.test(raw) && /not found|manifest/i.test(raw)) {
    return "That model isn't available in the Ollama registry. Pick another model.";
  }
  if (raw.length > 160) return "Something went wrong during setup. Please try again.";
  return raw;
}
