import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useTerminalConnectionStore,
  isTerminalConnected,
  markUnavailable,
  toUserFacingTerminalError,
  resetTerminalConnection
} from "@/workspace/terminalConnection";
import { probeLocalConnector } from "@/workspace/localTerminalRuntime";
import { useWorkspaceStore } from "@/workspace/store";

function healthOk() {
  return new Response(JSON.stringify({ status: "ok", connector: "nexuss-local", terminal: "enabled" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/** Connection refusal / browser network failure. */
function stubHealthRefused() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    })
  );
}

/** Request aborted by the health-check timeout. */
function stubHealthTimeout() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    })
  );
}

function stubHealthOk() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => healthOk())
  );
}

function stubPermissions(state: "granted" | "denied" | "prompt") {
  Object.defineProperty(window.navigator, "permissions", {
    configurable: true,
    value: { query: vi.fn(async () => ({ state })) }
  });
}

function clearPermissions() {
  delete (window.navigator as unknown as { permissions?: unknown }).permissions;
}

const store = () => useTerminalConnectionStore.getState();

beforeEach(() => {
  resetTerminalConnection();
  clearPermissions();
  useWorkspaceStore.setState({
    runtime: null,
    pathEnabled: false,
    pendingCommand: null,
    runningCommand: false,
    lastCommandResult: null,
    commandError: null
  });
});

afterEach(() => {
  resetTerminalConnection();
  clearPermissions();
  vi.unstubAllGlobals();
});

describe("probeLocalConnector()", () => {
  it("accepts a valid health contract", async () => {
    stubHealthOk();
    const probe = await probeLocalConnector({ force: true });
    expect(probe.ok).toBe(true);
  });

  it("classifies a connection refusal as unreachable", async () => {
    stubHealthRefused();
    const probe = await probeLocalConnector({ force: true });
    expect(probe).toEqual({ ok: false, reason: "unreachable" });
  });

  it("classifies an aborted request as timeout", async () => {
    stubHealthTimeout();
    const probe = await probeLocalConnector({ force: true });
    expect(probe).toEqual({ ok: false, reason: "timeout" });
  });

  it("classifies a denied local-network permission as permission", async () => {
    stubPermissions("denied");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const probe = await probeLocalConnector({ force: true });
    expect(probe).toEqual({ ok: false, reason: "permission" });
    // The browser would block the request anyway — no pointless network call.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies a denied permission revealed after a network failure as permission", async () => {
    let calls = 0;
    Object.defineProperty(window.navigator, "permissions", {
      configurable: true,
      value: {
        query: vi.fn(async () => {
          calls += 1;
          return { state: calls === 1 ? "prompt" : "denied" };
        })
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const probe = await probeLocalConnector({ force: true });
    expect(probe).toEqual({ ok: false, reason: "permission" });
  });

  it("classifies a 200 response with an unexpected body as invalid-response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ hello: "world" }), { status: 200 }))
    );
    const probe = await probeLocalConnector({ force: true });
    expect(probe).toEqual({ ok: false, reason: "invalid-response" });
  });

  it("classifies a non-200 health response as http-error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    );
    const probe = await probeLocalConnector({ force: true });
    expect(probe).toEqual({ ok: false, reason: "http-error", httpStatus: 500 });
  });
});

describe("connect()", () => {
  it("reports connected only after health and capability verification", async () => {
    stubHealthOk();
    const ok = await store().connect();
    expect(ok).toBe(true);
    expect(store().status).toBe("connected");
    expect(store().failureReason).toBeNull();
    expect(store().justConnected).toBe(true);
    expect(store().lastVerifiedAt).not.toBeNull();
    expect(isTerminalConnected()).toBe(true);
    // A verified connection enables the terminal capability for the session.
    expect(useWorkspaceStore.getState().pathEnabled).toBe(true);
    expect(useWorkspaceStore.getState().runtime).toBeTruthy();
  });

  it("reports unavailable instead of faking a connection when the connector refuses", async () => {
    stubHealthRefused();
    const ok = await store().connect();
    expect(ok).toBe(false);
    expect(store().status).toBe("unavailable");
    expect(store().failureReason).toBe("unreachable");
    expect(store().lastVerifiedAt).toBeNull();
    expect(isTerminalConnected()).toBe(false);
    expect(useWorkspaceStore.getState().pathEnabled).toBe(false);
    expect(useWorkspaceStore.getState().runtime).toBeNull();
  });

  it("reports unavailable with a timeout reason when the health check times out", async () => {
    stubHealthTimeout();
    const ok = await store().connect();
    expect(ok).toBe(false);
    expect(store().status).toBe("unavailable");
    expect(store().failureReason).toBe("timeout");
    expect(isTerminalConnected()).toBe(false);
  });

  it("reports permission_required when the browser blocks local-network access", async () => {
    stubPermissions("denied");
    vi.stubGlobal("fetch", vi.fn());
    const ok = await store().connect();
    expect(ok).toBe(false);
    expect(store().status).toBe("permission_required");
    expect(store().failureReason).toBe("permission");
    expect(isTerminalConnected()).toBe(false);
  });

  it("reports error for an unexpected health-check response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }))
    );
    const ok = await store().connect();
    expect(ok).toBe(false);
    expect(store().status).toBe("error");
    expect(store().failureReason).toBe("invalid-response");
    expect(isTerminalConnected()).toBe(false);
  });

  it("deduplicates repeated clicks while a connection attempt is in flight", async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = store().connect();
    // The second click joins the in-flight attempt instead of starting a new one.
    const second = store().connect();
    expect(store().status).toBe("connecting");

    // Wait until the shared probe has actually issued the request.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(resolveFetch).not.toBeNull();
    resolveFetch!(healthOk());

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store().status).toBe("connected");
  });
});

describe("checkConnection()", () => {
  it("auto-verifies an already running connector without a user gesture", async () => {
    stubHealthOk();
    const status = await store().checkConnection();
    expect(status).toBe("connected");
    expect(store().justConnected).toBe(false);
    expect(isTerminalConnected()).toBe(true);
  });

  it("keeps the previous state when passive verification fails", async () => {
    stubHealthRefused();
    const status = await store().checkConnection();
    expect(status).toBe("disconnected");
    expect(store().status).toBe("disconnected");
  });

  it("detects a stopped connector while connected", async () => {
    stubHealthOk();
    await store().connect();
    expect(store().status).toBe("connected");

    stubHealthRefused();
    await store().checkConnection();
    expect(store().status).toBe("unavailable");
    expect(isTerminalConnected()).toBe(false);
  });

  it("does not auto-connect after an explicit user disconnect", async () => {
    stubHealthOk();
    await store().connect();
    await store().disconnect();
    expect(store().status).toBe("disconnected");

    // The connector is reachable, but the session disconnect must be respected.
    const status = await store().checkConnection();
    expect(status).toBe("disconnected");
    expect(store().status).toBe("disconnected");
  });
});

describe("disconnect()", () => {
  it("disables terminal access for the session without touching the connector", async () => {
    stubHealthOk();
    await store().connect();

    await store().disconnect();

    expect(store().status).toBe("disconnected");
    expect(window.sessionStorage.getItem("nexuss.terminal.disconnected")).toBe("1");
    expect(useWorkspaceStore.getState().runtime).toBeNull();
    expect(useWorkspaceStore.getState().pathEnabled).toBe(false);
  });
});

describe("markUnavailable()", () => {
  it("flips a connected session to unavailable", async () => {
    stubHealthOk();
    await store().connect();

    markUnavailable("terminal run failed");

    expect(store().status).toBe("unavailable");
    expect(store().failureReason).toBe("unreachable");
    expect(store().lastVerifiedAt).toBeNull();
    expect(isTerminalConnected()).toBe(false);
  });

  it("does not change a disconnected state", () => {
    markUnavailable("whatever");
    expect(store().status).toBe("disconnected");
  });
});

describe("toUserFacingTerminalError()", () => {
  it("hides technical connector details from the UI", () => {
    const safe = toUserFacingTerminalError(
      "NETWORK_ERROR: Cannot reach local terminal connector at http://127.0.0.1:11435 — ECONNREFUSED, run node local-connector/server.js (CORS)"
    );
    expect(safe).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|11435|CORS|local-connector/);
    expect(safe).toContain("connect to your terminal");
  });

  it("passes non-technical messages through unchanged", () => {
    expect(toUserFacingTerminalError("Access denied by policy.")).toBe("Access denied by policy.");
  });
});

describe("resetTerminalConnection()", () => {
  it("clears the state and the session disconnect flag", async () => {
    stubHealthOk();
    await store().connect();

    resetTerminalConnection();

    expect(store().status).toBe("disconnected");
    expect(store().failureReason).toBeNull();
    expect(store().lastVerifiedAt).toBeNull();
    expect(window.sessionStorage.getItem("nexuss.terminal.disconnected")).toBeNull();
  });
});
