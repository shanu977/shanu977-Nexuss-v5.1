import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pullOllamaModel,
  cancelOllamaPull,
  activeOllamaPullModel,
  isPullCancelled,
  PullCancelledError,
} from "@/services/localModels";

const mocks = vi.hoisted(() => ({
  connectorAvailable: vi.fn(async () => false),
}));

vi.mock("@/workspace/localTerminalRuntime", () => ({
  isLocalConnectorAvailable: mocks.connectorAvailable,
}));

const encoder = new TextEncoder();

function abortError(): Error {
  const e = new Error("The operation was aborted.");
  e.name = "AbortError";
  return e;
}

function ndjsonBody(lines: unknown[]): ReadableStream<Uint8Array> {
  const queue = lines.map((line) => encoder.encode(`${JSON.stringify(line)}\n`));
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= queue.length) {
        controller.close();
        return;
      }
      controller.enqueue(queue[i++]);
    },
  });
}

function okResponse(lines: unknown[]): Response {
  return new Response(ndjsonBody(lines), { status: 200 });
}

function hangingResponse(signal: AbortSignal | null | undefined): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => {
          try {
            controller.error(abortError());
          } catch {
            // already closed
          }
        });
      },
      // Never produce data: the reader hangs until the signal aborts.
      pull() {
        return new Promise<never>(() => {});
      },
    }),
    { status: 200 }
  );
}

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  mocks.connectorAvailable.mockResolvedValue(false);
  fetchMock.mockReset();
});

afterEach(() => {
  cancelOllamaPull();
});

describe("pullOllamaModel — web download with real progress", () => {
  it("rejects invalid model ids before touching the network", async () => {
    await expect(pullOllamaModel("bad model; rm -rf")).rejects.toThrow(/isn't valid/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams real NDJSON progress (bytes, percent) and finishes on success", async () => {
    // Deterministic clock so the measured download speed is stable.
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValueOnce(1_000).mockReturnValueOnce(2_000).mockReturnValue(2_000);
    fetchMock.mockResolvedValue(
      okResponse([
        { status: "pulling manifest" },
        { status: "downloading", total: 1000, completed: 250 },
        { status: "downloading", total: 1000, completed: 500 },
        { status: "success" },
      ])
    );

    const events: Array<{ percent?: number; bytesPerSecond?: number; status: string }> = [];
    const result = await pullOllamaModel("qwen2.5:3b", (p) =>
      events.push({ percent: p.percent, bytesPerSecond: p.bytesPerSecond, status: p.status })
    );
    nowSpy.mockRestore();

    expect(result.modelId).toBe("qwen2.5:3b");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/pull",
      expect.objectContaining({ method: "POST" })
    );

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ model: "qwen2.5:3b", stream: true });

    const downloading = events.find((e) => e.status === "downloading" && e.percent === 50);
    expect(downloading).toBeTruthy();
    expect(downloading?.bytesPerSecond).toBe(250);
    expect(events.some((e) => e.status === "success")).toBe(true);
  });

  it("prefers the local connector when it is running", async () => {
    mocks.connectorAvailable.mockResolvedValue(true);
    fetchMock.mockResolvedValue(okResponse([{ status: "success" }]));

    await pullOllamaModel("llama3.2:3b");

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:11435/api/pull");
    expect(mocks.connectorAvailable).toHaveBeenCalledWith({ force: true });
  });

  it("never reports fake percentages when the registry sends no totals", async () => {
    fetchMock.mockResolvedValue(
      okResponse([{ status: "pulling manifest" }, { status: "success" }])
    );

    const percents: Array<number | undefined> = [];
    await pullOllamaModel("qwen2.5:3b", (p) => percents.push(p.percent));

    expect(percents.every((p) => p === undefined)).toBe(true);
  });

  it("maps a registry miss to a friendly error", async () => {
    fetchMock.mockResolvedValue(
      okResponse([{ error: "pull model manifest: file does not exist" }])
    );
    await expect(pullOllamaModel("nope:1b")).rejects.toThrow(/wasn't found in the Ollama registry/);
  });

  it("maps HTTP 404 to a friendly error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: "model not found" }),
    } as unknown as Response);
    await expect(pullOllamaModel("nope:1b")).rejects.toThrow(/wasn't found in the Ollama registry/);
  });

  it("cancels an in-flight download through the shared controller", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(hangingResponse(init?.signal))
    );

    const first = pullOllamaModel("qwen2.5:3b");
    // Let the fetch start, then cancel from the UI layer.
    await new Promise((r) => setTimeout(r, 0));
    expect(activeOllamaPullModel()).toBe("qwen2.5:3b");
    cancelOllamaPull();

    const err = await first.catch((e: unknown) => e);
    expect(isPullCancelled(err)).toBe(true);
    expect(err).toBeInstanceOf(PullCancelledError);
    expect(activeOllamaPullModel()).toBeNull();
  });

  it("guards against duplicate downloads of different models", async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(hangingResponse(init?.signal))
    );

    const first = pullOllamaModel("qwen2.5:3b");
    await new Promise((r) => setTimeout(r, 0));

    await expect(pullOllamaModel("llama3.1:8b")).rejects.toThrow(/Another model download/);

    cancelOllamaPull();
    await expect(first).rejects.toSatisfy(isPullCancelled);
  });
});
