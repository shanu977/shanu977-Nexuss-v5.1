import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "@/services/api";

const mocks = vi.hoisted(() => ({
  firebaseMock: {
    auth: { currentUser: null }
  }
}));

vi.mock("@/lib/firebase", () => mocks.firebaseMock);

const DEFAULT_TIMEOUT_MS = 120_000;

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