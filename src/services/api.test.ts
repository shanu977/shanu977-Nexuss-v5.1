import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request, requestStream } from "@/services/api";

const mocks = vi.hoisted(() => ({
  firebaseMock: {
    auth: { currentUser: null }
  }
}));

vi.mock("@/lib/firebase", () => mocks.firebaseMock);

const DEFAULT_TIMEOUT_MS = 120_000;
const STALL_TIMEOUT_MS = 30_000;

function sseBody(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("request", () => {
  it("returns parsed JSON on a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ reply: "hi", provider: "groq" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      )
    );

    const data = await request<{ reply: string }>("/chat", {
      method: "POST",
      body: "{}"
    });

    expect(data).toEqual({ reply: "hi", provider: "groq" });
  });

  it("surfaces the backend detail on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "All AI providers failed." }), {
          status: 502,
          headers: { "Content-Type": "application/json" }
        })
      )
    );

    const err = await request<unknown>("/chat", { method: "POST", body: "{}" }).catch(
      (e: unknown) => e
    );

    expect(err).toMatchObject({
      status: 502,
      message: "All AI providers failed."
    });
  });

  it("surfaces a network error when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const err = await request<unknown>("/chat", { method: "POST", body: "{}" }).catch(
      (e: unknown) => e
    );

    expect(err).toMatchObject({
      status: 0,
      message: "Network error. Check your connection."
    });
  });
});

describe("request timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("aborts a hung request and surfaces a timeout error", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = request<unknown>("/chat", { method: "POST", body: "{}" });
    const assertion = expect(promise).rejects.toMatchObject({
      status: 0,
      message: "The request timed out. Please try again."
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    await assertion;

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
  });
});

describe("requestStream", () => {
  it("yields each SSE data event in order", async () => {
    const events = [
      { type: "chunk", content: "Hello" },
      { type: "chunk", content: " world" },
      { type: "usage", usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } }
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(sseBody(events), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
      )
    );

    const out = await collect(requestStream("/chat/stream", { method: "POST", body: "{}" }));

    expect(out).toEqual(events);
  });

  it("buffers an SSE event that is split across multiple reads", async () => {
    const encoder = new TextEncoder();
    const partial = `data: {"type":"chunk","conte`;
    const rest = `nt":"hello"}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(partial));
        controller.enqueue(encoder.encode(rest));
        controller.close();
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
      )
    );

    const out = await collect(requestStream("/chat/stream", { method: "POST", body: "{}" }));

    expect(out).toEqual([{ type: "chunk", content: "hello" }]);
  });

  it("surfaces validation detail and the attempt log on a non-ok response", async () => {
    const attempts = [
      {
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        attempt: 1,
        status: "failed",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        response_time_ms: 5,
        timestamp: 1
      }
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            detail: "Empty chat message.",
            attempts
          }),
          { status: 422, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const err = await collect(requestStream("/chat/stream", { method: "POST", body: "{}" })).catch(
      (e: unknown) => e
    );

    expect(err).toMatchObject({ status: 422, message: "Empty chat message." });
    expect((err as { attempts?: unknown }).attempts).toEqual(attempts);
  });

  it("aborts when no bytes arrive for the stall timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          });
        },
        pull() {
          // Enqueue nothing: the stream never delivers a byte.
        }
      });
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const gen = requestStream("/chat/stream", { method: "POST", body: "{}" });
    const assertion = gen.next().then(
      () => {
        throw new Error("expected a rejection");
      },
      (e: unknown) => e
    );

    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS);
    const err = await assertion;

    expect(err).toMatchObject({
      status: 0,
      message: "The request timed out. Please try again."
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal?.aborted).toBe(true);
  });

  it("surfaces an interrupted stream as a connection error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException("Broken pipe", "NetworkError"));
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        })
      )
    );

    const err = await collect(requestStream("/chat/stream", { method: "POST", body: "{}" })).catch(
      (e: unknown) => e
    );

    expect(err).toMatchObject({
      status: 0,
      message: "The connection was interrupted."
    });
  });

  it("surfaces a network error when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const err = await collect(requestStream("/chat/stream", { method: "POST", body: "{}" })).catch(
      (e: unknown) => e
    );

    expect(err).toMatchObject({
      status: 0,
      message: "Network error. Check your connection."
    });
  });
});