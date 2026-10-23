// Recovery orchestration must stay bounded and restart-safe: one restart per
// session, a rolling-window circuit breaker, cancellation between steps, and
// no automatic recovery past permission or security-policy denials.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  backoffDelayMs,
  breakerAllowsRestart,
  configureTerminalRecovery,
  createBreakerState,
  DEFAULT_RECOVERY_CONFIG,
  getRecoveryConfig,
  recordRecoverySuccess,
  recordRestart,
  runBoundedRecovery,
  type RecoveryDeps
} from "@/workspace/terminalRecovery";
import type { ConnectorProbeResult } from "@/workspace/localTerminalRuntime";

const FAST = { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 3, jitterRatio: 0, restartCooldownMs: 1000, restartWindowMs: 10_000, maxRestartsPerWindow: 2 };

afterEach(() => {
  configureTerminalRecovery(DEFAULT_RECOVERY_CONFIG);
});

function seq(...results: ConnectorProbeResult[]): () => Promise<ConnectorProbeResult> {
  const copy = [...results];
  return vi.fn(async () => copy.shift() ?? { ok: false, reason: "unreachable" as const });
}

function deps(overrides: Partial<RecoveryDeps> & Pick<RecoveryDeps, "probe">): RecoveryDeps {
  return {
    restart: vi.fn(() => "requested" as const),
    sleep: vi.fn(async () => {}),
    canUseLauncher: false,
    breaker: createBreakerState(),
    ...overrides
  };
}

describe("backoffDelayMs()", () => {
  it("doubles per attempt, caps, and applies proportional jitter", () => {
    const cfg = { ...DEFAULT_RECOVERY_CONFIG, baseDelayMs: 100, maxDelayMs: 350, jitterRatio: 0.5 };
    expect(backoffDelayMs(0, cfg, () => 0)).toBe(100);
    expect(backoffDelayMs(1, cfg, () => 0)).toBe(200);
    expect(backoffDelayMs(2, cfg, () => 0)).toBe(350); // capped
    expect(backoffDelayMs(10, cfg, () => 0)).toBe(350);
    // Jitter never exceeds the configured fraction of the raw delay.
    expect(backoffDelayMs(1, cfg, () => 1)).toBe(300); // 200 + 50% * 200
  });
});

describe("circuit breaker", () => {
  it("allows restarts up to the window limit, then opens for the cooldown", () => {
    const cfg = { ...FAST, maxRestartsPerWindow: 2, restartCooldownMs: 5000, restartWindowMs: 3000 };
    const state = createBreakerState();
    const t0 = 1_000_000;

    expect(breakerAllowsRestart(state, t0, cfg)).toBe(true);
    recordRestart(state, t0, cfg);
    expect(breakerAllowsRestart(state, t0 + 1, cfg)).toBe(true);
    recordRestart(state, t0 + 1, cfg);
    // Window exhausted → breaker open.
    expect(breakerAllowsRestart(state, t0 + 2, cfg)).toBe(false);

    // Still open inside the cooldown…
    expect(breakerAllowsRestart(state, t0 + 4000, cfg)).toBe(false);
    // …closed once the cooldown has passed AND the old restarts aged out of the window.
    expect(breakerAllowsRestart(state, t0 + 9000, cfg)).toBe(true);
  });

  it("resets fully after a verified success", () => {
    const cfg = { ...FAST, maxRestartsPerWindow: 1 };
    const state = createBreakerState();
    recordRestart(state, 1_000_000, cfg);
    expect(breakerAllowsRestart(state, 1_000_001, cfg)).toBe(false);
    recordRecoverySuccess(state);
    expect(breakerAllowsRestart(state, 1_000_002, cfg)).toBe(true);
    expect(state.openUntil).toBe(0);
  });
});

describe("configureTerminalRecovery()", () => {
  it("merges partial overrides with defaults and restores the previous config", () => {
    const prev = configureTerminalRecovery({ baseDelayMs: 5 });
    expect(getRecoveryConfig().baseDelayMs).toBe(5);
    expect(getRecoveryConfig().maxAttempts).toBe(DEFAULT_RECOVERY_CONFIG.maxAttempts);
    configureTerminalRecovery(prev);
    expect(getRecoveryConfig().baseDelayMs).toBe(DEFAULT_RECOVERY_CONFIG.baseDelayMs);
  });
});

describe("runBoundedRecovery()", () => {
  it("declares success only after a healthy probe", async () => {
    const probe = seq({ ok: false, reason: "unreachable" }, { ok: true });
    const outcome = await runBoundedRecovery(deps({ probe }), FAST);
    expect(outcome).toEqual({ ok: true });
  });

  it("issues at most one restart request per session", async () => {
    const probe = seq(
      { ok: false, reason: "unreachable" },
      { ok: false, reason: "unreachable" },
      { ok: false, reason: "unreachable" },
      { ok: true }
    );
    const restart = vi.fn(() => "requested" as const);
    const outcome = await runBoundedRecovery(deps({ probe, restart, canUseLauncher: true }), FAST);
    expect(outcome).toEqual({ ok: true });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("never restarts without launcher evidence", async () => {
    const probe = seq({ ok: false, reason: "unreachable" }, { ok: false, reason: "unreachable" });
    const restart = vi.fn(() => "requested" as const);
    const outcome = await runBoundedRecovery(deps({ probe, restart, canUseLauncher: false }), FAST);
    expect(outcome).toEqual({ ok: false, reason: "exhausted" });
    expect(restart).not.toHaveBeenCalled();
  });

  it("exhausts after the configured attempts without faking success", async () => {
    const probe = seq(
      { ok: false, reason: "unreachable" },
      { ok: false, reason: "unreachable" },
      { ok: false, reason: "timeout" },
      { ok: false, reason: "unreachable" }
    );
    const outcome = await runBoundedRecovery(deps({ probe }), FAST);
    expect(outcome).toEqual({ ok: false, reason: "exhausted" });
  });

  it("aborts between steps when cancelled", async () => {
    let cancelled = false;
    const probe = vi.fn(async (): Promise<ConnectorProbeResult> => {
      cancelled = true;
      return { ok: false, reason: "unreachable" };
    });
    const outcome = await runBoundedRecovery(
      deps({ probe, isCancelled: () => cancelled, canUseLauncher: true }),
      FAST
    );
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
  });

  it("blocks on a permission failure instead of restarting", async () => {
    const probe = seq({ ok: false, reason: "permission" });
    const restart = vi.fn(() => "requested" as const);
    const outcome = await runBoundedRecovery(deps({ probe, restart, canUseLauncher: true }), FAST);
    expect(outcome).toEqual({ ok: false, reason: "blocked", blockedBy: "permission" });
    expect(restart).not.toHaveBeenCalled();
  });

  it("blocks on a 403 policy denial surfacing mid-recovery", async () => {
    const probe = seq({ ok: false, reason: "unreachable" }, { ok: false, reason: "http-error", httpStatus: 403 });
    const outcome = await runBoundedRecovery(deps({ probe, canUseLauncher: true }), FAST);
    expect(outcome).toEqual({ ok: false, reason: "blocked", blockedBy: "policy" });
  });

  it("blocks on an origin refusal instead of restarting", async () => {
    // Reachable-but-refused is a security outcome: no restart may be issued.
    const probe = seq({ ok: false, reason: "origin_blocked" });
    const restart = vi.fn(() => "requested" as const);
    const outcome = await runBoundedRecovery(deps({ probe, restart, canUseLauncher: true }), FAST);
    expect(outcome).toEqual({ ok: false, reason: "blocked", blockedBy: "origin" });
    expect(restart).not.toHaveBeenCalled();
  });

  it("does not count an unavailable restart bridge as issued", async () => {
    const probe = seq({ ok: false, reason: "unreachable" }, { ok: true });
    const restart = vi.fn(() => "unavailable" as const);
    const steps: string[] = [];
    const outcome = await runBoundedRecovery(
      deps({ probe, restart, canUseLauncher: true, onStep: (step) => steps.push(step) }),
      FAST
    );
    expect(outcome).toEqual({ ok: true });
    expect(restart).toHaveBeenCalledTimes(1);
    // restart() reported no request was issued → progress must not claim "restarting".
    expect(steps).toEqual(["checking", "verifying"]);
  });

  it("reports breaker_open instead of hammering a failing connector", async () => {
    const breaker = createBreakerState();
    const cfg = { ...FAST, maxRestartsPerWindow: 1 };
    recordRestart(breaker, Date.now(), cfg);
    const probe = seq({ ok: false, reason: "unreachable" });
    const restart = vi.fn(() => "requested" as const);
    const outcome = await runBoundedRecovery(deps({ probe, restart, canUseLauncher: true, breaker }), cfg);
    expect(outcome).toEqual({ ok: false, reason: "breaker_open" });
    expect(restart).not.toHaveBeenCalled();
  });

  it("reports progress steps for the UI", async () => {
    const probe = seq({ ok: false, reason: "unreachable" }, { ok: true });
    const steps: string[] = [];
    await runBoundedRecovery(
      deps({ probe, canUseLauncher: true, onStep: (step, attempt) => steps.push(`${step}:${attempt}`) }),
      FAST
    );
    expect(steps).toEqual(["checking:0", "restarting:0", "restarting:0"]);
  });

  it("short-circuits to success when the connector is already healthy", async () => {
    const probe = seq({ ok: true });
    const sleep = vi.fn(async () => {});
    const outcome = await runBoundedRecovery(deps({ probe, sleep }), FAST);
    expect(outcome).toEqual({ ok: true });
    expect(sleep).not.toHaveBeenCalled();
  });
});
