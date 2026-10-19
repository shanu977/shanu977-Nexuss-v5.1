// Structured, safe diagnosis of terminal-connector failures.
//
// Turns a classified probe result plus minimal local context (setup marker,
// platform) into a stable error code, one-line user guidance, and a bounded
// list of approved recovery actions. Codes and messages are the ONLY diagnosis
// surface the UI may show — they never carry ports, paths, origins, stack
// traces or environment details, matching the sanitization rules enforced on
// runtime errors in localTerminalRuntime.ts.

import type { ConnectorProbeResult } from "./localTerminalRuntime";

/**
 * Health-contract protocol this web app was built against and the oldest
 * connector protocol it can still talk to. Protocol-less (pre-versioning)
 * connectors satisfy the base health contract and remain compatible; a
 * connector answering with an explicitly lower protocol is treated as
 * incompatible and offered the safe, idempotent update path (re-running the
 * one-time setup re-downloads the current connector). Keep MIN in sync with
 * CONNECTOR_PROTOCOL in local-connector/server.js when breaking the contract.
 */
export const CURRENT_CONNECTOR_PROTOCOL = 2;
export const MIN_COMPATIBLE_PROTOCOL = 1;

export type TerminalDiagnosticCode =
  /** Never verified on this browser — the one-time setup has not been completed. */
  | "connector_not_installed"
  /** Previously verified install is present but not answering (stopped/crashed). */
  | "connector_stopped"
  /** A recovery restart was requested; waiting for the connector to come up. */
  | "connector_starting"
  /** Reachable, but the health answer did not match the expected contract. */
  | "connector_unhealthy"
  /** Reachable and healthy-shaped, but speaks an outdated protocol. */
  | "connector_incompatible"
  /** Something other than the connector is answering on the connector's address. */
  | "port_conflict"
  /** Browser Local Network Access permission is denied or awaiting a decision. */
  | "browser_permission_denied"
  /** The request timed out — often transient (busy machine, slow start). */
  | "connection_timeout"
  /** Connection refused / network error — typically a stopped connector. */
  | "connection_refused"
  /** The connector refused this origin (security policy — never bypassed). */
  | "security_policy_denial"
  /** A required local runtime (Node.js) is missing on this computer. */
  | "missing_dependency"
  /** Nothing classified the failure — surface a generic retry path. */
  | "unknown";

export type RecoveryAction =
  /** Re-run the health probe (cheap, used while a start may still be in flight). */
  | "retry_probe"
  /** Ask the locally registered launcher to start the connector (consented). */
  | "restart_connector"
  /** Re-offer the one-time setup (also serves as the safe update path). */
  | "run_setup"
  /** Guide the user to grant Local Network Access in the browser. */
  | "grant_permission"
  /** Guide the user to resolve a conflicting program / missing runtime. */
  | "manual_intervention";

export interface TerminalDiagnostic {
  code: TerminalDiagnosticCode;
  /** Approved, ordered recovery actions. Recovery never exceeds this list. */
  recovery: RecoveryAction[];
  /**
   * One-line, user-safe guidance. Static per code (plus one bounded dynamic
   * detail for the incompatible case) — never interpolated from raw errors.
   */
  message: string;
}

/** Context the classifier may use beyond the probe itself. */
export interface DiagnosticContext {
  /** This browser profile previously verified a working connector. */
  setupVerified: boolean;
  /** Setup / restart machinery is Windows-only today. */
  windows: boolean;
  /** Protocol reported by the most recent healthy probe, when known. */
  protocol?: number;
}

function incompatibleMessage(): string {
  return "Your terminal service needs a small update. Run the setup file again to update it.";
}

/**
 * Map a probe result to a structured diagnosis. Pure: same inputs, same
 * output. Recovery lists are approved actions only — the caller must never
 * invent additional ones (e.g. it may not bypass a security_policy_denial).
 */
export function classifyTerminalFailure(
  probe: ConnectorProbeResult,
  ctx: DiagnosticContext
): TerminalDiagnostic {
  if (probe.ok) {
    // A healthy probe is not a failure; callers should not classify one.
    return { code: "unknown", recovery: ["retry_probe"], message: "Terminal connection is ready." };
  }

  switch (probe.reason) {
    case "permission":
      return {
        code: "browser_permission_denied",
        recovery: ["grant_permission", "retry_probe"],
        message:
          "Allow Nexuss to access the local network in your browser, then try again. Check the site permission in your browser's address bar."
      };

    case "timeout":
      // A timeout while a just-requested restart may still be in flight is a
      // starting state, not a dead connector.
      return {
        code: "connector_starting",
        recovery: ["retry_probe"],
        message: "Waiting for the terminal service to respond…"
      };

    case "unreachable":
      if (ctx.windows && ctx.setupVerified) {
        return {
          code: "connector_stopped",
          recovery: ["restart_connector", "retry_probe", "run_setup"],
          message: "Your terminal service isn't running. Nexuss will try to start it again."
        };
      }
      return {
        code: "connector_not_installed",
        recovery: ["run_setup"],
        message:
          "Terminal access needs a one-time setup on this computer before Nexuss can connect."
      };

    case "http-error":
      // 403 from the connector itself is an origin/security refusal — a real
      // policy denial that must never be "recovered" by bypassing it.
      if (probe.httpStatus === 403) {
        return {
          code: "security_policy_denial",
          recovery: ["manual_intervention"],
          message: "This site isn't allowed to use the local terminal service. If you didn't expect this, no changes were made."
        };
      }
      if (probe.httpStatus !== undefined && probe.httpStatus >= 500) {
        return {
          code: "connector_unhealthy",
          recovery: ["restart_connector", "retry_probe", "run_setup"],
          message: "The terminal service answered with an internal error. Nexuss will try restarting it."
        };
      }
      return {
        code: "connector_unhealthy",
        recovery: ["retry_probe", "run_setup"],
        message: "The terminal service responded, but not in a way Nexuss understands. Reconnecting…"
      };

    case "invalid-response":
      // Something answered with 200 but not the connector contract — most
      // often another program on the connector's address, or a stale proxy.
      if (ctx.protocol !== undefined && ctx.protocol < MIN_COMPATIBLE_PROTOCOL) {
        return {
          code: "connector_incompatible",
          recovery: ["run_setup"],
          message: incompatibleMessage()
        };
      }
      return {
        code: "port_conflict",
        recovery: ["manual_intervention", "retry_probe"],
        message:
          "Another program on this computer is using the terminal connection. Close it or restart your computer, then try again."
      };

    default:
      return {
        code: "unknown",
        recovery: ["retry_probe", "run_setup"],
        message: "Couldn't verify the terminal connection. Trying again…"
      };
  }
}

/**
 * True when a successful health probe reports a compatible protocol. A
 * missing protocol means a pre-versioning connector that still satisfies the
 * base contract — compatible until MIN is raised. Only an explicitly lower
 * protocol is refused.
 */
export function isProtocolCompatible(protocol: number | undefined): boolean {
  if (protocol === undefined) return true;
  return protocol >= MIN_COMPATIBLE_PROTOCOL;
}

/** Diagnosis for a healthy-but-incompatible probe (protocol below minimum). */
export function incompatibleInstallDiagnostic(): TerminalDiagnostic {
  return {
    code: "connector_incompatible",
    recovery: ["run_setup"],
    message: incompatibleMessage()
  };
}
