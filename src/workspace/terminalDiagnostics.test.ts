// Structured diagnosis must stay safe (no ports/paths/origins) and map each
// real failure mode to an actionable, approved recovery list.

import { describe, expect, it } from "vitest";
import {
  classifyTerminalFailure,
  incompatibleInstallDiagnostic,
  isProtocolCompatible,
  CURRENT_CONNECTOR_PROTOCOL,
  MIN_COMPATIBLE_PROTOCOL,
  type DiagnosticContext
} from "@/workspace/terminalDiagnostics";
import type { ConnectorProbeResult } from "@/workspace/localTerminalRuntime";

const baseCtx: DiagnosticContext = { setupVerified: false, windows: true };

type ProbeFailure = Extract<ConnectorProbeResult, { ok: false }>;

function fail(reason: ProbeFailure["reason"], httpStatus?: number): ConnectorProbeResult {
  return httpStatus === undefined ? { ok: false, reason } : { ok: false, reason, httpStatus };
}

describe("classifyTerminalFailure()", () => {
  it("classifies an unreachable connector on a fresh machine as not installed", () => {
    const diag = classifyTerminalFailure(fail("unreachable"), baseCtx);
    expect(diag.code).toBe("connector_not_installed");
    expect(diag.recovery).toEqual(["run_setup"]);
    expect(diag.message).toMatch(/one-time setup/i);
  });

  it("classifies an unreachable connector on a verified install as stopped with restart recovery", () => {
    const diag = classifyTerminalFailure(fail("unreachable"), { ...baseCtx, setupVerified: true });
    expect(diag.code).toBe("connector_stopped");
    expect(diag.recovery).toContain("restart_connector");
    expect(diag.recovery).toContain("retry_probe");
  });

  it("classifies a timeout as a starting connector with probe-only recovery", () => {
    const diag = classifyTerminalFailure(fail("timeout"), { ...baseCtx, setupVerified: true });
    expect(diag.code).toBe("connector_starting");
    expect(diag.recovery).toEqual(["retry_probe"]);
  });

  it("classifies a permission failure as browser permission, never restart", () => {
    const diag = classifyTerminalFailure(fail("permission"), { ...baseCtx, setupVerified: true });
    expect(diag.code).toBe("browser_permission_denied");
    expect(diag.recovery).not.toContain("restart_connector");
    expect(diag.recovery).toContain("grant_permission");
  });

  it("classifies a 403 as a security-policy denial that is never auto-recovered", () => {
    const diag = classifyTerminalFailure(fail("http-error", 403), { ...baseCtx, setupVerified: true });
    expect(diag.code).toBe("security_policy_denial");
    expect(diag.recovery).toEqual(["manual_intervention"]);
  });

  it("classifies a 5xx as an unhealthy connector eligible for restart", () => {
    const diag = classifyTerminalFailure(fail("http-error", 500), { ...baseCtx, setupVerified: true });
    expect(diag.code).toBe("connector_unhealthy");
    expect(diag.recovery).toContain("restart_connector");
  });

  it("classifies a foreign 200 response as a port conflict with manual guidance", () => {
    const diag = classifyTerminalFailure(fail("invalid-response"), { ...baseCtx, setupVerified: true });
    expect(diag.code).toBe("port_conflict");
    expect(diag.recovery).toContain("manual_intervention");
    expect(diag.recovery).not.toContain("restart_connector");
  });

  it("classifies a stale protocol as incompatible with the update path", () => {
    const diag = classifyTerminalFailure(fail("invalid-response"), {
      ...baseCtx,
      setupVerified: true,
      protocol: MIN_COMPATIBLE_PROTOCOL - 1
    });
    expect(diag.code).toBe("connector_incompatible");
    expect(diag.recovery).toEqual(["run_setup"]);
  });

  it("never leaks technical details into any message", () => {
    const ctxs = [baseCtx, { ...baseCtx, setupVerified: true }];
    const probes = [
      fail("unreachable"),
      fail("timeout"),
      fail("permission"),
      fail("http-error", 403),
      fail("http-error", 500),
      fail("invalid-response")
    ];
    for (const ctx of ctxs) {
      for (const probe of probes) {
        const diag = classifyTerminalFailure(probe, ctx);
        expect(diag.message).not.toMatch(/127\.0\.0\.1|localhost|:\d{4,5}|ECONNREFUSED|Failed to fetch|CORS|\.js|C:\\|node /i);
      }
    }
  });
});

describe("isProtocolCompatible()", () => {
  it("accepts the current and any legacy protocol", () => {
    expect(isProtocolCompatible(CURRENT_CONNECTOR_PROTOCOL)).toBe(true);
    expect(isProtocolCompatible(undefined)).toBe(true);
    expect(isProtocolCompatible(MIN_COMPATIBLE_PROTOCOL)).toBe(true);
  });

  it("rejects an explicitly lower protocol", () => {
    expect(isProtocolCompatible(MIN_COMPATIBLE_PROTOCOL - 1)).toBe(false);
    expect(isProtocolCompatible(0)).toBe(false);
  });
});

describe("incompatibleInstallDiagnostic()", () => {
  it("points at the safe setup/update path only", () => {
    const diag = incompatibleInstallDiagnostic();
    expect(diag.code).toBe("connector_incompatible");
    expect(diag.recovery).toEqual(["run_setup"]);
  });
});
