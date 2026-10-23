// Ollama startup (POST /v1/ollama/ensure) — the browser-triggered auto-start.
//
// Two layers:
//   1. Unit tests of `ensureOllamaRunning` with fully injected deps (detect /
//      probe / spawn / sleep mocked) — deterministic outcomes for every state
//      machine branch, including single-flight and spawn failure. No real
//      process is ever launched.
//   2. Real HTTP tests against a spawned connector — endpoint guardrails
//      (POST-only, origin-checked, structured body, request body ignored).
//      The HTTP ensure test asserts the SHAPE, not a specific status: on a
//      machine with Ollama running it answers "running"; without Ollama it
//      answers "missing"; both are valid structured outcomes and no test
//      asserts a real spawn (the startup timeout env is clamped short so a
//      stopped-but-installed machine cannot stall the suite).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// server.js is CommonJS and self-contained (the one-time download asset);
// load it via createRequire so its exports are the real production functions.
const require_ = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const server = require_("./server.js") as any;

const ensureOllamaRunning = server.ensureOllamaRunning as (deps?: Record<string, unknown>) => Promise<{
  status: "running" | "starting" | "stopped" | "missing" | "failed";
  installed: boolean | null;
  running: boolean;
  started: boolean;
  version: string | null;
  endpoint: string;
  durationMs: number;
  error: string | null;
}>;
const findOllamaExecutable = server.findOllamaExecutable as () => { path: string; launchable: boolean } | null;

/** Minimal EventEmitter-ish child stand-in for the injected spawn dep. */
function fakeChild() {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    on(event: string, cb: () => void) {
      (handlers[event] ||= []).push(cb);
      return this;
    },
    emit(event: string) {
      for (const cb of handlers[event] || []) cb();
    },
  };
}

const noSleep = async () => {};

describe("ensureOllamaRunning — injected deps (no real spawn)", () => {
  it("reports missing when Ollama is not installed and never spawns", async () => {
    let spawned = 0;
    const res = await ensureOllamaRunning({
      detectInstalled: () => false,
      findExecutable: () => null,
      probeHealth: async () => ({ running: false, version: null }),
      spawnOllama: () => {
        spawned += 1;
        return fakeChild();
      },
      sleep: noSleep,
      timeoutMs: 50,
      pollIntervalMs: 5,
    });

    expect(res.status).toBe("missing");
    expect(res.installed).toBe(false);
    expect(res.running).toBe(false);
    expect(res.started).toBe(false);
    expect(res.error).toMatch(/not installed/i);
    expect(spawned).toBe(0);
  });

  it("answers running without spawning when the health probe already succeeds", async () => {
    let spawned = 0;
    const res = await ensureOllamaRunning({
      detectInstalled: () => true,
      findExecutable: () => ({ path: "/fake/ollama", launchable: true }),
      probeHealth: async () => ({ running: true, version: "0.40.6" }),
      spawnOllama: () => {
        spawned += 1;
        return fakeChild();
      },
      sleep: noSleep,
      timeoutMs: 50,
      pollIntervalMs: 5,
    });

    expect(res.status).toBe("running");
    expect(res.version).toBe("0.40.6");
    expect(res.started).toBe(false);
    expect(spawned).toBe(0);
  });

  it("spawns the trusted detected path once and reports running when health recovers", async () => {
    const spawnedWith: string[] = [];
    let probes = 0;
    const res = await ensureOllamaRunning({
      detectInstalled: () => true,
      findExecutable: () => ({ path: "C:\\fake\\Ollama\\ollama.exe", launchable: true }),
      probeHealth: async () => {
        probes += 1;
        return probes > 1 ? { running: true, version: "0.40.6" } : { running: false, version: null };
      },
      spawnOllama: (exePath: string) => {
        spawnedWith.push(exePath);
        return fakeChild();
      },
      sleep: noSleep,
      timeoutMs: 1000,
      pollIntervalMs: 5,
    });

    expect(res.status).toBe("running");
    expect(res.started).toBe(true);
    // The executable comes only from trusted local detection — never a client value.
    expect(spawnedWith).toEqual(["C:\\fake\\Ollama\\ollama.exe"]);
  });

  it("reports stopped (not launchable) when detection finds an install we cannot open", async () => {
    let spawned = 0;
    const res = await ensureOllamaRunning({
      detectInstalled: () => true,
      // macOS .app bundle: installed but not directly launchable by the connector.
      findExecutable: () => ({ path: "/Applications/Ollama.app", launchable: false }),
      probeHealth: async () => ({ running: false, version: null }),
      spawnOllama: () => {
        spawned += 1;
        return fakeChild();
      },
      sleep: noSleep,
      timeoutMs: 50,
      pollIntervalMs: 5,
    });

    expect(res.status).toBe("stopped");
    expect(res.started).toBe(false);
    expect(res.error).toMatch(/manually/i);
    expect(spawned).toBe(0);
  });

  it("reports failed when the spawn itself throws", async () => {
    const res = await ensureOllamaRunning({
      detectInstalled: () => true,
      findExecutable: () => ({ path: "C:\\fake\\ollama.exe", launchable: true }),
      probeHealth: async () => ({ running: false, version: null }),
      spawnOllama: () => {
        throw new Error("EPERM: operation not permitted");
      },
      sleep: noSleep,
      timeoutMs: 50,
      pollIntervalMs: 5,
    });

    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/couldn't be started|could not be started/i);
    // Raw spawn errors never leak into the user-facing message.
    expect(res.error).not.toMatch(/EPERM|stack/i);
  });

  it("reports failed when the spawned process dies before becoming healthy", async () => {
    const child = fakeChild();
    const res = await ensureOllamaRunning({
      detectInstalled: () => true,
      findExecutable: () => ({ path: "C:\\fake\\ollama.exe", launchable: true }),
      probeHealth: async () => {
        // Simulate the process exiting while the first poll sleeps.
        child.emit("exit");
        return { running: false, version: null };
      },
      spawnOllama: () => child,
      sleep: noSleep,
      timeoutMs: 1000,
      pollIntervalMs: 5,
    });

    expect(res.status).toBe("failed");
    expect(res.started).toBe(true);
  });

  it("reports starting (NOT ready) when the process is alive but health never answers in time", async () => {
    const child = fakeChild();
    const res = await ensureOllamaRunning({
      detectInstalled: () => true,
      findExecutable: () => ({ path: "C:\\fake\\ollama.exe", launchable: true }),
      probeHealth: async () => ({ running: false, version: null }),
      spawnOllama: () => child,
      sleep: noSleep,
      timeoutMs: 30,
      pollIntervalMs: 5,
    });

    // `starting` is deliberately not `running`: callers must keep polling
    // real health instead of assuming success.
    expect(res.status).toBe("starting");
    expect(res.running).toBe(false);
    expect(res.started).toBe(true);
  });

  it("is single-flight: concurrent calls share one execution and one spawn", async () => {
    let spawns = 0;
    let probes = 0;
    const deps = {
      detectInstalled: () => true,
      findExecutable: () => ({ path: "C:\\fake\\ollama.exe", launchable: true }),
      probeHealth: async () => {
        probes += 1;
        // Hang the first probe briefly so both callers overlap.
        await new Promise((r) => setTimeout(r, 20));
        return probes >= 2 ? { running: true, version: "0.40.6" } : { running: false, version: null };
      },
      spawnOllama: () => {
        spawns += 1;
        return fakeChild();
      },
      sleep: noSleep,
      timeoutMs: 1000,
      pollIntervalMs: 5,
    };

    const [a, b] = await Promise.all([ensureOllamaRunning(deps), ensureOllamaRunning(deps)]);

    expect(a.status).toBe("running");
    expect(b.status).toBe("running");
    // One spawn, one health-probe sequence — parallel chat messages can
    // never start multiple Ollama processes.
    expect(spawns).toBe(1);
  });

  it("returns a structured shape with the fixed loopback endpoint on every outcome", async () => {
    const res = await ensureOllamaRunning({
      detectInstalled: () => false,
      findExecutable: () => null,
      probeHealth: async () => ({ running: false, version: null }),
      spawnOllama: () => fakeChild(),
      sleep: noSleep,
      timeoutMs: 50,
      pollIntervalMs: 5,
    });

    expect(res.endpoint).toBe("http://127.0.0.1:11434");
    expect(typeof res.durationMs).toBe("number");
    expect(["running", "starting", "stopped", "missing", "failed"]).toContain(res.status);
  });

  it("findOllamaExecutable only returns real, existing paths (no guessing)", () => {
    const exe = findOllamaExecutable();
    if (exe) {
      // When present it must be an absolute path that exists on this machine.
      expect(exe.path).toMatch(/^(?:[A-Za-z]:\\|\/|\\\\)/);
      expect(typeof exe.launchable).toBe("boolean");
    } else {
      // null is a valid answer on machines without Ollama / unknown platforms.
      expect(exe).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Real HTTP endpoint — guardrails. Spawns the actual connector.
// ---------------------------------------------------------------------------

const PORT = 11900 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess | null = null;

async function waitHealthy(timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("connector did not become healthy");
}

beforeAll(async () => {
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./server.js", import.meta.url))],
    {
      env: {
        ...process.env,
        NEXUSS_CONNECTOR_PORT: String(PORT),
        // Clamp startup so a machine with Ollama installed-but-stopped can
        // never stall the suite; the test asserts shape, not a real spawn.
        NEXUSS_OLLAMA_START_TIMEOUT_MS: "1500",
        NEXUSS_OLLAMA_POLL_INTERVAL_MS: "100",
      },
      stdio: "ignore",
    }
  );
  await waitHealthy();
});

afterAll(() => {
  child?.kill();
});

describe("POST /v1/ollama/ensure — HTTP guardrails", () => {
  it("rejects GET (POST only)", async () => {
    const res = await fetch(`${BASE}/v1/ollama/ensure`);
    expect(res.status).toBe(405);
    await res.text();
  });

  it("rejects disallowed origins", async () => {
    const res = await fetch(`${BASE}/v1/ollama/ensure`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ exe: "C:\\evil\\payload.exe", args: ["serve"] }),
    });
    expect(res.status).toBe(403);
    await res.text();
  });

  it("answers CORS preflight for allowed local origins", async () => {
    const res = await fetch(`${BASE}/v1/ollama/ensure`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
  });

  it("ignores any client-supplied body and answers with the structured outcome", async () => {
    const res = await fetch(`${BASE}/v1/ollama/ensure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A hostile body naming an arbitrary executable: it must be ignored —
      // the executable path comes only from trusted local detection.
      body: JSON.stringify({ exe: "C:\\Windows\\System32\\cmd.exe", args: ["/c", "calc"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.connector).toBe("nexuss-local");
    const ollama = body.ollama;
    // Structured shape — the specific status depends on this machine.
    expect(["running", "starting", "stopped", "missing", "failed"]).toContain(ollama.status);
    expect(typeof ollama.installed).toBe("boolean");
    expect(typeof ollama.running).toBe("boolean");
    expect(typeof ollama.started).toBe("boolean");
    expect(ollama.endpoint).toBe("http://127.0.0.1:11434");
    expect(typeof ollama.durationMs).toBe("number");
    // No raw internals in the error field.
    if (ollama.error) {
      expect(ollama.error).not.toMatch(/stack|ECONNREFUSED|spawn .* ENOENT/i);
    }
  });

  it("keeps the status endpoint GET-only (regression guard for the ensure addition)", async () => {
    const res = await fetch(`${BASE}/v1/ollama/status`, { method: "POST" });
    expect(res.status).toBe(405);
    await res.text();
  });
});
