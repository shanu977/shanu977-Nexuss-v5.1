import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateEndpoint, normalizeEndpoint } from "@/types/localModels";
import { testLocalEndpoint } from "@/services/localModels";

describe("localModels service - validation", () => {
  it("validates endpoint required", () => {
    expect(validateEndpoint("")).toBe("Endpoint is required.");
    expect(validateEndpoint("not a url")).toBeTruthy();
  });
  it("normalizes Ollama bare host to /v1", () => {
    expect(normalizeEndpoint("http://localhost:11434", "ollama")).toBe("http://localhost:11434/v1");
    expect(normalizeEndpoint("http://localhost:11434/", "ollama")).toBe("http://localhost:11434/v1");
    expect(normalizeEndpoint("http://localhost:11434/v1", "ollama")).toBe("http://localhost:11434/v1");
  });
  it("normalizes generic endpoint", () => {
    expect(normalizeEndpoint("http://localhost:1234/v1", "lmstudio")).toBe("http://localhost:1234/v1");
    expect(normalizeEndpoint("localhost:8000", "generic")).toBe("http://localhost:8000/v1");
  });
  it("blocks metadata endpoint", () => {
    expect(validateEndpoint("http://169.254.169.254/v1")).toBe("Endpoint host is not allowed.");
  });
});

describe("localModels service - testLocalEndpoint", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("discovery success returns models", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "llama3.2:3b" }, { id: "qwen2.5:7b" }] }),
    } as unknown as Response);
    const res = await testLocalEndpoint("http://localhost:11434/v1", "ollama");
    expect(res.ok).toBe(true);
    expect(res.models).toEqual(["llama3.2:3b", "qwen2.5:7b"]);
    expect(res.endpointReachable).toBe(true);
  });

  it("discovery 404 returns reachable but not discoverable", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    } as unknown as Response);
    const res = await testLocalEndpoint("http://localhost:11434/v1", "ollama");
    expect(res.ok).toBe(true);
    expect(res.endpointReachable).toBe(true);
    expect(res.modelsDiscoverable).toBe(false);
  });

  it("connection refused returns not reachable", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const res = await testLocalEndpoint("http://localhost:11434/v1", "ollama");
    expect(res.ok).toBe(false);
    expect(res.endpointReachable).toBe(false);
    expect(res.message).toContain("Cannot connect");
  });

  it("401 returns auth error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as unknown as Response);
    const res = await testLocalEndpoint("http://localhost:8000/v1", "generic", "badkey");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("401");
  });
});
