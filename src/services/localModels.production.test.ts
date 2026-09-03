import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isProductionWeb, isDesktop, isLocalDev, getLocalModelProductionMessage } from "@/types/localModels";
import { testLocalEndpoint, streamLocalChat } from "@/services/localModels";

describe("production vs local routing", () => {
  const originalWindow = global.window;
  afterEach(() => {
    vi.restoreAllMocks();
    global.window = originalWindow as unknown as Window & typeof globalThis;
  });

  it("isLocalDev true for http://localhost:3000", () => {
    // @ts-expect-error jsdom
    global.window = { location: { hostname: "localhost", protocol: "http:" } } as unknown as Window;
    expect(isLocalDev()).toBe(true);
    expect(isProductionWeb()).toBe(false);
  });

  it("isProductionWeb true for https://www.nexuss.in", () => {
    // @ts-expect-error
    global.window = { location: { hostname: "www.nexuss.in", protocol: "https:" } } as unknown as Window;
    expect(isProductionWeb()).toBe(true);
    expect(isLocalDev()).toBe(false);
  });

  it("isProductionWeb false for http://localhost:3000", () => {
    // @ts-expect-error
    global.window = { location: { hostname: "localhost", protocol: "http:" } } as unknown as Window;
    expect(isProductionWeb()).toBe(false);
  });

  it("isDesktop true when window.nexussDesktop exists", () => {
    // @ts-expect-error
    global.window = { location: { hostname: "www.nexuss.in", protocol: "https:" }, nexussDesktop: {} } as unknown as Window;
    expect(isDesktop()).toBe(true);
    expect(isProductionWeb()).toBe(false); // desktop overrides production
  });

  it("testLocalEndpoint in production returns production message without fetching", async () => {
    // @ts-expect-error
    global.window = { location: { hostname: "www.nexuss.in", protocol: "https:" } } as unknown as Window;
    global.fetch = vi.fn() as unknown as typeof fetch;
    const res = await testLocalEndpoint("http://localhost:11434/v1", "ollama");
    expect(res.ok).toBe(false);
    expect(res.message).toBe(getLocalModelProductionMessage());
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("testLocalEndpoint in local dev still fetches", async () => {
    // @ts-expect-error
    global.window = { location: { hostname: "localhost", protocol: "http:" } } as unknown as Window;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "qwen2.5:3b" }] }),
    } as unknown as Response);
    const res = await testLocalEndpoint("http://localhost:11434/v1", "ollama");
    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalled();
  });

  it("streamLocalChat in production throws production message", async () => {
    // @ts-expect-error
    global.window = { location: { hostname: "www.nexuss.in", protocol: "https:" } } as unknown as Window;
    const stream = streamLocalChat({
      endpoint: "http://localhost:11434/v1",
      modelId: "qwen2.5:3b",
      messages: [{ role: "user", content: "hi" }],
    });
    await expect(stream.next()).rejects.toThrow(getLocalModelProductionMessage());
  });

  it("streamLocalChat in local dev fetches", async () => {
    // @ts-expect-error
    global.window = { location: { hostname: "localhost", protocol: "http:" } } as unknown as Window;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          releaseLock: () => {},
        }),
      },
    } as unknown as Response);
    const stream = streamLocalChat({
      endpoint: "http://localhost:11434/v1",
      modelId: "qwen2.5:3b",
      messages: [{ role: "user", content: "hi" }],
    });
    const result = await stream.next();
    // Should not throw production message, should try fetch and yield done
    expect(result.done).toBe(false);
  });
});
