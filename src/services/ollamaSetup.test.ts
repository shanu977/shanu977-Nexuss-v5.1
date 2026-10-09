import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectOllamaSetup,
  verifyLocalChat,
  fetchConnectorOllamaStatus,
  unknownReasonCopy,
  friendlySetupError,
} from "@/services/ollamaSetup";

const mocks = vi.hoisted(() => ({
  connectorAvailable: vi.fn(),
  discover: vi.fn(),
  streamLocalChat: vi.fn(),
  timeoutFetch: vi.fn(),
}));

vi.mock("@/workspace/localTerminalRuntime", () => ({
  isLocalConnectorAvailable: mocks.connectorAvailable,
}));

vi.mock("@/services/localModels", () => ({
  discoverOllamaModelsDetailed: mocks.discover,
  probeLocalConnectorFresh: () => mocks.connectorAvailable({ force: true }),
  streamLocalChat: mocks.streamLocalChat,
  timeoutFetch: mocks.timeoutFetch,
}));

function model(id: string) {
  return { id, modelId: id };
}

beforeEach(() => {
  mocks.connectorAvailable.mockResolvedValue(false);
  mocks.discover.mockReset();
  mocks.streamLocalChat.mockReset();
  mocks.timeoutFetch.mockReset();
});

describe("detectOllamaSetup — honest classification", () => {
  it("uses the default Ollama endpoint when discovery runs through the connector", async () => {
    mocks.connectorAvailable.mockResolvedValue(true);
    mocks.timeoutFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ollama: { installed: true, running: true } }),
    });
    mocks.discover.mockResolvedValue({ models: [model("qwen3:4b")], endpointReachable: true });

    const d = await detectOllamaSetup();

    expect(d.state).toBe("models");
    expect(d.via).toBe("connector");
    expect(d.models?.[0].modelId).toBe("qwen3:4b");
    expect(mocks.connectorAvailable).toHaveBeenCalledWith({ force: true });
    expect(mocks.discover).toHaveBeenCalledWith("http://localhost:11434/v1", "ollama", undefined);
  });

  it("reports no_models when Ollama runs with an empty model list", async () => {
    mocks.connectorAvailable.mockResolvedValue(true);
    mocks.timeoutFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ollama: { installed: true, running: true } }),
    });
    mocks.discover.mockResolvedValue({ models: [], endpointReachable: true });

    const d = await detectOllamaSetup();
    expect(d.state).toBe("no_models");
  });

  it("reports stopped when the connector knows Ollama is installed but not running", async () => {
    mocks.connectorAvailable.mockResolvedValue(true);
    mocks.timeoutFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ollama: { installed: true, running: false } }),
    });

    const d = await detectOllamaSetup();
    expect(d.state).toBe("stopped");
    expect(d.installed).toBe(true);
    expect(mocks.discover).not.toHaveBeenCalled();
  });

  it("reports not_installed only when a trustworthy source says so", async () => {
    mocks.connectorAvailable.mockResolvedValue(true);
    mocks.timeoutFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ollama: { installed: false, running: false } }),
    });

    const d = await detectOllamaSetup();
    expect(d.state).toBe("not_installed");
  });

  it("falls back to a direct probe when the connector is down", async () => {
    mocks.connectorAvailable.mockResolvedValue(false);
    mocks.discover.mockResolvedValue({ models: [model("llama3.2:3b")], endpointReachable: true });

    const d = await detectOllamaSetup();
    expect(d.state).toBe("models");
    expect(d.via).toBe("direct");
  });

  it("classifies a blocked browser probe as unknown, never as not_installed", async () => {
    mocks.connectorAvailable.mockResolvedValue(false);
    mocks.discover.mockRejectedValue(new TypeError("Failed to fetch"));

    const d = await detectOllamaSetup();
    expect(d.state).toBe("unknown");
    expect(d.reason).toBe("blocked");
  });

  it("classifies timeouts as unknown with a timeout reason", async () => {
    mocks.connectorAvailable.mockResolvedValue(false);
    const abortErr = new Error("The operation was aborted.");
    abortErr.name = "AbortError";
    mocks.discover.mockRejectedValue(abortErr);

    const d = await detectOllamaSetup();
    expect(d.state).toBe("unknown");
    expect(d.reason).toBe("timeout");
  });

  it("reports unknown when the connector is up but nothing answers", async () => {
    mocks.connectorAvailable.mockResolvedValue(true);
    mocks.timeoutFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    mocks.discover.mockResolvedValue({ models: [], endpointReachable: false });

    const d = await detectOllamaSetup();
    expect(d.state).toBe("unknown");
    expect(d.reason).toBe("connector_unreachable");
  });
});

describe("fetchConnectorOllamaStatus", () => {
  it("parses the connector's server-side status", async () => {
    mocks.timeoutFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ollama: { installed: true, running: false, version: "0.1.0" } }),
    });
    expect(await fetchConnectorOllamaStatus()).toEqual({ installed: true, running: false });
  });

  it("returns null for unreachable or malformed responses instead of guessing", async () => {
    mocks.timeoutFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await fetchConnectorOllamaStatus()).toBeNull();

    mocks.timeoutFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    expect(await fetchConnectorOllamaStatus()).toBeNull();

    mocks.timeoutFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    expect(await fetchConnectorOllamaStatus()).toBeNull();
  });
});

describe("verifyLocalChat — the only path to a Ready state", () => {
  it("succeeds only when the model actually replies", async () => {
    mocks.streamLocalChat.mockImplementation(async function* () {
      yield { type: "chunk", content: "OK" };
      yield { type: "done" };
    });

    const v = await verifyLocalChat("http://localhost:11434/v1", "qwen3:4b");
    expect(v.ok).toBe(true);

    const params = mocks.streamLocalChat.mock.calls[0][0];
    expect(params.endpoint).toBe("http://localhost:11434/v1");
    expect(params.modelId).toBe("qwen3:4b");
    expect(params.numPredict).toBeLessThanOrEqual(32);
    expect(params.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails when the stream produces no output", async () => {
    mocks.streamLocalChat.mockImplementation(async function* () {
      // no chunks
    });
    const v = await verifyLocalChat("http://localhost:11434/v1", "qwen3:4b");
    expect(v.ok).toBe(false);
    expect(v.message).toBeTruthy();
  });

  it("fails with a user-safe message on transport errors", async () => {
    mocks.streamLocalChat.mockImplementation(async function* () {
      throw new TypeError("Failed to fetch");
    });
    const v = await verifyLocalChat("http://localhost:11434/v1", "qwen3:4b");
    expect(v.ok).toBe(false);
    expect(v.message).not.toMatch(/Failed to fetch|TypeError/);
  });
});

describe("friendly copy helpers", () => {
  it("keeps unknown-state copy honest", () => {
    expect(unknownReasonCopy("connector_unreachable")).toMatch(/reach Ollama/i);
    expect(unknownReasonCopy("timeout")).toMatch(/timed out/i);
    expect(unknownReasonCopy(undefined)).toBeTruthy();
  });

  it("translates raw transport errors into safe messages", () => {
    expect(friendlySetupError(new TypeError("Failed to fetch"))).toMatch(/Couldn't reach Ollama/);
    expect(friendlySetupError(new Error("The operation was aborted"))).toMatch(/timed out/);
    expect(friendlySetupError(new Error("model 'x' not found"))).toMatch(/isn't available|not found/i);
  });
});
