// Single source of truth for the Nexuss ⇄ local terminal connector connection.
//
// The UI, the chat gate and the authorized executor all read this store, so
// there is exactly one definition of "terminal is connected". A connection is
// only ever reported as `connected` after the local connector's health endpoint
// has answered AND terminal execution capability has been verified — the state
// is never faked from a frontend boolean.
//
// Self-healing: a lost connection on a machine with a previously verified
// install enters `recovering`, which runs ONE bounded session — diagnose,
// optionally ask the consented local launcher to restart the connector, retry
// probes with exponential backoff, then verify — before falling back to an
// honest failure screen. A circuit breaker stops restart loops; permission and
// security-policy denials are never auto-"recovered".

import { create } from "zustand";
import {
  createLocalConnectorRuntime,
  isLocalConnectorAvailable,
  probeLocalConnector,
  probeTerminalExecutionCapability,
  setTerminalRunCapability,
  type ConnectorProbeFailureReason,
  type ConnectorProbeResult
} from "./localTerminalRuntime";
import type { NativeRuntimeBridge } from "./bridge";
import {
  classifyTerminalFailure,
  incompatibleInstallDiagnostic,
  isProtocolCompatible,
  type DiagnosticContext,
  type TerminalDiagnostic,
  type TerminalDiagnosticCode
} from "./terminalDiagnostics";
import {
  createBreakerState,
  recordRecoverySuccess,
  runBoundedRecovery,
  type BreakerState,
  type RecoveryStep
} from "./terminalRecovery";
import { hasConnectorLauncher, rememberConnectorProtocol, requestConnectorStart } from "./connectorProtocol";
import { hasTerminalSetupVerified, isWindowsPlatform } from "./terminalSetup";

/**
 * Verified terminal connection state machine:
 *
 * - `disconnected`        — no verified connection; Connect Terminal is shown.
 * - `setting_up`          — the user started the one-time setup; waiting for
 *                          them to run the downloaded installer.
 * - `connecting`          — a verification is in flight; commands stay blocked.
 * - `connected`           — ONLY after the connector health check AND terminal
 *                          capability verification succeeded.
 * - `recovering`          — a lost connection is being auto-repaired (bounded).
 * - `permission_required` — the browser blocked the local-network request
 *                          (Local Network Access permission denied/blocked).
 * - `unavailable`         — the connector is not running / did not answer
 *                          (connection refused or timed out) and recovery is
 *                          not possible or is exhausted.
 * - `error`               — reachable but the response was invalid, HTTP error,
 *                          incompatible protocol, or capability could not be
 *                          verified.
 */
export type TerminalConnectionStatus =
  | "disconnected"
  | "setting_up"
  | "connecting"
  | "connected"
  | "recovering"
  | "permission_required"
  | "unavailable"
  | "error";

/** Classified reason behind a non-connected terminal state (never rendered raw). */
export type TerminalFailureReason = ConnectorProbeFailureReason | "capability" | "incompatible" | null;

/**
 * Assistant-message content that renders as the inline "Terminal access
 * required" action in chat. The chat flow persists this string as the reply so
 * the card survives reloads; MessageList turns it back into a card.
 */
export const TERMINAL_CONNECT_REQUIRED_MESSAGE = "Terminal access required";

/** Remember an explicit user Disconnect for the current tab session. */
const DISCONNECTED_BY_USER_KEY = "nexuss.terminal.disconnected";

/** While connected, re-verify the connector so a stopped connector is noticed. */
const HEARTBEAT_INTERVAL_MS = 8000;

/**
 * Consecutive heartbeat/probe failures tolerated before recovery starts.
 * One missed heartbeat is treated as transient (GC pause, busy machine); the
 * second confirms the loss. Passive panel-open checks treat a failure while
 * connected as a definite loss (the user is looking at the panel now).
 */
const HEARTBEAT_MISS_LIMIT = 2;

/**
 * First connect (and explicit retry) must leave room for the browser's Local
 * Network Access prompt: the health-check fetch hangs while that prompt is on
 * screen, so a short abort would misreport a healthy connector as "not running".
 * Heartbeat checks keep the short default timeout — by then permission is
 * already granted and the request is fast.
 */
const CONNECT_TIMEOUT_MS = 15000;

/** Recovery probes sit between the two: long enough for a restart, short enough to stay bounded. */
const RECOVERY_PROBE_TIMEOUT_MS = 4000;

function readDisconnectedByUser(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(DISCONNECTED_BY_USER_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDisconnectedByUser(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.sessionStorage.setItem(DISCONNECTED_BY_USER_KEY, "1");
    else window.sessionStorage.removeItem(DISCONNECTED_BY_USER_KEY);
  } catch {
    // Storage may be unavailable (private mode) — connection flow still works.
  }
}

/** Deduped, forced health probe so concurrent checks share one request. */
let healthProbeInFlight: Promise<ConnectorProbeResult> | null = null;
function probeConnector(timeoutMs?: number): Promise<ConnectorProbeResult> {
  if (!healthProbeInFlight) {
    healthProbeInFlight = probeLocalConnector({ force: true, timeoutMs }).finally(() => {
      healthProbeInFlight = null;
    });
  }
  return healthProbeInFlight;
}

/**
 * Generation token for every async connect/recovery/disconnect flow. Results
 * from a previous generation are discarded, so a stale slow response can never
 * overwrite a newer state (double-click connect, disconnect mid-flight,
 * recovery superseded by an explicit connect).
 */
let connectionGeneration = 0;

/** Outcome of a full establish (health + capability) attempt. */
type EstablishResult = { ok: true } | { ok: false; reason: Exclude<TerminalFailureReason, null> };

/** Map a failed establish to the state that is most actionable for the user. */
function statusForFailure(reason: Exclude<TerminalFailureReason, null>): TerminalConnectionStatus {
  if (reason === "permission") return "permission_required";
  if (reason === "timeout" || reason === "unreachable") return "unavailable";
  // origin_blocked / incompatible / capability / http-error / invalid-response:
  // reachable-but-wrong or policy outcomes get the error screen, not "unavailable".
  return "error";
}

/** Transient-failure retries for an explicit connect (never for passive checks). */
const CONNECT_RETRIES = 3;
const CONNECT_RETRY_DELAY_MS = 700;

/** Diagnostic context from durable local evidence. */
function diagnosticContext(): DiagnosticContext {
  return {
    setupVerified: hasTerminalSetupVerified(),
    windows: isWindowsPlatform(),
    protocol: undefined
  };
}

/** Auto-recovery is only offered on a machine that actually has an install to repair. */
function canAutoRecover(diag: TerminalDiagnostic): boolean {
  if (!isWindowsPlatform() || !hasTerminalSetupVerified()) return false;
  return diag.recovery.includes("restart_connector") || diag.recovery.includes("retry_probe");
}

/**
 * Detail strings from real terminal-operation failures that describe a
 * TRANSIENT connector loss (refused socket, transport error, timeout, the
 * heartbeat's own "health check" wording) — exactly the class of failure the
 * bounded recovery session exists to repair.
 */
const TRANSIENT_FAILURE_DETAIL_RE =
  /NETWORK_ERROR|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Failed to fetch|NetworkError|TIMEOUT:|did not respond|health check failed|connection lost|connector stopped|127\.0\.0\.1|localhost|:\d{4,5}\b|CORS/i;

/**
 * Detail strings that describe a policy/permission refusal. These need a
 * human decision (or a deployment fix) and must never be routed into an
 * automatic recovery that could "succeed" dishonestly.
 */
const POLICY_FAILURE_DETAIL_RE =
  /permission|local network access|not allowed|origin .* not allowed|security policy|refused access|access denied|forbidden|\b403\b/i;

/** Classify a raw failure detail so markUnavailable can route (or dead-end) truthfully. */
function classifyFailureDetail(detail?: string): "transient" | "policy" | "other" {
  if (!detail) return "other";
  if (POLICY_FAILURE_DETAIL_RE.test(detail)) return "policy";
  if (TRANSIENT_FAILURE_DETAIL_RE.test(detail)) return "transient";
  return "other";
}

/** Short, single-line, developer-log-safe trigger label for a recovery session. */
function sanitizeRecoveryTrigger(detail: string | undefined): string {
  const flat = (detail || "connector lost").replace(/\s+/g, " ").trim().slice(0, 160);
  return `terminal operation failed: ${flat}`;
}

/** Deduped health + capability verification shared by passive and active connects. */
let establishInFlight: Promise<EstablishResult> | null = null;
async function establishConnection(opts?: { retry?: boolean; generation?: number }): Promise<EstablishResult> {
  const generation = opts?.generation ?? connectionGeneration;
  if (!establishInFlight) {
    establishInFlight = (async (): Promise<EstablishResult> => {
      const retries = opts?.retry ? CONNECT_RETRIES : 1;
      let probe: ConnectorProbeResult = { ok: false, reason: "unreachable" };
      for (let attempt = 0; attempt < retries; attempt++) {
        probe = await probeConnector(CONNECT_TIMEOUT_MS);
        // Only retry fast, transient failures. A permission prompt needs a user
        // decision and a timeout already waited out the full connect window —
        // retrying either would just stall the user behind another long wait.
        if (probe.ok || probe.reason !== "unreachable") break;
        if (attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, CONNECT_RETRY_DELAY_MS));
        }
      }
      if (!probe.ok) return probe;
      rememberConnectorProtocol(probe.protocol);
      if (!isProtocolCompatible(probe.protocol)) return { ok: false, reason: "incompatible" };
      if (generation !== connectionGeneration) return { ok: false, reason: "capability" };
      const capable = await verifyExecutionCapability();
      if (!capable) return { ok: false, reason: "capability" };
      return { ok: true };
    })().finally(() => {
      establishInFlight = null;
    });
  }
  return establishInFlight;
}

/**
 * Verify terminal execution capability is really available — no hard-coded
 * `true` anywhere:
 * - the local connector runtime: feature-detect GET /v1/terminal/capabilities
 *   (falls back to the verified health contract's terminal flag on older
 *   installs), then publish the verified flag so capabilities() is honest;
 * - a native desktop bridge: its own capabilities() is the real local API.
 * Returns false instead of faking success, and grants path capability only
 * after a real verification.
 */
async function verifyExecutionCapability(): Promise<boolean> {
  try {
    const { useWorkspaceStore } = await import("./store");
    const state = useWorkspaceStore.getState();
    let runtime = state.runtime as NativeRuntimeBridge | null;
    if (!runtime || typeof runtime.run !== "function") {
      runtime = createLocalConnectorRuntime() as unknown as NativeRuntimeBridge;
      useWorkspaceStore.setState({ runtime });
    }
    const isConnectorRuntime = (runtime as { isAvailable?: unknown } | null)?.isAvailable === isLocalConnectorAvailable;
    let capable: boolean;
    if (isConnectorRuntime) {
      capable = await probeTerminalExecutionCapability();
      setTerminalRunCapability(capable);
    } else {
      // Native desktop bridge (window.nexussDesktop.runtime): honest native caps.
      const caps = typeof runtime.capabilities === "function" ? runtime.capabilities() : null;
      capable = !!caps?.run;
    }
    if (!capable) return false;
    // A verified connection grants terminal/workspace capability for the session.
    useWorkspaceStore.setState({ pathEnabled: true });
    return true;
  } catch {
    return false;
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatMisses = 0;

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer !== null || typeof window === "undefined") return;
  heartbeatTimer = setInterval(() => {
    void runTerminalHeartbeatTick();
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * One heartbeat tick. Tolerates HEARTBEAT_MISS_LIMIT consecutive misses, then
 * starts bounded auto-recovery on machines with a verified install, or drops
 * to the honest unavailable state everywhere else. Exported for tests.
 */
export async function runTerminalHeartbeatTick(): Promise<void> {
  const status = useTerminalConnectionStore.getState().status;
  if (status !== "connected") {
    stopHeartbeat();
    return;
  }
  const generation = connectionGeneration;
  const probe = await probeConnector();
  if (generation !== connectionGeneration) return;
  if (probe.ok) {
    heartbeatMisses = 0;
    rememberConnectorProtocol(probe.protocol);
    useTerminalConnectionStore.setState({ lastVerifiedAt: Date.now(), lastError: null });
    return;
  }
  heartbeatMisses += 1;
  if (heartbeatMisses < HEARTBEAT_MISS_LIMIT) {
    console.debug(`[TerminalConnection] heartbeat miss ${heartbeatMisses}/${HEARTBEAT_MISS_LIMIT} (tolerated)`);
    return;
  }
  heartbeatMisses = 0;
  console.debug("[TerminalConnection] heartbeat confirmed connection loss");
  if (isWindowsPlatform() && hasTerminalSetupVerified()) {
    await useTerminalConnectionStore.getState().recover("heartbeat lost");
  } else {
    useTerminalConnectionStore.getState().markUnavailable("connector stopped responding");
  }
}

/**
 * Recovery monitor: while the app sits in the honest failure state
 * (`unavailable`/`error`), silently watch for the local connector to come
 * back (user restarted it, machine woke up, OS dialog answered) and run the
 * shared passive verification to reconnect automatically — no user gesture,
 * no restart requests (restarts stay inside breaker-limited recovery
 * sessions), no UI flapping while the connector is still down.
 */
const RECOVERY_MONITOR_INTERVAL_MS = 25_000;
let recoveryMonitorTimer: ReturnType<typeof setInterval> | null = null;
let recoveryMonitorTickInFlight = false;

/** Only transient-ish failure states on a verified Windows install are watched. */
function isRecoveryMonitorEligible(status: TerminalConnectionStatus, failureReason: TerminalFailureReason): boolean {
  if (status !== "unavailable" && status !== "error") return false;
  if (failureReason === "permission" || failureReason === "incompatible" || failureReason === "origin_blocked") return false;
  if (!isWindowsPlatform() || !hasTerminalSetupVerified()) return false;
  if (readDisconnectedByUser()) return false;
  return true;
}

function onMonitorVisibilityChange(): void {
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    // Tab visible again: don't wait for the next interval, the user is here.
    void runRecoveryMonitorTick();
  }
}

function startRecoveryMonitor(): void {
  if (recoveryMonitorTimer !== null || typeof window === "undefined") return;
  recoveryMonitorTimer = setInterval(() => {
    void runRecoveryMonitorTick();
  }, RECOVERY_MONITOR_INTERVAL_MS);
  document.addEventListener("visibilitychange", onMonitorVisibilityChange);
}

function stopRecoveryMonitor(): void {
  if (recoveryMonitorTimer !== null) {
    clearInterval(recoveryMonitorTimer);
    recoveryMonitorTimer = null;
  }
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onMonitorVisibilityChange);
}

/** True while the background connector-recovery monitor is armed. Exported for tests. */
export function isRecoveryMonitorActive(): boolean {
  return recoveryMonitorTimer !== null;
}

/**
 * One monitor tick: silent probe first (a down connector must not flip the UI
 * every 25 s), and only after a real healthy answer run the shared passive
 * verification (connecting → connected) that re-arms the heartbeat. Policy/
 * permission answers stop the monitor — they need a human, not a timer.
 * Exported for tests.
 */
export async function runRecoveryMonitorTick(): Promise<void> {
  if (recoveryMonitorTickInFlight) return;
  const current = useTerminalConnectionStore.getState();
  if (!isRecoveryMonitorEligible(current.status, current.failureReason)) return;
  recoveryMonitorTickInFlight = true;
  try {
    const generation = connectionGeneration;
    const probe = await probeConnector(RECOVERY_PROBE_TIMEOUT_MS);
    if (generation !== connectionGeneration) return;
    if (!probe.ok) {
      if (
        probe.reason === "permission" ||
        probe.reason === "origin_blocked" ||
        (probe.reason === "http-error" && probe.httpStatus === 403)
      ) {
        stopRecoveryMonitor();
      }
      return;
    }
    const latest = useTerminalConnectionStore.getState();
    if (!isRecoveryMonitorEligible(latest.status, latest.failureReason)) return;
    // Connector answered for real: promote through the shared passive flow.
    await useTerminalConnectionStore.getState().checkConnection();
  } finally {
    recoveryMonitorTickInFlight = false;
  }
}

export interface TerminalConnectionState {
  /** Verified connection state — the single source of truth. */
  status: TerminalConnectionStatus;
  /** Classified reason behind a non-connected state; never rendered raw. */
  failureReason: TerminalFailureReason;
  /** Structured diagnosis code for the current failure; never rendered raw. */
  diagnosticCode: TerminalDiagnosticCode | null;
  /** Current recovery progress step (only while status is `recovering`). */
  recoveryStep: RecoveryStep | null;
  /** Zero-based attempt index of the in-flight recovery session. */
  recoveryAttempt: number;
  /** When the connector was last positively verified. */
  lastVerifiedAt: number | null;
  /** True when the user connected via the Connect button in this session. */
  justConnected: boolean;
  /**
   * True when the CURRENT failure/recovery cycle issued a consented restart
   * request via the local launcher. Drives the "choose Allow" hint on the
   * failure screen — the request was only issued, never confirmed, because a
   * website cannot observe the OS confirmation dialog.
   */
  lastRestartRequested: boolean;
  /** Developer-only detail; never rendered in the UI. */
  lastError: string | null;
  /**
   * Passive check (panel opened / periodic): verifies the connector without
   * requiring a user gesture. Keeps the previous state on failure so the user
   * sees the normal connect screen (or the previous error), never a fake state.
   */
  checkConnection: () => Promise<TerminalConnectionStatus>;
  /** Active user-initiated connect: connecting → connected | permission_required | unavailable | error. */
  connect: () => Promise<boolean>;
  /** Session disconnect: disables Nexuss terminal access, never touches the connector install. */
  disconnect: () => Promise<void>;
  /** Record that a real terminal operation could not reach the connector. */
  markUnavailable: (detail?: string) => void;
  /** User started the one-time setup: remember it so Retry picks up cleanly. */
  beginSetup: () => void;
  /**
   * Start (or join) one bounded auto-recovery session. Deduped: concurrent
   * calls share the in-flight session; success restores `connected` only after
   * a real health + capability verification.
   */
  recover: (trigger: string) => Promise<boolean>;
  /** Cancel an in-flight recovery session; falls back to the honest failure screen. */
  cancelRecovery: () => void;
}

let recoveryInFlight: Promise<boolean> | null = null;
let activeRecoveryCancel: { cancelled: boolean } | null = null;
const breaker: BreakerState = createBreakerState();

async function runRecoverySession(trigger: string): Promise<boolean> {
  if (recoveryInFlight) return recoveryInFlight;
  const generation = ++connectionGeneration;
  stopHeartbeat();
  heartbeatMisses = 0;
  const cancelHandle = { cancelled: false };
  activeRecoveryCancel = cancelHandle;
  useTerminalConnectionStore.setState({
    status: "recovering",
    recoveryStep: "checking",
    recoveryAttempt: 0,
    failureReason: null,
    lastRestartRequested: false,
    lastError: trigger
  });
  console.debug(`[TerminalConnection] recovery started (${trigger})`);

  const session = (async (): Promise<boolean> => {
    const outcome = await runBoundedRecovery({
      probe: () => probeConnector(RECOVERY_PROBE_TIMEOUT_MS),
      restart: () => {
        const outcome = requestConnectorStart();
        console.debug(`[TerminalConnection] local connector restart request via launcher: ${outcome}`);
        // Record that a request was ISSUED for the failure screen — the OS
        // confirmation dialog ("Open Nexuss Terminal?") is invisible to us.
        if (outcome === "requested") useTerminalConnectionStore.setState({ lastRestartRequested: true });
        return outcome;
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      onStep: (step, attempt) => {
        if (generation !== connectionGeneration) return;
        useTerminalConnectionStore.setState({ recoveryStep: step, recoveryAttempt: attempt });
      },
      isCancelled: () => cancelHandle.cancelled || generation !== connectionGeneration,
      // Launcher evidence ONLY — the breaker gate lives inside runBoundedRecovery
      // so an open breaker surfaces as the explicit breaker_open outcome.
      canUseLauncher: hasConnectorLauncher(),
      breaker,
      now: () => Date.now()
    });
    if (generation !== connectionGeneration) return false;
    activeRecoveryCancel = null;

    if (outcome.ok) {
      const capable = await verifyExecutionCapability();
      if (generation !== connectionGeneration) return false;
      if (capable) {
        recordRecoverySuccess(breaker);
        useTerminalConnectionStore.setState({
          status: "connected",
          failureReason: null,
          diagnosticCode: null,
          recoveryStep: null,
          recoveryAttempt: 0,
          lastVerifiedAt: Date.now(),
          lastError: null,
          justConnected: false
        });
        startHeartbeat();
        console.debug("[TerminalConnection] recovery verified — connected");
        return true;
      }
    }

    // Recovery failed: fall back to the truthful, actionable failure state.
    if (outcome.ok) {
      // Healthy probe but terminal capability could not be verified.
      useTerminalConnectionStore.setState({
        status: "unavailable",
        failureReason: "unreachable",
        diagnosticCode: "connector_stopped",
        recoveryStep: null,
        lastVerifiedAt: null,
        lastError: "capability verification failed after recovery",
        justConnected: false
      });
      return false;
    }
    if (outcome.reason === "cancelled") {
      // cancelRecovery() already set the fallback state.
      return false;
    }
    const fallbackCtx = diagnosticContext();
    if (outcome.reason === "blocked") {
      if (outcome.blockedBy === "permission") {
        useTerminalConnectionStore.setState({
          status: "permission_required",
          failureReason: "permission",
          diagnosticCode: "browser_permission_denied",
          recoveryStep: null,
          lastVerifiedAt: null,
          justConnected: false
        });
      } else if (outcome.blockedBy === "origin") {
        // Reachable but this origin is refused by the connector's allowlist —
        // a security outcome; monitoring and auto-recovery stay off.
        useTerminalConnectionStore.setState({
          status: "error",
          failureReason: "origin_blocked",
          diagnosticCode: "origin_blocked",
          recoveryStep: null,
          lastVerifiedAt: null,
          justConnected: false
        });
      } else {
        useTerminalConnectionStore.setState({
          status: "error",
          failureReason: "http-error",
          diagnosticCode: "security_policy_denial",
          recoveryStep: null,
          lastVerifiedAt: null,
          justConnected: false
        });
      }
      return false;
    }
    const diag = classifyTerminalFailure({ ok: false, reason: "unreachable" }, fallbackCtx);
    useTerminalConnectionStore.setState({
      status: "unavailable",
      failureReason: "unreachable",
      diagnosticCode: outcome.reason === "breaker_open" ? "restart_throttled" : diag.code,
      recoveryStep: null,
      lastVerifiedAt: null,
      lastError: "recovery exhausted",
      justConnected: false
    });
    console.debug(`[TerminalConnection] recovery exhausted (${outcome.reason})`);
    return false;
  })();

  recoveryInFlight = session;
  try {
    return await session;
  } finally {
    if (recoveryInFlight === session) recoveryInFlight = null;
    if (activeRecoveryCancel === cancelHandle) activeRecoveryCancel = null;
  }
}

export const useTerminalConnectionStore = create<TerminalConnectionState>()((set, get) => ({
  status: "disconnected",
  failureReason: null,
  diagnosticCode: null,
  recoveryStep: null,
  recoveryAttempt: 0,
  lastVerifiedAt: null,
  justConnected: false,
  lastRestartRequested: false,
  lastError: null,

  checkConnection: async () => {
    const prev = get().status;
    if (prev === "connecting" || prev === "recovering" || prev === "setting_up") return prev;

    if (prev === "connected") {
      const generation = connectionGeneration;
      const probe = await probeConnector();
      if (generation !== connectionGeneration) return get().status;
      if (!probe.ok) {
        const diag = classifyTerminalFailure(probe, diagnosticContext());
        if (canAutoRecover(diag)) {
          void get().recover("health check failed");
          return get().status;
        }
        set({ diagnosticCode: diag.code });
        get().markUnavailable("health check failed");
        return get().status;
      }
      rememberConnectorProtocol(probe.protocol);
      if (!isProtocolCompatible(probe.protocol)) {
        set({
          status: "error",
          failureReason: "incompatible",
          diagnosticCode: incompatibleInstallDiagnostic().code,
          lastVerifiedAt: null,
          justConnected: false
        });
        return get().status;
      }
      set({ lastVerifiedAt: Date.now(), lastError: null, failureReason: null, diagnosticCode: null });
      return "connected";
    }

    // The user explicitly disconnected this session: wait for an explicit Connect.
    if (readDisconnectedByUser()) return prev;

    const generation = connectionGeneration;
    set({ status: "connecting" });
    const result = await establishConnection({ generation });
    // Another flow (an explicit Connect click, disconnect, recovery) may have finished first.
    if (generation !== connectionGeneration || get().status !== "connecting") return get().status;
    if (result.ok) {
      set({
        status: "connected",
        failureReason: null,
        diagnosticCode: null,
        recoveryStep: null,
        lastVerifiedAt: Date.now(),
        justConnected: false,
        lastError: null
      });
      recordRecoverySuccess(breaker);
      startHeartbeat();
      return "connected";
    }
    // Passive failure: keep the previous state (disconnected stays on the
    // connect screen; a previous error keeps showing the error screen).
    set({ status: prev });
    return prev;
  },

  connect: async () => {
    if (recoveryInFlight) {
      // A recovery session is already repairing the connection — join it.
      return await recoveryInFlight;
    }
    if (get().status === "connecting") {
      // A verification is already in flight — wait for its real outcome.
      await establishConnection();
      return get().status === "connected";
    }

    stopHeartbeat();
    heartbeatMisses = 0;
    writeDisconnectedByUser(false);
    const generation = ++connectionGeneration;
    set({
      status: "connecting",
      lastError: null,
      failureReason: null,
      diagnosticCode: null,
      recoveryStep: null,
      lastRestartRequested: false
    });
    const result = await establishConnection({ retry: true, generation });
    if (generation !== connectionGeneration) return get().status === "connected";
    if (get().status !== "connecting" && get().status !== "recovering") return get().status === "connected";
    if (result.ok) {
      set({
        status: "connected",
        failureReason: null,
        diagnosticCode: null,
        recoveryStep: null,
        lastVerifiedAt: Date.now(),
        justConnected: true,
        lastError: null
      });
      recordRecoverySuccess(breaker);
      startHeartbeat();
      return true;
    }

    const ctx = diagnosticContext();
    const diag =
      result.reason === "incompatible"
        ? incompatibleInstallDiagnostic()
        : classifyTerminalFailure({ ok: false, reason: result.reason === "capability" ? "invalid-response" : result.reason }, ctx);
    set({ diagnosticCode: diag.code, failureReason: result.reason });

    // Never fake it: only a verified health + capability result counts.
    // On a machine with a verified install, give bounded auto-recovery one
    // session before showing the failure screen.
    if (result.reason !== "incompatible" && result.reason !== "capability" && canAutoRecover(diag)) {
      console.debug(`[TerminalConnection] connect failed — attempting recovery (${diag.code})`);
      const recovered = await runRecoverySession(`connect failed: ${diag.code}`);
      return recovered;
    }

    set({
      status: statusForFailure(result.reason),
      failureReason: result.reason,
      lastError: "connector unreachable or terminal capability unavailable",
      lastVerifiedAt: null,
      justConnected: false
    });
    console.debug("[TerminalConnection] connect failed — local connector not reachable", result.reason);
    return false;
  },

  disconnect: async () => {
    connectionGeneration += 1;
    if (activeRecoveryCancel) activeRecoveryCancel.cancelled = true;
    stopHeartbeat();
    heartbeatMisses = 0;
    writeDisconnectedByUser(true);
    set({
      status: "disconnected",
      failureReason: null,
      diagnosticCode: null,
      recoveryStep: null,
      recoveryAttempt: 0,
      lastVerifiedAt: null,
      justConnected: false,
      lastRestartRequested: false,
      lastError: null
    });
    // Disable Nexuss terminal access for this session. The local connector
    // installation itself is left untouched.
    try {
      const { useWorkspaceStore } = await import("./store");
      const state = useWorkspaceStore.getState();
      if (state.runtime && typeof state.runtime.cancel === "function") {
        try {
          state.runtime.cancel();
        } catch {
          // Ignore: cancelling a non-running command is not a disconnect failure.
        }
      }
      useWorkspaceStore.setState({
        runtime: null,
        pathEnabled: false,
        pendingCommand: null,
        runningCommand: false,
        lastCommandResult: null,
        commandError: null
      });
    } catch {
      // Store unavailable (e.g. SSR): connection state is already disconnected.
    }
  },

  markUnavailable: (detail) => {
    if (get().status !== "connected") return;
    console.debug("[TerminalConnection] connection lost:", detail || "unknown");

    // RC1 fix: a real terminal operation lost the connector — for a transient
    // failure on a verified install that is exactly what the bounded recovery
    // session repairs, so route INTO recovery instead of dead-ending the
    // session with the heartbeat stopped and no watcher. Policy/permission
    // refusals and machines without a recoverable install keep the honest,
    // user-driven dead end (they need a human, not a retry loop).
    if (classifyFailureDetail(detail) === "transient") {
      const diag = classifyTerminalFailure({ ok: false, reason: "unreachable" }, diagnosticContext());
      if (canAutoRecover(diag)) {
        const trigger = sanitizeRecoveryTrigger(detail);
        console.debug(`[TerminalConnection] transient terminal failure — starting bounded recovery (${trigger})`);
        void get().recover(trigger);
        return;
      }
    }

    stopHeartbeat();
    heartbeatMisses = 0;
    const diag = classifyTerminalFailure({ ok: false, reason: "unreachable" }, diagnosticContext());
    set({
      status: "unavailable",
      failureReason: "unreachable",
      diagnosticCode: diag.code,
      recoveryStep: null,
      lastVerifiedAt: null,
      lastError: detail || "connector unavailable",
      justConnected: false
    });
  },

  beginSetup: () => {
    connectionGeneration += 1;
    if (activeRecoveryCancel) activeRecoveryCancel.cancelled = true;
    stopHeartbeat();
    heartbeatMisses = 0;
    writeDisconnectedByUser(false);
    set({
      status: "setting_up",
      failureReason: null,
      diagnosticCode: "connector_not_installed",
      recoveryStep: null,
      recoveryAttempt: 0,
      lastVerifiedAt: null,
      justConnected: false,
      lastRestartRequested: false,
      lastError: null
    });
  },

  recover: (trigger) => runRecoverySession(trigger),

  cancelRecovery: () => {
    if (activeRecoveryCancel) activeRecoveryCancel.cancelled = true;
    connectionGeneration += 1;
    stopHeartbeat();
    heartbeatMisses = 0;
    if (get().status !== "recovering") return;
    set({
      status: "unavailable",
      failureReason: "unreachable",
      diagnosticCode: "connector_stopped",
      recoveryStep: null,
      lastVerifiedAt: null,
      justConnected: false,
      lastError: "recovery cancelled"
    });
  }
}));

// Single choke point for cross-cutting connection-state reactions:
// 1. the verified execution capability dies whenever the connection leaves
//    `connected`, so capabilities() can never claim `run` while disconnected;
// 2. the recovery monitor arms only in the eligible failure states (verified
//    Windows install, transient-ish reason, not an explicit user disconnect)
//    and disarms everywhere else — including permission/policy outcomes,
//    in-flight connects, and active recovery sessions (those drive their own
//    probes and the heartbeat resumes on success).
useTerminalConnectionStore.subscribe((state, prevState) => {
  if (state.status !== "connected" && prevState.status === "connected") {
    setTerminalRunCapability(false);
  }
  if (isRecoveryMonitorEligible(state.status, state.failureReason)) {
    startRecoveryMonitor();
  } else {
    stopRecoveryMonitor();
  }
});

/** Convenience predicate used by the chat gate and the executor. */
export function isTerminalConnected(): boolean {
  return useTerminalConnectionStore.getState().status === "connected";
}

/** Record that a real terminal operation could not reach the connector. */
export function markUnavailable(detail?: string): void {
  useTerminalConnectionStore.getState().markUnavailable(detail);
}

const TECHNICAL_ERROR_RE =
  /NETWORK_ERROR|ECONNREFUSED|127\.0\.0\.1|localhost|:\d{4,5}\b|CORS|Failed to fetch|NetworkError|chrome:\/\/flags|node local-connector|TIMEOUT: Local terminal/i;

/**
 * Map a raw connector/runtime error to copy that is safe to show in the UI.
 * Technical details (URLs, ports, CORS, stack traces) stay in developer logs.
 * Non-technical messages (policy denials, validation errors) pass through.
 */
export function toUserFacingTerminalError(raw: string): string {
  if (!TECHNICAL_ERROR_RE.test(raw)) return raw;
  return "Terminal connection unavailable. Open the Terminal panel, connect to your terminal, then try again.";
}

/** Reset to a clean disconnected state (used by tests). */
export function resetTerminalConnection(): void {
  connectionGeneration += 1;
  if (activeRecoveryCancel) activeRecoveryCancel.cancelled = true;
  recoveryInFlight = null;
  establishInFlight = null;
  healthProbeInFlight = null;
  stopHeartbeat();
  stopRecoveryMonitor();
  heartbeatMisses = 0;
  setTerminalRunCapability(false);
  recordRecoverySuccess(breaker);
  writeDisconnectedByUser(false);
  useTerminalConnectionStore.setState({
    status: "disconnected",
    failureReason: null,
    diagnosticCode: null,
    recoveryStep: null,
    recoveryAttempt: 0,
    lastVerifiedAt: null,
    justConnected: false,
    lastRestartRequested: false,
    lastError: null
  });
}
