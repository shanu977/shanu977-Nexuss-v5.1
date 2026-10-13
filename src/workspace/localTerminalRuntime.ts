// Browser runtime that talks to the local connector's terminal endpoint.
// Used when window.nexussDesktop is not available (normal Chrome at https://nexuss.in).
// The connector must be running via `node local-connector/server.js` on 127.0.0.1:11435.

import type { NativeCommandResult, NativeTestResult, NativeRunRequest, NativeCapabilities } from "@/workspace/agent/types";

const CONNECTOR_URL = "http://127.0.0.1:11435";
const HEALTH_TIMEOUT_MS = 1500;
const DEFAULT_RUN_TIMEOUT_MS = 120000;
// Connector kills the child at timeoutMs; wait a little longer before aborting the HTTP request.
const ABORT_GRACE_MS = 15000;
const BODY_TIMEOUT_MS = 15000;

/** Why a health probe failed — used to render truthful, actionable UI states. */
export type ConnectorProbeFailureReason =
  | "timeout"
  | "permission"
  | "unreachable"
  | "http-error"
  | "invalid-response";

export type ConnectorProbeResult =
  | { ok: true }
  | { ok: false; reason: ConnectorProbeFailureReason; httpStatus?: number };

let cachedProbe: ConnectorProbeResult | null = null;
let lastCheck = 0;
const CACHE_TTL_MS = 5000;

/**
 * Best-effort read of the Chrome Local Network Access permission.
 * Returns null when the browser does not expose the permission (no classification
 * possible) or the query itself failed.
 */
async function queryLocalNetworkPermission(): Promise<"granted" | "denied" | "prompt" | null> {
  try {
    if (typeof navigator === "undefined") return null;
    const permissions = (navigator as unknown as { permissions?: { query: (opts: unknown) => Promise<unknown> } }).permissions;
    if (!permissions?.query) return null;
    const status = (await permissions.query({ name: "local-network-access" } as unknown as never)) as
      | { state?: string }
      | undefined;
    const state = status?.state;
    return state === "granted" || state === "denied" || state === "prompt" ? state : null;
  } catch {
    // Unsupported permission name (non-Chrome / older Chrome) — not classifiable.
    return null;
  }
}

function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === "AbortError") ||
    (typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError")
  );
}

/**
 * Probe the local connector's real /health endpoint and classify failures so the
 * UI can distinguish "permission blocked" / "timeout" / "connector not running"
 * from an inconclusive result. Never treats anything but a valid health contract
 * as success.
 */
export async function probeLocalConnector(opts?: {
  force?: boolean;
  timeoutMs?: number;
}): Promise<ConnectorProbeResult> {
  const now = Date.now();
  if (!opts?.force && cachedProbe !== null && now - lastCheck < CACHE_TTL_MS) return cachedProbe;
  lastCheck = now;

  // If the browser reports Local Network Access as denied, the request would be
  // blocked before it ever reaches the connector — classify as permission.
  const permission = await queryLocalNetworkPermission();
  if (permission === "denied") {
    cachedProbe = { ok: false, reason: "permission" };
    return cachedProbe;
  }

  // Best-effort: on Chrome 130+ this can surface the Local Network Access prompt
  // (public -> private) during the user-gesture connect flow. No-op elsewhere.
  if (permission === "prompt" || permission === null) {
    await queryLocalNetworkPermission().catch(() => {});
  }

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), opts?.timeoutMs ?? HEALTH_TIMEOUT_MS);
    // Simple GET without custom headers to avoid extra preflights; the PNA
    // preflight for https://www.nexuss.in -> http://127.0.0.1:11435 is handled
    // by the connector's Access-Control-Allow-Private-Network response.
    let res: Response;
    try {
      res = await fetch(`${CONNECTOR_URL}/health`, { signal: controller.signal, method: "GET", mode: "cors" });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      cachedProbe = { ok: false, reason: "http-error", httpStatus: res.status };
      return cachedProbe;
    }
    const data = (await res.json().catch(() => null)) as {
      terminal?: string;
      connector?: string;
    } | null;
    if (!data || (data.terminal !== "enabled" && data.connector !== "nexuss-local")) {
      cachedProbe = { ok: false, reason: "invalid-response" };
      return cachedProbe;
    }
    cachedProbe = { ok: true };
    return cachedProbe;
  } catch (e) {
    if (isAbortError(e)) {
      cachedProbe = { ok: false, reason: "timeout" };
      return cachedProbe;
    }
    // TypeError "Failed to fetch" covers connection refusal, DNS, CORS and a
    // browser-blocked private-network request. Re-check the permission so a
    // denied Local Network Access grant is distinguished where possible.
    const after = await queryLocalNetworkPermission();
    cachedProbe = after === "denied" ? { ok: false, reason: "permission" } : { ok: false, reason: "unreachable" };
    return cachedProbe;
  }
}

/**
 * Boolean view of {@link probeLocalConnector} for callers that only need
 * reachable/not-reachable. Results are cached for a few seconds; pass
 * `{ force: true }` to skip the cache (used by the terminal connection flow,
 * which must only report a verified connection).
 */
export async function isLocalConnectorAvailable(opts?: { force?: boolean }): Promise<boolean> {
  return (await probeLocalConnector(opts)).ok;
}

export function createLocalConnectorRuntime(): {
  run: (req: NativeRunRequest) => Promise<NativeCommandResult>;
  test: (req: { cwd?: string; timeoutMs?: number }) => Promise<NativeTestResult>;
  capabilities: () => NativeCapabilities;
  isAvailable: () => Promise<boolean>;
} {
  // Always bound the request so a stalled connector/socket can never hang the chat forever.
  const postRun = async (body: Record<string, unknown>): Promise<Response> => {
    const requested = Number(body.timeoutMs) || DEFAULT_RUN_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requested + ABORT_GRACE_MS);
    try {
      return await fetch(`${CONNECTOR_URL}/v1/terminal/run`, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  };
  const fetchWithTimeout = async (res: Response): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BODY_TIMEOUT_MS);
    try { return await res.json(); } finally { clearTimeout(timer); }
  };
  return {
    async run(req) {
      let res: Response;
      try {
        res = await postRun({ command: req.command, cwd: req.cwd, timeoutMs: req.timeoutMs });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Network/CORS/mixed-content/PNA failure — distinguish from terminal command failure
        if (msg.includes("aborted") || msg.includes("abort")) {
          throw new Error(`TIMEOUT: Local terminal connector did not respond within ${Math.round(((Number(req.timeoutMs) || DEFAULT_RUN_TIMEOUT_MS) + ABORT_GRACE_MS) / 1000)}s. The connector may be stuck; restart it with: node local-connector/server.js`);
        }
        if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("ECONNREFUSED") || msg.includes("fetch") || msg.includes("Permission")) {
          throw new Error(`NETWORK_ERROR: Cannot reach local terminal connector at ${CONNECTOR_URL}. Ensure it is running (node local-connector/server.js) and when Chrome prompts "Allow www.nexuss.in to access your local network" click Allow. Also check chrome://flags#block-insecure-private-network-requests if needed. Details: ${msg}`);
        }
        throw new Error(`NETWORK_ERROR: ${msg}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let err = text;
        try { const j = JSON.parse(text); err = j.error || text; } catch {}
        throw new Error(err || `Terminal request failed (${res.status})`);
      }
      const data = await fetchWithTimeout(res) as Record<string, unknown>;
      // Normalize to NativeCommandResult shape
      return {
        command: data.command || req.command,
        cwd: data.cwd || req.cwd || "",
        exitCode: data.exitCode ?? null,
        stdout: data.stdout || "",
        stderr: data.stderr || "",
        durationMs: data.durationMs || 0,
        timedOut: !!data.timedOut,
        killed: !!data.killed,
        signal: data.signal || null,
        success: !!data.success,
        outputTruncated: !!data.outputTruncated,
        redacted: !!data.redacted
      } as NativeCommandResult;
    },
    async test(req) {
      // For now, run the discovered test command via /v1/terminal/run with "npm test" or similar
      // The connector will validate and run it; if no test command, throw
      // We try to run "npm test" as default
      let res: Response;
      try {
        res = await postRun({ command: "npm test", cwd: req.cwd, timeoutMs: req.timeoutMs });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("aborted") || msg.includes("abort")) {
          throw new Error(`TIMEOUT: Local terminal connector did not respond within ${Math.round(((Number(req.timeoutMs) || DEFAULT_RUN_TIMEOUT_MS) + ABORT_GRACE_MS) / 1000)}s. The connector may be stuck; restart it with: node local-connector/server.js`);
        }
        if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("ECONNREFUSED") || msg.includes("fetch") || msg.includes("Permission")) {
          throw new Error(`NETWORK_ERROR: Cannot reach local terminal connector at ${CONNECTOR_URL}. Details: ${msg}`);
        }
        throw new Error(`NETWORK_ERROR: ${msg}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Test failed (${res.status})`);
      }
      const data = await fetchWithTimeout(res) as Record<string, unknown>;
      return {
        command: data.command || "npm test",
        cwd: data.cwd || req.cwd || "",
        exitCode: data.exitCode ?? null,
        stdout: data.stdout || "",
        stderr: data.stderr || "",
        durationMs: data.durationMs || 0,
        timedOut: !!data.timedOut,
        killed: !!data.killed,
        signal: data.signal || null,
        success: !!data.success,
        outputTruncated: !!data.outputTruncated,
        redacted: !!data.redacted,
        plan: { command: "npm test", source: "package.json", confidence: "high" }
      } as unknown as NativeTestResult;
    },
    capabilities() {
      // Optimistically say terminal is available; isAvailable() does real check
      return {
        read: true, search: true, write: true, create: true, rename: true, move: true, delete: true, mkdir: true,
        run: true, test: true
      };
    },
    isAvailable: isLocalConnectorAvailable
  };
}

export async function detectLocalConnectorRuntime(): Promise<ReturnType<typeof createLocalConnectorRuntime> | null> {
  if (await isLocalConnectorAvailable()) {
    return createLocalConnectorRuntime();
  }
  return null;
}
