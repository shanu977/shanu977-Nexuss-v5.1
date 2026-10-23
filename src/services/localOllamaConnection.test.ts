// Automatic Ollama connection/startup/recovery — web service layer.
//
// Covers the ensure lifecycle (structured outcomes, single-flight, abort),
// the structured 502 error parsing, and the one-time recovery+retry inside
// streamLocalChat. Everything network-facing is mocked (global fetch); the
// real Windows spawn verification lives in local-connector/ollamaEnsure.test.ts
// and the manual verification steps in the PR description.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureLocalModelConnection,
  extractLocalErrorDetail,
  isConnectionishDetail,
  isDefaultOllamaLoopbackEndpoint,
  isLocalConnectionError,
  LocalConnectionError,
  LOCAL_CONNECTION_MESSAGES,
  streamLocalChat,
  type LocalChatMessage,
} from "@/services/localModels";
import {
  useLocalConnectionStore,
  finishLocalConnection,
} from "@/store/localConnectionStore";

const mocks = vi.hoisted(() => ({
  connectorAvailable: vi.fn(async () => false),
}));

vi.mock("@/workspace/localTerminalRuntime", () => ({
  isLocalConnectorAvailable: mocks.connectorAvailable,
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const STATUS_URL = "http://127.0.0.1:11435/v1/ollama/status";
const ENSURE_URL = "http://127.0.0.1:11435/v1/ollama/ensure";
const DIRECT_HEALTH_URL = "http://127.0.0.1:11434/api/version";
const CONNECTOR_CHAT_URL = "http://127.0.0.1:11435/v1/chat/completions";
const DIRECT_CHAT_URL = "http://127.0.0.1:11434/v1/chat/completions";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseRes(chunks: string[]): Response {
  const enc = new TextEncoder();
  const lines = chunks.map((c) =>
    enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`)
  );
  lines.push(enc.encode("data: [DONE]\n\n"));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(l);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

type EnsureOutcomeBody = {
  status: string;
  installed?: boolean | null;
  running?: boolean;
  started?: boolean;
  version?: string | null;
  endpoint?: string;
  durationMs?: number;
  error?: string | null;
};

function connectorStatusBody(ollama: { installed?: boolean | null; running: boolean }) {
  return { status: "ok", connector: "nexuss-local", ollama };
}

function ensureBody(outcome: Partial<EnsureOutcomeBody> & { status: string }) {
  return {
    status: "ok",
    connector: "nexuss-local",
    ollama: {
      installed: true,
      running: outcome.status === "running",
      started: false,
      version: null,
      endpoint: "http://127.0.0.1:11434",
      durationMs: 1,
      error: null,
      ...outcome,
    },
  };
}

/** Route fetch by URL. Handlers may be arrays (one response per call). */
function routeFetch(routes: Record<string, Response | Error | Array<Response | Error>>) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (!url.startsWith(prefix)) continue;
      const entry = Array.isArray(handler) ? handler.shift() ?? handler[handler.length - 1] : handler;
      if (entry instanceof Error) throw entry;
      // Clone-free: each Response body can only be read once, so callers that
      // need multiple reads must provide arrays.
      return entry;
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
}

async function collect(gen: AsyncGenerator<{ type: string; content?: string }>): Promise<string> {
  let out = "";
  for await (const ev of gen) {
    if (ev.type === "chunk" && ev.content) out += ev.content;
  }
  return out;
}

beforeEach(() => {
  mocks.connectorAvailable.mockResolvedValue(false);
  fetchMock.mockReset();
  finishLocalConnection();
});

afterEach(() => {
  finishLocalConnection();
  vi.useRealTimers();
});

describe("extractLocalErrorDetail", () => {
  it("reads the connector's string-valued error", () => {
    expect(
      extractLocalErrorDetail(
        JSON.stringify({ error: "Cannot connect to Ollama at 127.0.0.1:11434. Is Ollama running?" })
      )
    ).toBe("Cannot connect to Ollama at 127.0.0.1:11434. Is Ollama running?");
  });

  it("reads OpenAI-style error.message objects", () => {
    expect(extractLocalErrorDetail(JSON.stringify({ error: { message: "model not found" } }))).toBe(
      "model not found"
    );
  });

  it("reads detail and message fields", () => {
    expect(extractLocalErrorDetail(JSON.stringify({ detail: "bad request" }))).toBe("bad request");
    expect(extractLocalErrorDetail(JSON.stringify({ message: "oops" }))).toBe("oops");
  });

  it("returns null for empty, malformed and unexpected bodies", () => {
    expect(extractLocalErrorDetail("")).toBeNull();
    expect(extractLocalErrorDetail("   ")).toBeNull();
    expect(extractLocalErrorDetail("<html>502</html>")).toBeNull();
    expect(extractLocalErrorDetail(JSON.stringify({ error: {} }))).toBeNull();
    expect(extractLocalErrorDetail(JSON.stringify({ error: 500 }))).toBeNull();
    expect(extractLocalErrorDetail(JSON.stringify({ unexpected: "shape" }))).toBeNull();
  });
});

describe("isConnectionishDetail", () => {
  it("flags lost-connection phrasing", () => {
    expect(isConnectionishDetail("Cannot connect to Ollama at 127.0.0.1:11434. Is Ollama running?")).toBe(true);
    expect(isConnectionishDetail("connect ECONNREFUSED 127.0.0.1:11434")).toBe(true);
    expect(isConnectionishDetail("fetch failed")).toBe(true);
    expect(isConnectionishDetail("502 Bad Gateway")).toBe(true);
  });

  it("does not flag model-level errors", () => {
    expect(isConnectionishDetail("model 'foo' not found")).toBe(false);
    expect(isConnectionishDetail("context length exceeded")).toBe(false);
  });
});

describe("isDefaultOllamaLoopbackEndpoint", () => {
  it("accepts the two default loopback forms, with or without /v1", () => {
    expect(isDefaultOllamaLoopbackEndpoint("http://localhost:11434/v1")).toBe(true);
    expect(isDefaultOllamaLoopbackEndpoint("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isDefaultOllamaLoopbackEndpoint("http://localhost:11434")).toBe(true);
  });

  it("rejects other hosts, ports and providers", () => {
    expect(isDefaultOllamaLoopbackEndpoint("http://192.168.1.10:11434/v1")).toBe(false);
    expect(isDefaultOllamaLoopbackEndpoint("http://localhost:11435/v1")).toBe(false);
    expect(isDefaultOllamaLoopbackEndpoint("http://localhost:1234/v1")).toBe(false);
  });
});

describe("LocalConnectionError", () => {
  it("is recognized by isLocalConnectionError", () => {
    expect(isLocalConnectionError(new LocalConnectionError("x"))).toBe(true);
    expect(isLocalConnectionError(new Error("x"))).toBe(false);
  });
});

describe("ensureLocalModelConnection", () => {
  it("skips non-Ollama providers and non-default endpoints", async () => {
    const lmstudio = await ensureLocalModelConnection({
      providerType: "lmstudio",
      endpoint: "http://localhost:1234/v1",
    });
    expect(lmstudio).toEqual({ ok: true, via: "skipped", alreadyRunning: true });

    const customOllama = await ensureLocalModelConnection({
      providerType: "ollama",
      endpoint: "http://192.168.1.10:11434/v1",
    });
    expect(customOllama).toEqual({ ok: true, via: "skipped", alreadyRunning: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns ok via connector when Ollama is already running", async () => {
    routeFetch({ [STATUS_URL]: jsonRes(200, connectorStatusBody({ installed: true, running: true })) });

    const res = await ensureLocalModelConnection({ providerType: "ollama", endpoint: "http://localhost:11434/v1" });

    expect(res).toEqual({ ok: true, via: "already_running", alreadyRunning: true });
    expect(useLocalConnectionStore.getState().phase).toBe("connected");
    // Fast path never asks the connector to spawn anything.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/ensure"))).toBe(false);
  });

  it("fails with not_installed when the connector reports no install", async () => {
    routeFetch({ [STATUS_URL]: jsonRes(200, connectorStatusBody({ installed: false, running: false })) });

    const res = await ensureLocalModelConnection({ providerType: "ollama", endpoint: "http://localhost:11434/v1" });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("not_installed");
      expect(res.message).toBe(LOCAL_CONNECTION_MESSAGES.not_installed);
    }
    expect(useLocalConnectionStore.getState().phase).toBe("idle");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/ensure"))).toBe(false);
  });

  it("asks the connector to start a stopped Ollama and reports success", async () => {
    routeFetch({
      [STATUS_URL]: jsonRes(200, connectorStatusBody({ installed: true, running: false })),
      [ENSURE_URL]: jsonRes(200, ensureBody({ status: "running", started: true })),
    });

    const res = await ensureLocalModelConnection({ providerType: "ollama", endpoint: "http://localhost:11434/v1" });

    expect(res).toEqual({ ok: true, via: "connector", alreadyRunning: false });
    expect(useLocalConnectionStore.getState().phase).toBe("connected");
    const ensureCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/ensure"));
    expect(ensureCall).toBeTruthy();
    expect((ensureCall![1] as RequestInit).method).toBe("POST");
  });

  it("maps every structured ensure failure to its user-safe reason", async () => {
    const cases: Array<[string, string]> = [
      ["missing", "not_installed"],
      ["stopped", "not_started"],
      ["failed", "startup_failed"],
    ];
    for (const [outcome, reason] of cases) {
      fetchMock.mockReset();
      routeFetch({
        [STATUS_URL]: jsonRes(200, connectorStatusBody({ installed: true, running: false })),
        [ENSURE_URL]: jsonRes(200, ensureBody({ status: outcome })),
      });
      const res = await ensureLocalModelConnection({ providerType: "ollama", endpoint: "http://localhost:11434/v1" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe(reason);
        expect(res.message.length).toBeGreaterThan(0);
        // Never leak connector internals to the chat UI.
        expect(res.message).not.toMatch(/spawn|shell|ollama\.exe|stack/i);
      }
      expect(useLocalConnectionStore.getState().phase).toBe("idle");
    }
  });

  it("reports connector_outdated when the connector has no ensure endpoint", async () => {
    routeFetch({
      [STATUS_URL]: jsonRes(200, connectorStatusBody({ installed: true, running: false })),
      [ENSURE_URL]: jsonRes(404, { error: "Not found" }),
    });

    const res = await ensureLocalModelConnection({ providerType: "ollama", endpoint: "http://localhost:11434/v1" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("connector_outdated");
  });

  it("reports connector_unreachable when the ensure POST itself fails", async () => {
    routeFetch({
      [STATUS_URL]: jsonRes(200, connectorStatusBody({ installed: true, running: false })),
      [ENSURE_URL]: new TypeError("Failed to fetch"),
    });

    const res = await ensureLocalModelConnection({ providerType: "ollama", endpoint: "http://localhost:11434/v1" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("connector_unreachable");
  });

  it("keeps waiting with real health polls while the connector reports starting", async () => {
    vi.useFakeTimers();
    let statusCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(ENSURE_URL)) return jsonRes(200, ensureBody({ status: "starting" }));
      if (url.startsWith(STATUS_URL)) {
        statusCalls += 1;
        // First status (pre-ensure) says stopped; the poll after `starting`
        // reports healthy on the second poll.
        if (statusCalls === 1) return jsonRes(200, connectorStatusBody({ installed: true, running: false }));
        return jsonRes(200, connectorStatusBody({ installed: true, running: statusCalls >= 3 }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const pending = ensureLocalModelConnection({ providerType: "ollama", endpoint: "http://localhost:11434/v1" });
    // Two poll intervals at the 500ms cadence (plus slack for chained timers).
    await vi.advanceTimersByTimeAsync(1500);
    const res = await pending;

    expect(res).toEqual({ ok: true, via: "connector", alreadyRunning: false });
    expect(useLocalConnectionStore.getState().phase).toBe("connected");
  });

  it("gives up with startup_timeout when health never recovers within the budget", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(ENSURE_URL)) return jsonRes(200, ensureBody({ status: "starting" }));
      if (url.startsWith(STATUS_URL)) return jsonRes(200, connectorStatusBody({ installed: true, running: false }));
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const pending = ensureLocalModelConnection({ providerType: "ollama", endpoint: "http://localhost:11434/v1" });
    await vi.advanceTimersByTimeAsync(16_000);
    const res = await pending;

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("startup_timeout");
      expect(res.message).toBe(LOCAL_CONNECTION_MESSAGES.startup_timeout);
    }
    expect(useLocalConnectionStore.getState().phase).toBe("idle");
  });

  it("falls back to a direct health probe when the connector is absent", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(STATUS_URL)) throw new TypeError("Failed to fetch");
      if (url.startsWith(DIRECT_HEALTH_URL)) return new Response("{}", { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const res = await ensureLocalModelConnection({ providerType: "ollama", endpoint: "http://127.0.0.1:11434/v1" });

    expect(res).toEqual({ ok: true, via: "direct", alreadyRunning: true });
  });

  it("fails with connector_unreachable when neither connector nor Ollama answer", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const res = await ensureLocalModelConnection({ providerType: "ollama", endpoint: "http://localhost:11434/v1" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("connector_unreachable");
  });

  it("resolves cancelled without tearing down the shared attempt other callers need", async () => {
    let resolveStatus!: (r: Response) => void;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(STATUS_URL)) {
        return new Promise<Response>((resolve) => {
          resolveStatus = resolve;
        });
      }
      if (url.startsWith(DIRECT_HEALTH_URL)) return new Response("{}", { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const ac = new AbortController();
    const first = ensureLocalModelConnection({
      providerType: "ollama",
      endpoint: "http://localhost:11434/v1",
      signal: ac.signal,
    });
    // Let the shared op reach the hanging status fetch before cancelling.
    await Promise.resolve();
    await Promise.resolve();
    ac.abort();
    const cancelled = await first;
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.reason).toBe("cancelled");

    // A second caller joins the still-running shared op and gets the real answer.
    const second = ensureLocalModelConnection({ providerType: "ollama", endpoint: "http://localhost:11434/v1" });
    resolveStatus(jsonRes(200, connectorStatusBody({ installed: true, running: true })));
    const res = await second;
    expect(res).toEqual({ ok: true, via: "already_running", alreadyRunning: true });
  });

  it("shares one execution across concurrent callers (single-flight)", async () => {
    let statusCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(STATUS_URL)) {
        statusCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return jsonRes(200, connectorStatusBody({ installed: true, running: true }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const [a, b] = await Promise.all([
      ensureLocalModelConnection({ providerType: "ollama", endpoint: "http://localhost:11434/v1" }),
      ensureLocalModelConnection({ providerType: "ollama", endpoint: "http://localhost:11434/v1" }),
    ]);

    expect(a).toEqual({ ok: true, via: "already_running", alreadyRunning: true });
    expect(b).toEqual({ ok: true, via: "already_running", alreadyRunning: true });
    expect(statusCalls).toBe(1);
  });
});

describe("streamLocalChat — 502 parsing and one-time recovery", () => {
  // streamLocalChat reads module-level connector cache (cachedAvailable /
  // lastCheck) that earlier ensure tests mutate via markConnectorReachable().
  // Reset the module registry per test so every scenario starts from a clean
  // slate (cachedAvailable === null → first request goes direct).
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadStream() {
    const mod = await import("@/services/localModels");
    return mod.streamLocalChat;
  }

  const messages: LocalChatMessage[] = [{ role: "user", content: "hi" }];

  function streamParams(overrides: Partial<{ endpoint: string; signal: AbortSignal }> = {}) {
    return {
      endpoint: overrides.endpoint ?? "http://127.0.0.1:11434/v1",
      modelId: "llama3.2:3b",
      messages,
      ...(overrides.signal ? { signal: overrides.signal } : {}),
    };
  }

  it("extracts detail from every error-body shape on non-retry HTTP failures", async () => {
    const streamLocalChat = await loadStream();
    // 400 with a string error body surfaces the extracted detail.
    routeFetch({
      [DIRECT_CHAT_URL]: jsonRes(400, { error: "temperature must be between 0 and 2" }),
    });
    await expect(collect(streamLocalChat(streamParams()))).rejects.toThrow(
      "temperature must be between 0 and 2"
    );

    // Malformed body falls back to a generic status message.
    fetchMock.mockReset();
    routeFetch({ [DIRECT_CHAT_URL]: new Response("<html>oops</html>", { status: 500 }) });
    await expect(collect(streamLocalChat(streamParams()))).rejects.toThrow("Local model error (500)");
  });

  it("maps 401 and 404 to their specific guidance and never retries them", async () => {
    const streamLocalChat = await loadStream();
    routeFetch({
      [DIRECT_CHAT_URL]: jsonRes(401, { error: { message: "unauthorized" } }),
    });
    await expect(collect(streamLocalChat(streamParams()))).rejects.toThrow(/401/);
    // 401 must not have triggered connection recovery (no status/ensure calls).
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/ollama/"))).toHaveLength(0);

    fetchMock.mockReset();
    routeFetch({
      [DIRECT_CHAT_URL]: jsonRes(404, { error: { message: "model not found" } }),
    });
    await expect(collect(streamLocalChat(streamParams()))).rejects.toThrow(/404/);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/ollama/"))).toHaveLength(0);
  });

  it("recovers from a 502 by verifying the connection and retrying once through the connector", async () => {
    const streamLocalChat = await loadStream();
    // First attempt: direct endpoint answers 502 with the connector's
    // connection-shaped body. Recovery verifies health via the connector
    // status endpoint, then the retry goes through the connector and streams.
    routeFetch({
      [DIRECT_CHAT_URL]: jsonRes(502, {
        error: "Cannot connect to Ollama at 127.0.0.1:11434. Is Ollama running?",
      }),
      [STATUS_URL]: jsonRes(200, connectorStatusBody({ installed: true, running: true })),
      [CONNECTOR_CHAT_URL]: sseRes(["recovered ", "answer"]),
    });

    const out = await collect(streamLocalChat(streamParams()));
    expect(out).toBe("recovered answer");

    const chatCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/chat/completions"));
    expect(chatCalls).toHaveLength(2);
    expect(String(chatCalls[0][0])).toBe(DIRECT_CHAT_URL);
    expect(String(chatCalls[1][0])).toBe(CONNECTOR_CHAT_URL);
  });

  it("throws an actionable LocalConnectionError when recovery cannot verify health", async () => {
    const streamLocalChat = await loadStream();
    // The chat POST answers 502, but every follow-up probe (connector status,
    // direct health) fails — recovery must map that to the user-safe copy.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(DIRECT_CHAT_URL)) {
        return jsonRes(502, { error: "Cannot connect to Ollama at 127.0.0.1:11434. Is Ollama running?" });
      }
      throw new TypeError("Failed to fetch");
    });

    const err = await collect(streamLocalChat(streamParams())).catch((e: unknown) => e);
    expect(isLocalConnectionError(err)).toBe(true);
    expect((err as Error).message).toBe(LOCAL_CONNECTION_MESSAGES.connector_unreachable);
  });

  it("never retries more than once: a second 502 becomes a LocalConnectionError", async () => {
    const streamLocalChat = await loadStream();
    routeFetch({
      [DIRECT_CHAT_URL]: jsonRes(502, {
        error: "Cannot connect to Ollama at 127.0.0.1:11434. Is Ollama running?",
      }),
      [STATUS_URL]: jsonRes(200, connectorStatusBody({ installed: true, running: true })),
      [CONNECTOR_CHAT_URL]: jsonRes(502, {
        error: "Cannot connect to Ollama at 127.0.0.1:11434. Is Ollama running?",
      }),
    });

    const err = await collect(streamLocalChat(streamParams())).catch((e: unknown) => e);
    expect(isLocalConnectionError(err)).toBe(true);
    // Connection-shaped bodies map to the actionable copy, never raw internals.
    expect((err as Error).message).toBe(LOCAL_CONNECTION_MESSAGES.unavailable);
  });

  it("surfaces a non-connection 502 detail verbatim after the retry", async () => {
    const streamLocalChat = await loadStream();
    routeFetch({
      [DIRECT_CHAT_URL]: jsonRes(502, {
        error: "Cannot connect to Ollama at 127.0.0.1:11434. Is Ollama running?",
      }),
      [STATUS_URL]: jsonRes(200, connectorStatusBody({ installed: true, running: true })),
      [CONNECTOR_CHAT_URL]: jsonRes(502, { detail: "upstream model server rejected the gateway token" }),
    });

    const err = await collect(streamLocalChat(streamParams())).catch((e: unknown) => e);
    expect(isLocalConnectionError(err)).toBe(true);
    expect((err as Error).message).toBe("upstream model server rejected the gateway token");
  });

  it("skips recovery entirely for non-default endpoints (502 surfaces directly)", async () => {
    const streamLocalChat = await loadStream();
    routeFetch({
      "http://localhost:1234/v1/chat/completions": jsonRes(502, {
        detail: "LM Studio gateway hiccup",
      }),
    });

    const err = await collect(
      streamLocalChat(streamParams({ endpoint: "http://localhost:1234/v1" }))
    ).catch((e: unknown) => e);
    expect(isLocalConnectionError(err)).toBe(true);
    expect((err as Error).message).toBe("LM Studio gateway hiccup");
    // No connector status/ensure traffic for non-default endpoints.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/ollama/"))).toHaveLength(0);
  });

  it("skips recovery for an already-aborted request and maps the 502 directly", async () => {
    const streamLocalChat = await loadStream();
    const ac = new AbortController();
    ac.abort();
    routeFetch({
      [DIRECT_CHAT_URL]: jsonRes(502, { error: "Cannot connect to Ollama at 127.0.0.1:11434. Is Ollama running?" }),
    });

    const err = await collect(streamLocalChat(streamParams({ signal: ac.signal }))).catch((e: unknown) => e);
    // Recovery is gated on !signal.aborted: the 502 maps straight to the
    // actionable LocalConnectionError with no connector traffic.
    expect(isLocalConnectionError(err)).toBe(true);
    expect((err as Error).message).toBe(LOCAL_CONNECTION_MESSAGES.unavailable);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/ollama/"))).toHaveLength(0);
  });
});
