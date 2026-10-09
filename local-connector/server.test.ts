import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = 11440 + Math.floor(Math.random() * 100);
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
      env: { ...process.env, NEXUSS_CONNECTOR_PORT: String(PORT) },
      stdio: "ignore",
    }
  );
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
