// Single source of truth for the Nexuss ⇄ local terminal connector connection.
//
// The UI, the chat gate and the authorized executor all read this store, so
// there is exactly one definition of "terminal is connected". A connection is
// only ever reported as `connected` after the local connector's health endpoint
// has answered AND terminal execution capability has been verified — the state
// is never faked from a frontend boolean.

import { create } from "zustand";
import {
  createLocalConnectorRuntime,
  probeLocalConnector,
  type ConnectorProbeFailureReason,
  type ConnectorProbeResult
} from "./localTerminalRuntime";
import type { NativeRuntimeBridge } from "./bridge";

/**
 * Verified terminal connection state machine:
 *
 * - `disconnected`        — no verified connection; Connect Terminal is shown.
 * - `connecting`          — a verification is in flight; commands stay blocked.
 * - `connected`           — ONLY after the connector health check AND terminal
 *                          capability verification succeeded.
 * - `permission_required` — the browser blocked the local-network request
 *                          (Local Network Access permission denied/blocked).
 * - `unavailable`         — the connector is not running / did not answer
 *                          (connection refused or timed out).
 * - `error`               — reachable but the response was invalid, HTTP error,
 *                          or terminal capability could not be verified.
 */
export type TerminalConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "permission_required"
  | "unavailable"
  | "error";

/** Classified reason behind a non-connected terminal state (never rendered raw). */
export type TerminalFailureReason = ConnectorProbeFailureReason | "capability" | null;

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
function probeConnector(): Promise<ConnectorProbeResult> {
  if (!healthProbeInFlight) {
    healthProbeInFlight = probeLocalConnector({ force: true }).finally(() => {
      healthProbeInFlight = null;
    });
  }
  return healthProbeInFlight;
}

/** Outcome of a full establish (health + capability) attempt. */
type EstablishResult = { ok: true } | { ok: false; reason: Exclude<TerminalFailureReason, null> };

/** Map a failed establish to the state that is most actionable for the user. */
function statusForFailure(reason: Exclude<TerminalFailureReason, null>): TerminalConnectionStatus {
  if (reason === "permission") return "permission_required";
  if (reason === "timeout" || reason === "unreachable") return "unavailable";
  return "error";
}

/** Deduped health + capability verification shared by passive and active connects. */
let establishInFlight: Promise<EstablishResult> | null = null;
function establishConnection(): Promise<EstablishResult> {
  if (!establishInFlight) {
    establishInFlight = (async (): Promise<EstablishResult> => {
      const probe = await probeConnector();
      if (!probe.ok) return probe;
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
 * Verify terminal execution capability is really available: the runtime object
 * must exist and advertise `run`. Returns false instead of faking success.
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
    const caps = typeof runtime.capabilities === "function" ? runtime.capabilities() : null;
    if (!caps?.run) return false;
    // A verified connection grants terminal/workspace capability for the session.
    useWorkspaceStore.setState({ pathEnabled: true });
    return true;
  } catch {
    return false;
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer !== null || typeof window === "undefined") return;
  heartbeatTimer = setInterval(() => {
    void heartbeatTick();
  }, HEARTBEAT_INTERVAL_MS);
}

async function heartbeatTick(): Promise<void> {
  const status = useTerminalConnectionStore.getState().status;
  if (status !== "connected") {
    stopHeartbeat();
    return;
  }
  const probe = await probeConnector();
  if (!probe.ok) {
    useTerminalConnectionStore.getState().markUnavailable("connector stopped responding");
  }
}

export interface TerminalConnectionState {
  /** Verified connection state — the single source of truth. */
  status: TerminalConnectionStatus;
  /** Classified reason behind a non-connected state; never rendered raw. */
  failureReason: TerminalFailureReason;
  /** When the connector was last positively verified. */
  lastVerifiedAt: number | null;
  /** True when the user connected via the Connect button in this session. */
  justConnected: boolean;
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
}

export const useTerminalConnectionStore = create<TerminalConnectionState>()((set, get) => ({
  status: "disconnected",
  failureReason: null,
  lastVerifiedAt: null,
  justConnected: false,
  lastError: null,

  checkConnection: async () => {
    const prev = get().status;
    if (prev === "connecting") return prev;

    if (prev === "connected") {
      const probe = await probeConnector();
      if (!probe.ok) {
        get().markUnavailable("health check failed");
        return get().status;
      }
      set({ lastVerifiedAt: Date.now(), lastError: null, failureReason: null });
      return "connected";
    }

    // The user explicitly disconnected this session: wait for an explicit Connect.
    if (readDisconnectedByUser()) return prev;

    set({ status: "connecting" });
    const result = await establishConnection();
    // Another flow (an explicit Connect click) may have finished first.
    if (get().status !== "connecting") return get().status;
    if (result.ok) {
      set({
        status: "connected",
        failureReason: null,
        lastVerifiedAt: Date.now(),
        justConnected: false,
        lastError: null
      });
      startHeartbeat();
      return "connected";
    }
    // Passive failure: keep the previous state (disconnected stays on the
    // connect screen; a previous error keeps showing the error screen).
    set({ status: prev });
    return prev;
  },

  connect: async () => {
    if (get().status === "connecting") {
      // A verification is already in flight — wait for its real outcome.
      const result = await establishConnection();
      if (result.ok) {
        set({
          status: "connected",
          failureReason: null,
          lastVerifiedAt: Date.now(),
          justConnected: true,
          lastError: null
        });
        startHeartbeat();
      } else {
        set({
          status: statusForFailure(result.reason),
          failureReason: result.reason,
          lastError: "connector verification failed",
          lastVerifiedAt: null,
          justConnected: false
        });
      }
      return result.ok;
    }

    stopHeartbeat();
    writeDisconnectedByUser(false);
    set({ status: "connecting", lastError: null, failureReason: null });
    const result = await establishConnection();
    if (get().status !== "connecting") return get().status === "connected";
    if (result.ok) {
      set({
        status: "connected",
        failureReason: null,
        lastVerifiedAt: Date.now(),
        justConnected: true,
        lastError: null
      });
      startHeartbeat();
      return true;
    }
    // Never fake it: only a verified health + capability result counts.
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
    stopHeartbeat();
    writeDisconnectedByUser(true);
    set({
      status: "disconnected",
      failureReason: null,
      lastVerifiedAt: null,
      justConnected: false,
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
    stopHeartbeat();
    set({
      status: "unavailable",
      failureReason: "unreachable",
      lastVerifiedAt: null,
      lastError: detail || "connector unavailable",
      justConnected: false
    });
    console.debug("[TerminalConnection] connection lost:", detail || "unknown");
  }
}));

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
  stopHeartbeat();
  writeDisconnectedByUser(false);
  useTerminalConnectionStore.setState({
    status: "disconnected",
    failureReason: null,
    lastVerifiedAt: null,
    justConnected: false,
    lastError: null
  });
}
