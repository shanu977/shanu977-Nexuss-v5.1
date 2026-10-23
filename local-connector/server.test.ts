import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const PORT = 11440 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_JS = fileURLToPath(new URL("./server.js", import.meta.url));
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
  child = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, NEXUSS_CONNECTOR_PORT: String(PORT) },
    stdio: "ignore",
  });
  await waitHealthy();
});

afterAll(() => {
  child?.kill();
});

describe("Nexuss local connector — setup endpoints", () => {
  it("answers its own health check", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connector).toBe("nexuss-local");
  });

  it("exposes a server-side Ollama status without guessing install state", async () => {
    const res = await fetch(`${BASE}/v1/ollama/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ollama).toBeTruthy();
    expect(typeof body.ollama.running).toBe("boolean");
    // installed is a real boolean on known platforms, null otherwise — never a guess.
    expect([true, false, null]).toContain(body.ollama.installed);
    expect(typeof body.ollama.endpoint).toBe("string");
  });

  it("rejects disallowed origins on the status endpoint", async () => {
    const res = await fetch(`${BASE}/v1/ollama/status`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("only allows GET on the status endpoint", async () => {
    const res = await fetch(`${BASE}/v1/ollama/status`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("answers CORS preflight for allowed local origins", async () => {
    const res = await fetch(`${BASE}/v1/ollama/status`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
  });
});

describe("Nexuss local connector — model download guardrails", () => {
  it("validates the model id before proxying a pull", async () => {
    const res = await fetch(`${BASE}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "bad model; rm -rf /", stream: true }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-POST pulls", async () => {
    const res = await fetch(`${BASE}/api/pull`);
    expect(res.status).toBe(405);
  });

  it("rejects disallowed origins on pulls", async () => {
    const res = await fetch(`${BASE}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ model: "qwen2.5:3b", stream: true }),
    });
    expect(res.status).toBe(403);
  });

  it("forwards a well-formed pull (or reports Ollama being down) without 400s", async () => {
    const res = await fetch(`${BASE}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A registry miss: never a real download.
      body: JSON.stringify({ model: "nexuss-test/definitely-not-a-real-model", stream: true }),
    });
    // 200 stream (error event), 404 from the registry, or 502 when Ollama is down.
    expect([200, 404, 502]).toContain(res.status);
    await res.text();
  });
});

describe("Nexuss local connector — path allowlist", () => {
  it("proxies the chat path", async () => {
    const res = await fetch(`${BASE}/v1/models`);
    // 200 from Ollama, or 502 when Ollama is down — never 404 from the guard.
    expect(res.status).not.toBe(404);
    await res.text();
  });

  it("404s unknown paths instead of proxying them", async () => {
    for (const p of ["/v1/definitely-not-a-route", "/api/definitely-not-a-route", "/admin"]) {
      const res = await fetch(`${BASE}${p}`);
      expect(res.status).toBe(404);
    }
  });
});

describe("Nexuss local connector — terminal capability advertisement", () => {
  it("answers GET /v1/terminal/capabilities with the real capability set", async () => {
    const res = await fetch(`${BASE}/v1/terminal/capabilities`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connector).toBe("nexuss-local");
    expect(body.capabilities).toEqual({ run: true, test: true });
    expect(typeof body.protocol).toBe("number");
    expect(typeof body.version).toBe("string");
  });

  it("only allows GET on the capabilities endpoint", async () => {
    const res = await fetch(`${BASE}/v1/terminal/capabilities`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("rejects disallowed origins on the capabilities endpoint", async () => {
    const res = await fetch(`${BASE}/v1/terminal/capabilities`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("answers CORS preflight for allowed local origins", async () => {
    const res = await fetch(`${BASE}/v1/terminal/capabilities`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
  });
});

describe("Nexuss local connector — port conflict handling", () => {
  it(
    "exits 1 with an actionable message when a silent process holds the port",
    async () => {
      const conflictPort = 14000 + Math.floor(Math.random() * 500);
      // Accepts TCP connections but never answers HTTP — the exact "silent
      // occupant" case that used to make the connector exit quietly without
      // any diagnosis, leaving launchers believing it had started.
      const occupant = createServer((socket) => {
        // Hold the socket, never respond. When the spawned server times out
        // and destroys the connection, swallow the resulting reset.
        socket.on("error", () => {});
      });
      await new Promise<void>((resolve, reject) => {
        occupant.once("error", reject);
        occupant.listen(conflictPort, "127.0.0.1", resolve);
      });

      try {
        const conflicted = spawn(process.execPath, [SERVER_JS], {
          env: { ...process.env, NEXUSS_CONNECTOR_PORT: String(conflictPort) },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        conflicted.stderr?.on("data", (d) => (stderr += d.toString()));
        const code = await new Promise<number | null>((resolve) => {
          conflicted.on("close", resolve);
        });

        expect(code).toBe(1);
        expect(stderr).toMatch(/did not answer \/health within 2000 ms/);
        expect(stderr).toMatch(/Stop that program/);
      } finally {
        await new Promise<void>((resolve) => occupant.close(() => resolve()));
      }
    },
    15_000
  );

  it(
    "exits 0 when a healthy connector already serves the port",
    async () => {
      const duplicated = spawn(process.execPath, [SERVER_JS], {
        env: { ...process.env, NEXUSS_CONNECTOR_PORT: String(PORT) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      duplicated.stdout?.on("data", (d) => (stdout += d.toString()));
      const code = await new Promise<number | null>((resolve) => {
        duplicated.on("close", resolve);
      });

      expect(code).toBe(0);
      expect(stdout).toMatch(/healthy connector/);
    },
    10_000
  );
});
