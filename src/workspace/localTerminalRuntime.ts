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

/**
 * HTTP 400 policy denials the connector returns deliberately. They explain a
 * blocked request to the user ("Shell metacharacters are not allowed.") and
 * carry no implementation detail, so they are the ONLY response bodies ever
 * forwarded verbatim. Every other body — 500 internal/filesystem errors, 403
 * origin details, 404 endpoint lists, unknown or malformed payloads — is
 * replaced with generic copy before it can reach the UI.
 */
const SAFE_POLICY_DENIALS: ReadonlySet<string> = new Set([
  "command is required",
  "Shell chaining && and || is not allowed.",
  "Pipe | is only allowed for PowerShell terminal commands.",
  "Shell metacharacters are not allowed.",
  "Command could not be parsed."
]);

/** `"bin" is not an allowed command.` — `bin` is the caller's own bounded, quote-free token. */
const ALLOWED_BIN_DENIAL_RE = /^"[^"\s]{1,64}" is not an allowed command\.$/;

/**
 * Generic, non-technical copy for a rejected connector request. Deliberately
 * matches none of the technical-error patterns used by the connection store, so
 * a reachable connector is never wrongly marked unavailable.
 */
function safeConnectorStatusMessage(status: number): string {
  if (status === 403) {
    return "The local terminal refused access, so nothing was executed. Open the Terminal panel, reconnect your terminal, then try again.";
  }
  if (status === 404) {
    return "The local terminal connector did not understand this request, so nothing was executed. Open the Terminal panel, reconnect your terminal, then try again.";
  }
  if (status >= 500) {
    return "The local terminal hit an internal error, so nothing was executed. Please try again.";
  }
  return "The local terminal could not run that command, so nothing was executed. Please try again.";
}

/** Pull the connector's `error` string out of a response body, when it is a usable string. */
function extractConnectorErrorMessage(body: string): string {
  const raw = (body || "").trim();
  if (!raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
      return (parsed as { error: string }).error.trim();
    }
    return "";
  } catch {
    // Not JSON (e.g. a proxy error page). The caller only forwards this when it
    // exactly matches the allow-list, so arbitrary text still never escapes.
    return raw;
  }
}

/**
 * Build the error for a non-OK connector response. Only an explicitly
 * allow-listed HTTP 400 policy denial survives verbatim; every other body is
 * replaced with generic copy, so internal filesystem errors, origin details,
 * endpoint lists and server implementation details never reach the user.
 *
 * This runs at the source (where the response body enters the app) and composes
 * with the existing downstream `toUserFacingTerminalError` backstop: safe copy
 * passes through that sanitizer untouched, while anything technical it does
 * recognise would still be redacted.
 */
export function connectorHttpError(status: number, body: string): Error {
  if (status === 400) {
    const candidate = extractConnectorErrorMessage(body);
    if (candidate && (SAFE_POLICY_DENIALS.has(candidate) || ALLOWED_BIN_DENIAL_RE.test(candidate))) {
      return new Error(candidate);
    }
  }
  return new Error(safeConnectorStatusMessage(status));
}

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

  // The fetch below is what actually surfaces the Local Network Access prompt
  // (public -> private) during a user-gesture connect. permissions.query only
  // reads state and never triggers the prompt, so no extra query is issued here.

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
      // A timeout while the Local Network Access permission is still awaiting a
      // decision means the user was likely responding to the browser prompt —
      // surface the actionable permission screen instead of a misleading
      // "connector not running" (the connector may be perfectly healthy).
      const after = await queryLocalNetworkPermission();
      cachedProbe =
        after === "prompt" || after === "denied"
          ? { ok: false, reason: "permission" }
          : { ok: false, reason: "timeout" };
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
  /**
   * Parse a successful connector response. A malformed, truncated or stalled
   * body must never surface as a raw parser/abort exception in the UI — only
   * the generic copy below may be shown, with the real detail logged for
   * developers.
   */
  const readConnectorJson = async (res: Response): Promise<Record<string, unknown>> => {
    try {
      const data = await fetchWithTimeout(res);
      if (!data || typeof data !== "object") throw new Error("unexpected response body");
      return data as Record<string, unknown>;
    } catch (e) {
      console.debug("[Terminal] unreadable connector response (developer detail):", e instanceof Error ? e.message : String(e));
      throw new Error("The local terminal connector returned an unreadable response, so nothing was executed. Please try again.");
    }
  };
  return {
    async run(req) {
      let res: Response;
      try {
        res = await postRun({ command: req.command, cwd: req.cwd, timeoutMs: req.timeoutMs });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Keep the raw cause for developers only — the thrown text is what the
        // UI may show, so it must not carry URLs, ports, setup commands or
        // other implementation detail. The classification prefixes below are
        // what the connection store and executor key off for marking the
        // connection unavailable.
        console.debug("[Terminal] connector transport failure (developer detail):", msg);
        if (msg.includes("aborted") || msg.includes("abort")) {
          throw new Error("TIMEOUT: Local terminal connector did not respond in time, so nothing was executed. Please try again.");
        }
        throw new Error("NETWORK_ERROR: Cannot reach the local terminal connector, so nothing was executed.");
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw connectorHttpError(res.status, body);
      }
      const data = await readConnectorJson(res);
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
        // Same rule as run(): raw cause stays in developer logs, the thrown text
        // stays free of URLs, ports and setup instructions.
        console.debug("[Terminal] connector test transport failure (developer detail):", msg);
        if (msg.includes("aborted") || msg.includes("abort")) {
          throw new Error("TIMEOUT: Local terminal connector did not respond in time, so nothing was executed. Please try again.");
        }
        throw new Error("NETWORK_ERROR: Cannot reach the local terminal connector, so nothing was executed.");
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw connectorHttpError(res.status, body);
      }
      const data = await readConnectorJson(res);
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
