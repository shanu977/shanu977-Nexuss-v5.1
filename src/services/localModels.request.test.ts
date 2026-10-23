import { describe, it, expect, vi, afterEach } from "vitest";
import {
  streamLocalChat,
  DEFAULT_LOCAL_NUM_PREDICT,
  DEFAULT_LOCAL_REPEAT_PENALTY,
} from "@/services/localModels";

function mockStreamResponse() {
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => ({ done: true, value: undefined }),
        releaseLock: () => {},
      }),
    },
  } as unknown as Response;
}

async function drain(endpoint: string, extra: Record<string, unknown> = {}) {
  const stream = streamLocalChat({
    endpoint,
    modelId: "qwen2.5-coder:7b",
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });
  for await (const _ of stream) {
    // drain
  }
}

function chatCall(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.find(([url]) =>
    String(url).includes("/chat/completions")
  );
  expect(call, "expected a /chat/completions request").toBeTruthy();
  return call as [string, RequestInit];
}

describe("local chat request body (generation options regression)", () => {
  const originalWindow = global.window;
  afterEach(() => {
    vi.restoreAllMocks();
    global.window = originalWindow as unknown as Window & typeof globalThis;
  });

  it("sends explicit repeat_penalty and num_predict defaults", async () => {
    // @ts-expect-error -- mock window for test
    global.window = { location: { hostname: "localhost", protocol: "http:" } } as unknown as Window;
    const fetchMock = vi.fn().mockResolvedValue(mockStreamResponse());
    global.fetch = fetchMock;

    await drain("http://localhost:11434/v1");

    expect(fetchMock).toHaveBeenCalled();
    const [, init] = chatCall(fetchMock);
    const body = JSON.parse(String(init.body));
    expect(body.options.repeat_penalty).toBe(DEFAULT_LOCAL_REPEAT_PENALTY);
    expect(body.options.repeat_penalty).toBe(1.1);
    expect(body.options.num_predict).toBe(DEFAULT_LOCAL_NUM_PREDICT);
    expect(body.options.num_predict).toBe(1024);
    expect(body.options.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(DEFAULT_LOCAL_NUM_PREDICT);
    expect(body.stream).toBe(true);
  });

  it("keeps max_tokens in lockstep with a custom numPredict", async () => {
    // @ts-expect-error -- mock window for test
    global.window = { location: { hostname: "localhost", protocol: "http:" } } as unknown as Window;
    const fetchMock = vi.fn().mockResolvedValue(mockStreamResponse());
    global.fetch = fetchMock;

    await drain("http://localhost:11434/v1", { numPredict: 512 });

    const [, init] = chatCall(fetchMock);
    const body = JSON.parse(String(init.body));
    expect(body.options.num_predict).toBe(512);
    expect(body.max_tokens).toBe(512);
  });

  it("honours an explicit repeatPenalty override", async () => {
    // @ts-expect-error -- mock window for test
    global.window = { location: { hostname: "localhost", protocol: "http:" } } as unknown as Window;
    const fetchMock = vi.fn().mockResolvedValue(mockStreamResponse());
    global.fetch = fetchMock;

    await drain("http://localhost:11434/v1", { repeatPenalty: 1.3 });

    const [, init] = chatCall(fetchMock);
    const body = JSON.parse(String(init.body));
    expect(body.options.repeat_penalty).toBe(1.3);
  });

  it("sends repeat_penalty on non-localhost endpoints too", async () => {
    // @ts-expect-error -- mock window for test
    global.window = { location: { hostname: "localhost", protocol: "http:" } } as unknown as Window;
    const fetchMock = vi.fn().mockResolvedValue(mockStreamResponse());
    global.fetch = fetchMock;

    await drain("http://192.168.1.10:11434/v1");

    const [, init] = chatCall(fetchMock);
    const body = JSON.parse(String(init.body));
    expect(body.options.repeat_penalty).toBe(1.1);
  });
});
