// Bounded, restart-safe recovery orchestration for the local connector.
//
// Pure decision logic — probes, restarts and sleeps are injected so the whole
// workflow is unit-testable without a browser or a real connector. The store
// (terminalConnection.ts) wires the real probe/restart functions in.
//
// Safety properties encoded here:
//   - at most ONE restart request per recovery session (no restart storms);
//   - at most N restarts per rolling window, then a cooldown (circuit breaker);
//   - permission and security-policy failures are never "recovered" by
//     restarting — they need a human decision and abort the session;
//   - cancellation is checked between every step;
//   - success is only ever declared by a real, healthy probe.

import type { ConnectorProbeResult } from "./localTerminalRuntime";
import type { RecoveryAction } from "./terminalDiagnostics";

export interface RecoveryConfig {
  /** Total probe attempts per recovery session (first probe included). */
  maxAttempts: number;
  /** Backoff base between attempts (doubles each attempt). */
  baseDelayMs: number;
  /** Backoff cap. */
  maxDelayMs: number;
  /** Random jitter as a fraction of the computed delay (0–1). */
  jitterRatio: number;
  /** How long the breaker stays open after tripping. */
  restartCooldownMs: number;
  /** Rolling window for counting restarts across sessions. */
  restartWindowMs: number;
  /** Restarts allowed inside the rolling window before the breaker trips. */
  maxRestartsPerWindow: number;
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  maxAttempts: 4,
  baseDelayMs: 700,
  maxDelayMs: 8000,
  jitterRatio: 0.25,
  restartCooldownMs: 60_000,
  restartWindowMs: 5 * 60_000,
  maxRestartsPerWindow: 3
};

let activeConfig: RecoveryConfig = { ...DEFAULT_RECOVERY_CONFIG };

/**
 * Override recovery timing (tests use tiny delays; production keeps defaults).
 * Pass a full config; returns the previous one so callers can restore.
 */
export function configureTerminalRecovery(config: Partial<RecoveryConfig>): RecoveryConfig {
  const previous = activeConfig;
  activeConfig = { ...DEFAULT_RECOVERY_CONFIG, ...config };
  return previous;
}

export function getRecoveryConfig(): RecoveryConfig {
  return activeConfig;
}

/** Exponential backoff with proportional jitter, capped. */
export function backoffDelayMs(attempt: number, cfg: RecoveryConfig = activeConfig, rand: () => number = Math.random): number {
  const raw = Math.min(cfg.baseDelayMs * 2 ** Math.max(0, attempt), cfg.maxDelayMs);
  const jitter = raw * cfg.jitterRatio * Math.max(0, rand());
  return Math.round(raw + jitter);
}

/** Rolling-window restart counter powering the circuit breaker. */
export interface BreakerState {
  /** Epoch-ms timestamps of recent restart requests. */
  restarts: number[];
  /** Epoch-ms until which restarts are forbidden (0 = closed). */
  openUntil: number;
}

export function createBreakerState(): BreakerState {
  return { restarts: [], openUntil: 0 };
}

/** Prune the window and report whether the breaker currently allows a restart. */
export function breakerAllowsRestart(state: BreakerState, now: number, cfg: RecoveryConfig = activeConfig): boolean {
  if (state.openUntil > now) return false;
  state.restarts = state.restarts.filter((t) => now - t < cfg.restartWindowMs);
  return state.restarts.length < cfg.maxRestartsPerWindow;
}

/** Record a restart attempt, tripping the breaker when the window is exhausted. */
export function recordRestart(state: BreakerState, now: number, cfg: RecoveryConfig = activeConfig): void {
  state.restarts = state.restarts.filter((t) => now - t < cfg.restartWindowMs);
  state.restarts.push(now);
  if (state.restarts.length >= cfg.maxRestartsPerWindow) {
    state.openUntil = now + cfg.restartCooldownMs;
  }
}

/** A verified healthy connection resets the breaker. */
export function recordRecoverySuccess(state: BreakerState): void {
  state.restarts = [];
  state.openUntil = 0;
}

export type RecoveryStep = "checking" | "restarting" | "verifying";

export interface RecoveryDeps {
  /** Forced health probe (no cache). */
  probe: () => Promise<ConnectorProbeResult>;
  /** Ask the local launcher to start the connector. Returns false when unavailable. */
  restart: () => boolean;
  /** Injectable sleep for backoff. */
  sleep: (ms: number) => Promise<void>;
  /** Progress callback for the UI. */
  onStep?: (step: RecoveryStep, attempt: number) => void;
  /** Cancellation probe — checked between every step. */
  isCancelled?: () => boolean;
  /** Evidence the consented local launcher exists (protocol >= 2 seen). */
  canUseLauncher: boolean;
  /** Shared breaker state across sessions (owned by the store). */
  breaker: BreakerState;
  now?: () => number;
}

export type RecoveryOutcome =
  | { ok: true }
  | { ok: false; reason: "exhausted" | "cancelled" | "breaker_open" }
  /** Recovery stopped because a human decision is required. */
  | { ok: false; reason: "blocked"; blockedBy: "permission" | "policy" };

/**
 * Run one bounded recovery session:
 *   probe → (maybe) one restart request → backoff probes → verify.
 * Declares success only after a healthy probe. Returns a structured outcome;
 * never throws.
 */
export async function runBoundedRecovery(deps: RecoveryDeps, cfg: RecoveryConfig = activeConfig): Promise<RecoveryOutcome> {
  const now = deps.now ?? Date.now;
  const cancelled = () => deps.isCancelled?.() === true;

  if (cancelled()) return { ok: false, reason: "cancelled" };

  deps.onStep?.("checking", 0);
  let probe = await deps.probe();
  if (probe.ok) return { ok: true };
  if (probe.reason === "permission") return { ok: false, reason: "blocked", blockedBy: "permission" };

  // One restart request per session, only with launcher evidence and breaker budget.
  let restartIssued = false;
  if (deps.canUseLauncher && probe.reason !== "http-error" && breakerAllowsRestart(deps.breaker, now(), cfg)) {
    deps.onStep?.("restarting", 0);
    recordRestart(deps.breaker, now(), cfg);
    restartIssued = deps.restart();
  } else if (deps.canUseLauncher && !breakerAllowsRestart(deps.breaker, now(), cfg)) {
    return { ok: false, reason: "breaker_open" };
  }

  const attempts = Math.max(1, cfg.maxAttempts);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (cancelled()) return { ok: false, reason: "cancelled" };
    await deps.sleep(backoffDelayMs(attempt, cfg));
    if (cancelled()) return { ok: false, reason: "cancelled" };

    deps.onStep?.(restartIssued && attempt === 0 ? "restarting" : "verifying", attempt);
    probe = await deps.probe();
    if (probe.ok) return { ok: true };
    // A restart can surface a permission prompt — that needs the user, stop.
    if (probe.reason === "permission") return { ok: false, reason: "blocked", blockedBy: "permission" };
    // 403/security responses mid-recovery are policy denials, not flakiness.
    if (probe.reason === "http-error" && probe.httpStatus === 403) {
      return { ok: false, reason: "blocked", blockedBy: "policy" };
    }
  }

  return { ok: false, reason: "exhausted" };
}

/** Approved recovery actions for a diagnostic — single source for the UI. */
export function actionsForUi(actions: RecoveryAction[]): RecoveryAction[] {
  return actions;
}
