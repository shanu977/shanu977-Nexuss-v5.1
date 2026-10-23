import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useTerminalConnectionStore,
  isTerminalConnected,
  markUnavailable,
  toUserFacingTerminalError,
  resetTerminalConnection,
  runTerminalHeartbeatTick,
  runRecoveryMonitorTick,
  isRecoveryMonitorActive
} from "@/workspace/terminalConnection";
import { probeLocalConnector, createLocalConnectorRuntime } from "@/workspace/localTerminalRuntime";
import { useWorkspaceStore } from "@/workspace/store";
import { configureTerminalRecovery, DEFAULT_RECOVERY_CONFIG } from "@/workspace/terminalRecovery";
import { clearConnectorLauncherMemory, rememberConnectorProtocol } from "@/workspace/connectorProtocol";

// Deterministic platform for recovery branches (jsdom UA varies by host OS).
vi.mock("@/workspace/terminalSetup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/workspace/terminalSetup")>();
  return { ...actual, isWindowsPlatform: vi.fn(actual.isWindowsPlatform) };
});

import { isWindowsPlatform } from "@/workspace/terminalSetup";

function healthOk(protocol?: number) {
  return new Response(
    JSON.stringify({
      status: "ok",
      connector: "nexuss-local",
      ...(protocol !== undefined ? { protocol } : {}),
      terminal: "enabled"
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
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

/** Simulate a machine with a completed one-time install (launcher registered). */
function armVerifiedInstall() {
  window.localStorage.setItem("nexuss.terminal.setupVerified", "1");
  rememberConnectorProtocol(2);
}

beforeEach(() => {
  resetTerminalConnection();
  clearPermissions();
  clearConnectorLauncherMemory();
  vi.mocked(isWindowsPlatform).mockReturnValue(true);
  window.localStorage.removeItem("nexuss.terminal.setupVerified");
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
  clearConnectorLauncherMemory();
  configureTerminalRecovery(DEFAULT_RECOVERY_CONFIG);
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

  it("classifies an abort while the LNA permission prompt is pending as permission", async () => {
    // Production root cause: the fetch hangs behind the Chrome Local Network
    // Access prompt, so the abort fires while permission is still awaiting a
    // decision — that is NOT "connector not running".
    stubPermissions("prompt");
    stubHealthTimeout();
    const probe = await probeLocalConnector({ force: true });
    expect(probe).toEqual({ ok: false, reason: "permission" });
  });

  it("keeps an abort classified as timeout once permission is granted", async () => {
    stubPermissions("granted");
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

  it("captures the reported protocol and version on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => healthOk(2)));
    const probe = await probeLocalConnector({ force: true });
    expect(probe).toEqual({ ok: true, protocol: 2, version: undefined });
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
    const resolvers: Array<(r: Response) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = store().connect();
    // The second click joins the in-flight attempt instead of starting a new one.
    const second = store().connect();
    expect(store().status).toBe("connecting");

    // Wait until the shared probe has actually issued the request, then answer it.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 5000 });
    resolvers[0](healthOk());
    // A verified connection makes a second round trip for the capability
    // advertisement probe — answer it too, then both clicks resolve together.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 5000 });
    resolvers[1](healthOk());

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    // Exactly two real round trips per verified connection: health + capability.
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

describe("incompatible connector protocol", () => {
  it("refuses to report connected for an explicitly outdated protocol", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => healthOk(0)));
    const ok = await store().connect();
    expect(ok).toBe(false);
    expect(store().status).toBe("error");
    expect(store().failureReason).toBe("incompatible");
    expect(store().diagnosticCode).toBe("connector_incompatible");
    expect(isTerminalConnected()).toBe(false);
    expect(useWorkspaceStore.getState().pathEnabled).toBe(false);
  });

  it("still accepts a legacy connector with no protocol field", async () => {
    stubHealthOk();
    const ok = await store().connect();
    expect(ok).toBe(true);
    expect(store().status).toBe("connected");
  });
});

describe("beginSetup()", () => {
  it("enters the setup progress state and clears any disconnect flag", async () => {
    stubHealthOk();
    await store().connect();
    await store().disconnect();

    store().beginSetup();

    expect(store().status).toBe("setting_up");
    expect(window.sessionStorage.getItem("nexuss.terminal.disconnected")).toBeNull();
    expect(isTerminalConnected()).toBe(false);
  });

  it("lets an explicit connect take over from the setup state", async () => {
    store().beginSetup();
    stubHealthOk();
    const ok = await store().connect();
    expect(ok).toBe(true);
    expect(store().status).toBe("connected");
  });
});

describe("self-healing recovery", () => {
  let prevCfg: ReturnType<typeof configureTerminalRecovery>;
  beforeEach(() => {
    prevCfg = configureTerminalRecovery({ baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 3, jitterRatio: 0 });
  });
  afterEach(() => {
    configureTerminalRecovery(prevCfg);
  });

  it("recovers automatically after a transient failure on a verified install", async () => {
    armVerifiedInstall();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        // Exhaust the connect retries, then the connector comes back.
        if (calls <= 3) throw new TypeError("Failed to fetch");
        return healthOk(2);
      })
    );

    const ok = await store().connect();

    expect(ok).toBe(true);
    expect(store().status).toBe("connected");
    expect(store().failureReason).toBeNull();
    expect(store().diagnosticCode).toBeNull();
    expect(isTerminalConnected()).toBe(true);
  });

  it("falls back to the honest unavailable state when recovery is exhausted", async () => {
    armVerifiedInstall();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    const ok = await store().connect();

    expect(ok).toBe(false);
    expect(store().status).toBe("unavailable");
    expect(store().diagnosticCode).toBe("connector_stopped");
    expect(isTerminalConnected()).toBe(false);
  });

  it("does not start recovery on a machine without a verified install", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await store().connect();

    expect(ok).toBe(false);
    expect(store().status).toBe("unavailable");
    // Exactly the connect retries — no extra recovery probes.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops recovery and surfaces permission_required when Local Network Access is denied", async () => {
    armVerifiedInstall();
    let queries = 0;
    Object.defineProperty(window.navigator, "permissions", {
      configurable: true,
      value: {
        query: vi.fn(async () => {
          queries += 1;
          return { state: queries <= 6 ? "prompt" : "denied" };
        })
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    const ok = await store().connect();

    expect(ok).toBe(false);
    expect(store().status).toBe("permission_required");
    expect(store().failureReason).toBe("permission");
    expect(store().diagnosticCode).toBe("browser_permission_denied");
  });

  it("tolerates a single heartbeat miss and recovers on the second", async () => {
    armVerifiedInstall();
    stubHealthOk();
    await store().connect();
    expect(store().status).toBe("connected");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    await runTerminalHeartbeatTick();
    // One miss is transient — the session must survive it.
    expect(store().status).toBe("connected");

    await runTerminalHeartbeatTick();
    // Second confirmed miss: bounded recovery ran and exhausted honestly.
    expect(store().status).toBe("unavailable");
    expect(isTerminalConnected()).toBe(false);
  });

  it("restores a verified connection when the connector comes back mid-recovery", async () => {
    armVerifiedInstall();
    stubHealthOk();
    await store().connect();

    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls <= 1) throw new TypeError("Failed to fetch"); // first heartbeat miss
        if (calls <= 2) throw new TypeError("Failed to fetch"); // second miss → recovery
        if (calls <= 3) throw new TypeError("Failed to fetch"); // recovery first probe
        return healthOk(2); // connector back
      })
    );

    await runTerminalHeartbeatTick();
    expect(store().status).toBe("connected");
    await runTerminalHeartbeatTick();

    expect(store().status).toBe("connected");
    expect(store().lastVerifiedAt).not.toBeNull();
    expect(isTerminalConnected()).toBe(true);
  });

  it("deduplicates concurrent recovery attempts into one session", async () => {
    armVerifiedInstall();
    const probeMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", probeMock);

    const [a, b] = await Promise.all([store().recover("test-a"), store().recover("test-b")]);

    expect(a).toBe(false);
    expect(b).toBe(false);
    expect(store().status).toBe("unavailable");
    // One session: bounded probe count (checking + backoff retries), not doubled.
    expect(probeMock.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("cancelRecovery stops an in-flight session and shows the failure screen", async () => {
    // Slower backoff so the session is still on screen when we cancel.
    configureTerminalRecovery({ baseDelayMs: 50, maxDelayMs: 100, maxAttempts: 5, jitterRatio: 0 });
    armVerifiedInstall();
    stubHealthOk();
    await store().connect();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    await runTerminalHeartbeatTick(); // miss 1 (tolerated)
    expect(store().status).toBe("connected");

    const tick = runTerminalHeartbeatTick(); // miss 2 → recovery session
    await vi.waitFor(() => expect(store().status).toBe("recovering"), { timeout: 2000 });
    store().cancelRecovery();
    await tick;

    expect(store().status).toBe("unavailable");
    expect(store().recoveryStep).toBeNull();
    expect(isTerminalConnected()).toBe(false);
  });

  it("rejects a stale connect response that resolves after a disconnect", async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const connecting = store().connect();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 5000 });

    await store().disconnect();
    resolveFetch!(healthOk(2));

    const ok = await connecting;
    expect(ok).toBe(false);
    expect(store().status).toBe("disconnected");
    expect(isTerminalConnected()).toBe(false);
    expect(useWorkspaceStore.getState().pathEnabled).toBe(false);
  });

  it("commands stay blocked while recovering", async () => {
    armVerifiedInstall();
    stubHealthOk();
    await store().connect();

    useTerminalConnectionStore.setState({ status: "recovering", recoveryStep: "restarting" });
    expect(isTerminalConnected()).toBe(false);
  });
});

describe("operation failures route into recovery (RC1)", () => {
  beforeEach(() => {
    configureTerminalRecovery({ baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 3, jitterRatio: 0 });
  });

  it("recovers the session automatically when the connector returns after a transient command failure", async () => {
    armVerifiedInstall();
    stubHealthOk();
    await store().connect();
    expect(store().status).toBe("connected");

    // A real terminal operation fails (transport error), then the connector comes back.
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls <= 3) throw new TypeError("Failed to fetch");
        return healthOk(2);
      })
    );

    markUnavailable("NETWORK_ERROR: Cannot reach the local terminal connector, so nothing was executed.");

    // The old code dead-ended here (unavailable forever, heartbeat stopped).
    // The fixed flow probes (recovery ran) and lands back on a verified connection.
    await vi.waitFor(() => expect(store().status).toBe("connected"), { timeout: 5000 });
    expect(isTerminalConnected()).toBe(true);
    expect(calls).toBeGreaterThan(3);
    expect(store().failureReason).toBeNull();
    expect(useWorkspaceStore.getState().pathEnabled).toBe(true);
  });

  it("falls back to the honest unavailable screen when recovery cannot repair the failure", async () => {
    armVerifiedInstall();
    stubHealthOk();
    await store().connect();
    expect(store().status).toBe("connected");

    stubHealthRefused();
    markUnavailable("ECONNREFUSED 127.0.0.1:11435 — connection lost");

    await vi.waitFor(() => expect(store().status).toBe("unavailable"), { timeout: 5000 });
    expect(isTerminalConnected()).toBe(false);
    // The session ends honestly: either the trigger detail or the exhaustion
    // outcome is recorded for developers — never a fake connected state.
    expect(store().lastError).toMatch(/terminal operation failed|recovery exhausted/);
    // Even after exhaustion the watcher is armed — a later connector restart is noticed.
    expect(isRecoveryMonitorActive()).toBe(true);
  });

  it("keeps a policy refusal on the dead end — no probes, no auto-recovery", async () => {
    armVerifiedInstall();
    stubHealthOk();
    await store().connect();
    expect(store().status).toBe("connected");

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    markUnavailable("403: Origin http://evil.example not allowed.");

    expect(store().status).toBe("unavailable");
    await new Promise((r) => setTimeout(r, 50));
    // A security refusal must never be "recovered" by retry loops.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store().lastError).toMatch(/terminal operation failed|connector unavailable|403/);
  });

  it("does not act on a session that is no longer connected", () => {
    markUnavailable("NETWORK_ERROR: whatever");
    expect(store().status).toBe("disconnected");
  });
});

describe("recovery monitor (RC2)", () => {
  beforeEach(() => {
    configureTerminalRecovery({ baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 2, jitterRatio: 0 });
  });

  it("arms after an exhausted failure and reconnects when the connector comes back", async () => {
    armVerifiedInstall();
    stubHealthRefused();
    const ok = await store().connect();
    expect(ok).toBe(false);
    expect(store().status).toBe("unavailable");
    expect(isRecoveryMonitorActive()).toBe(true);

    // The user restarts the connector manually (or the OS dialog was answered).
    stubHealthOk();
    await runRecoveryMonitorTick();

    expect(store().status).toBe("connected");
    expect(isTerminalConnected()).toBe(true);
    expect(store().lastVerifiedAt).not.toBeNull();
    // Connected again: the monitor disarms and the heartbeat takes over.
    expect(isRecoveryMonitorActive()).toBe(false);
  });

  it("stays silent — a failing tick never flips the UI to connecting", async () => {
    armVerifiedInstall();
    stubHealthRefused();
    await store().connect();
    expect(store().status).toBe("unavailable");

    await runRecoveryMonitorTick();
    expect(store().status).toBe("unavailable");
    expect(isRecoveryMonitorActive()).toBe(true);
  });

  it("does not arm without a verified install", async () => {
    configureTerminalRecovery({ baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 1, jitterRatio: 0 });
    stubHealthRefused();
    const ok = await store().connect();
    expect(ok).toBe(false);
    expect(store().status).toBe("unavailable");
    expect(isRecoveryMonitorActive()).toBe(false);
  });

  it("does not arm for permission or origin-blocked outcomes", async () => {
    armVerifiedInstall();
    stubPermissions("denied");
    vi.stubGlobal("fetch", vi.fn());
    await store().connect();
    expect(store().status).toBe("permission_required");
    expect(isRecoveryMonitorActive()).toBe(false);

    resetTerminalConnection();
    // Direct state injection mirrors how the connect flow lands on origin_blocked.
    useTerminalConnectionStore.setState({ status: "error", failureReason: "origin_blocked" });
    expect(isRecoveryMonitorActive()).toBe(false);
  });

  it("does not arm when the user explicitly disconnected this session", async () => {
    armVerifiedInstall();
    window.sessionStorage.setItem("nexuss.terminal.disconnected", "1");
    useTerminalConnectionStore.setState({ status: "unavailable", failureReason: "unreachable" });
    expect(isRecoveryMonitorActive()).toBe(false);
  });

  it("ticks immediately when the tab becomes visible again", async () => {
    armVerifiedInstall();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    useTerminalConnectionStore.setState({ status: "unavailable", failureReason: "unreachable" });
    expect(isRecoveryMonitorActive()).toBe(true);
    fetchMock.mockClear();

    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), { timeout: 3000 });
    expect(store().status).toBe("unavailable");
  });
});

describe("honest execution capability (RC5/phase 6)", () => {
  it("never advertises run before a real verification, and clears it on loss", async () => {
    const runtime = createLocalConnectorRuntime();
    expect(runtime.capabilities().run).toBe(false);
    expect(runtime.capabilities().write).toBe(false);

    stubHealthOk();
    await store().connect();
    expect(runtime.capabilities().run).toBe(true);

    await store().disconnect();
    expect(runtime.capabilities().run).toBe(false);
  });

  it("refuses to connect when the connector explicitly advertises run:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/v1/terminal/capabilities")) {
          return new Response(JSON.stringify({ status: "ok", capabilities: { run: false } }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return healthOk(2);
      })
    );
    const ok = await store().connect();
    expect(ok).toBe(false);
    expect(store().status).toBe("error");
    expect(store().failureReason).toBe("capability");
    expect(isTerminalConnected()).toBe(false);
    expect(createLocalConnectorRuntime().capabilities().run).toBe(false);
  });

  it("falls back to the verified health contract when the endpoint is missing (legacy connector)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/v1/terminal/capabilities")) {
          return new Response("Not found", { status: 404 });
        }
        return healthOk(2);
      })
    );
    const ok = await store().connect();
    expect(ok).toBe(true);
    expect(store().status).toBe("connected");
    expect(createLocalConnectorRuntime().capabilities().run).toBe(true);
  });

  it("probes the advertised capabilities endpoint as part of a verified connect", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/v1/terminal/capabilities")) {
          return new Response(JSON.stringify({ status: "ok", capabilities: { run: true, test: true } }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return healthOk(2);
      })
    );
    const ok = await store().connect();
    expect(ok).toBe(true);
    expect(urls.some((u) => u.includes("/v1/terminal/capabilities"))).toBe(true);
  });
});

describe("origin-blocked classification (RC4)", () => {
  it("classifies a granted-permission failure as origin_blocked when the port still answers", async () => {
    stubPermissions("granted");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({} as Response);
    vi.stubGlobal("fetch", fetchMock);

    const probe = await probeLocalConnector({ force: true });
    expect(probe).toEqual({ ok: false, reason: "origin_blocked" });
    // The discriminator is a no-cors loopback request: it proves reachability
    // without being subject to the very CORS rule that refused us.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1] as RequestInit).mode).toBe("no-cors");
  });

  it("keeps a granted-permission failure as unreachable when the port refuses", async () => {
    stubPermissions("granted");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    );

    const probe = await probeLocalConnector({ force: true });
    expect(probe).toEqual({ ok: false, reason: "unreachable" });
  });

  it("classifies a pending-permission network failure as permission, not a dead connector", async () => {
    stubPermissions("prompt");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const probe = await probeLocalConnector({ force: true });
    expect(probe).toEqual({ ok: false, reason: "permission" });
  });

  it("connect lands on the origin-blocked error screen with no monitoring", async () => {
    armVerifiedInstall();
    stubPermissions("granted");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({} as Response)
    );

    const ok = await store().connect();
    expect(ok).toBe(false);
    expect(store().status).toBe("error");
    expect(store().failureReason).toBe("origin_blocked");
    expect(store().diagnosticCode).toBe("origin_blocked");
    expect(isRecoveryMonitorActive()).toBe(false);
  });
});

describe("restart request bookkeeping (RC3)", () => {
  it("records that a restart request was issued during a failed recovery, and clears it on disconnect", async () => {
    armVerifiedInstall();
    configureTerminalRecovery({ baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 1, jitterRatio: 0 });
    stubHealthRefused();

    const ok = await store().connect();
    expect(ok).toBe(false);
    expect(store().status).toBe("unavailable");
    // The recovery DID issue the consented launcher request — the UI can now
    // tell the user to watch for the OS confirmation dialog.
    expect(store().lastRestartRequested).toBe(true);

    await store().disconnect();
    expect(store().lastRestartRequested).toBe(false);
  });

  it("does not claim a restart when no launcher evidence exists", async () => {
    // setup verified but legacy protocol: no launcher registered this session.
    window.localStorage.setItem("nexuss.terminal.setupVerified", "1");
    configureTerminalRecovery({ baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 1, jitterRatio: 0 });
    stubHealthRefused();

    await store().connect();
    expect(store().status).toBe("unavailable");
    expect(store().lastRestartRequested).toBe(false);
  });
});

describe("circuit breaker surfaces restart_throttled (RC5)", () => {
  it("reports restart_throttled on the second session once the breaker is open", async () => {
    armVerifiedInstall();
    configureTerminalRecovery({
      baseDelayMs: 1,
      maxDelayMs: 2,
      maxAttempts: 1,
      jitterRatio: 0,
      maxRestartsPerWindow: 1,
      restartCooldownMs: 60_000,
      restartWindowMs: 300_000
    });
    stubHealthRefused();

    const first = await store().recover("session-one");
    expect(first).toBe(false);
    expect(store().lastRestartRequested).toBe(true); // one restart issued → breaker open

    const second = await store().recover("session-two");
    expect(second).toBe(false);
    expect(store().status).toBe("unavailable");
    expect(store().diagnosticCode).toBe("restart_throttled");
    // This session never got to request anything — the hint must not lie.
    expect(store().lastRestartRequested).toBe(false);
  });
});
