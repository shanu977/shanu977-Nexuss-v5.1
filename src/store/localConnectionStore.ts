// Explicit connection lifecycle for local-model (Ollama) startup/recovery.
//
//   idle → checking → starting → waiting_for_health → connected → idle
//
// The temporary chat card renders only for the active work phases
// (checking / starting / waiting_for_health). `connected` is set the moment
// the connection is verified and cleared by the request's cleanup, and any
// failure/cancellation/chat-switch resets straight back to idle so a stale
// card can never linger in the UI.
//
// `active` gates every phase write: an in-flight connection attempt that was
// invalidated (chat switched, request stopped) can never resurrect the card,
// while a new attempt (or a caller joining one) re-opens the session.

import { create } from "zustand";

export type LocalConnectionPhase =
  | "idle"
  | "checking"
  | "starting"
  | "waiting_for_health"
  | "connected";

/** Phases during which the temporary connection card is shown in the chat. */
export const ACTIVE_LOCAL_CONNECTION_PHASES: ReadonlySet<LocalConnectionPhase> =
  new Set(["checking", "starting", "waiting_for_health"]);

export function isConnectionCardVisible(phase: LocalConnectionPhase): boolean {
  return ACTIVE_LOCAL_CONNECTION_PHASES.has(phase);
}

interface LocalConnectionState {
  phase: LocalConnectionPhase;
  /** Optional extra detail line for the card (never technical internals). */
  detail: string | null;
  /** Bumped on every start and invalidation; useful for tests and stale-guard checks. */
  session: number;
  /** True while a connection attempt owns the lifecycle. */
  active: boolean;
}

export const useLocalConnectionStore = create<LocalConnectionState>()(() => ({
  phase: "idle",
  detail: null,
  session: 0,
  active: false
}));

/**
 * Begin (or resume) a connection attempt. Returns the session number.
 * Resuming an already-active attempt keeps its current phase so the card
 * does not flash back to "checking" mid-startup.
 */
export function startLocalConnection(): number {
  const s = useLocalConnectionStore.getState();
  if (s.active) {
    return s.session;
  }
  const session = s.session + 1;
  useLocalConnectionStore.setState({
    phase: "checking",
    detail: null,
    session,
    active: true
  });
  return session;
}

/** Re-open the lifecycle for a caller joining an in-flight attempt. */
export function resumeLocalConnection(): number {
  const s = useLocalConnectionStore.getState();
  if (s.active) return s.session;
  const session = s.session + 1;
  useLocalConnectionStore.setState({
    phase: "checking",
    detail: null,
    session,
    active: true
  });
  return session;
}

/** Advance the lifecycle. Ignored when no attempt is active (stale writes). */
export function updateLocalConnection(
  phase: Exclude<LocalConnectionPhase, "idle">,
  detail?: string | null
): void {
  const s = useLocalConnectionStore.getState();
  if (!s.active) return;
  useLocalConnectionStore.setState({
    phase,
    detail: detail ?? null
  });
}

/** Settle into `connected` after a verified connection. */
export function markLocalConnectionVerified(): void {
  updateLocalConnection("connected", null);
}

/** End the attempt and hide the card. Safe to call multiple times. */
export function finishLocalConnection(): void {
  useLocalConnectionStore.setState({
    phase: "idle",
    detail: null,
    active: false
  });
}

/**
 * Hard reset for chat switching, Stop, and store resets. Bumps the session so
 * any in-flight attempt's later writes are ignored.
 */
export function invalidateLocalConnection(): void {
  const s = useLocalConnectionStore.getState();
  useLocalConnectionStore.setState({
    phase: "idle",
    detail: null,
    active: false,
    session: s.session + 1
  });
}
