// Browser runtime that talks to the local connector's terminal endpoint.
// Used when window.nexussDesktop is not available (normal Chrome at https://nexuss.in).
// The connector must be running via `node local-connector/server.js` on 127.0.0.1:11435.

import type { NativeCommandResult, NativeTestResult, NativeRunRequest, NativeCapabilities } from "@/workspace/agent/types";

const CONNECTOR_URL = "http://127.0.0.1:11435";
const HEALTH_TIMEOUT_MS = 1500;

let cachedAvailable: boolean | null = null;
let lastCheck = 0;
const CACHE_TTL_MS = 5000;

async function isLocalConnectorAvailable(): Promise<boolean> {
  const now = Date.now();
  if (cachedAvailable !== null && now - lastCheck < CACHE_TTL_MS) return cachedAvailable;
  lastCheck = now;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`${CONNECTOR_URL}/health`, { signal: controller.signal, headers: { "Content-Type": "application/json" } });
    clearTimeout(t);
    if (!res.ok) { cachedAvailable = false; return false; }
    const data = await res.json().catch(() => ({}));
    cachedAvailable = data.terminal === "enabled" || data.connector === "nexuss-local";
    return cachedAvailable;
  } catch {
    cachedAvailable = false;
    return false;
  }
}

export function createLocalConnectorRuntime(): {
  run: (req: NativeRunRequest) => Promise<NativeCommandResult>;
  test: (req: { cwd?: string; timeoutMs?: number }) => Promise<NativeTestResult>;
  capabilities: () => NativeCapabilities;
  isAvailable: () => Promise<boolean>;
} {
  return {
    async run(req) {
      let res: Response;
      try {
        res = await fetch(`${CONNECTOR_URL}/v1/terminal/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: req.command, cwd: req.cwd, timeoutMs: req.timeoutMs })
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Network/CORS/mixed-content failure — distinguish from terminal command failure
        if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("ECONNREFUSED") || msg.includes("fetch")) {
          throw new Error(`NETWORK_ERROR: Cannot reach local terminal connector at ${CONNECTOR_URL}. Ensure it is running (node local-connector/server.js) and your browser allows Private Network Access. Details: ${msg}`);
        }
        throw new Error(`NETWORK_ERROR: ${msg}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let err = text;
        try { const j = JSON.parse(text); err = j.error || text; } catch {}
        throw new Error(err || `Terminal request failed (${res.status})`);
      }
      const data = await res.json();
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
        res = await fetch(`${CONNECTOR_URL}/v1/terminal/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: "npm test", cwd: req.cwd, timeoutMs: req.timeoutMs })
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("ECONNREFUSED") || msg.includes("fetch")) {
          throw new Error(`NETWORK_ERROR: Cannot reach local terminal connector at ${CONNECTOR_URL}. Details: ${msg}`);
        }
        throw new Error(`NETWORK_ERROR: ${msg}`);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Test failed (${res.status})`);
      }
      const data = await res.json();
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
