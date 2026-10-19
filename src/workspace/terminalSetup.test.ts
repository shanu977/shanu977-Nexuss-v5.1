import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSetupPowerShell,
  buildSetupCmd,
  downloadTerminalSetup,
  markTerminalSetupVerified,
  hasTerminalSetupVerified,
  isWindowsPlatform
} from "@/workspace/terminalSetup";

const ORIGIN = "https://www.nexuss.in";

function decodeSetupCmd(content: string): string {
  const match = content.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/);
  expect(match).not.toBeNull();
  const bytes = Uint8Array.from(atob(match![1]), (c) => c.charCodeAt(0));
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) {
    out += String.fromCharCode(bytes[i] + (bytes[i + 1] << 8));
  }
  return out;
}

describe("buildSetupPowerShell()", () => {
  it("downloads the connector from the given origin into the user profile", () => {
    const ps = buildSetupPowerShell(ORIGIN);
    expect(ps).toContain(`${ORIGIN}/nexuss-connector.js`);
    expect(ps).toContain("$env:LOCALAPPDATA");
    expect(ps).toContain("nexuss-connector.js");
  });

  it("creates a per-user startup entry and starts the connector now", () => {
    const ps = buildSetupPowerShell(ORIGIN);
    expect(ps).toContain("GetFolderPath('Startup')");
    expect(ps).toContain("Start-Process");
  });

  it("requires no admin or system-wide changes", () => {
    const ps = buildSetupPowerShell(ORIGIN);
    expect(ps).not.toMatch(/Program Files|HKLM|schtasks|runas|Administrator/i);
  });

  it("validates the downloaded file before trusting it", () => {
    expect(buildSetupPowerShell(ORIGIN)).toContain("nexuss-local");
  });

  it("detects a missing Node.js runtime and guides the user to the official download", () => {
    const ps = buildSetupPowerShell(ORIGIN);
    expect(ps).toContain("Get-Command node");
    expect(ps).toContain("nodejs.org");
    // The runtime check must abort setup before anything is installed.
    expect(ps.indexOf("Get-Command node")).toBeLessThan(ps.indexOf("nexuss-connector.js"));
  });

  it("registers a per-user consented protocol launcher with a fixed command", () => {
    const ps = buildSetupPowerShell(ORIGIN);
    expect(ps).toContain("HKCU:\\Software\\Classes\\nexuss");
    expect(ps).toContain("URL Protocol");
    expect(ps).toContain("shell\\open\\command");
    // The registered command is the fixed absolute connector path — the URL
    // itself never carries parameters into the shell.
    expect(ps).toContain("Set-ItemProperty -Path \"$scheme\\shell\\open\\command\" -Name '(default)' -Value ('node \"' + $js + '\"')");
    // Idempotent: re-running setup overwrites in place, never duplicates.
    expect(ps.match(/New-Item -Path \$scheme -Force/g)).not.toBeNull();
  });
});

describe("buildSetupCmd()", () => {
  it("wraps the payload in a double-clickable cmd with an encoded command", () => {
    const { filename, content } = buildSetupCmd(ORIGIN);
    expect(filename).toBe("Nexuss-Terminal-Setup.cmd");
    expect(content.startsWith("@echo off")).toBe(true);
    expect(content).toContain("powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand");

    const decoded = decodeSetupCmd(content);
    expect(decoded).toContain(`${ORIGIN}/nexuss-connector.js`);
    expect(decoded).toContain("Startup");
    expect(decoded).toContain("LOCALAPPDATA");
  });
});

describe("downloadTerminalSetup()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it("triggers a download of the setup file", () => {
    const createObjectURL = vi.fn(() => "blob:setup");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    let captured: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      captured = this.download;
    });

    const filename = downloadTerminalSetup();

    expect(filename).toBe("Nexuss-Terminal-Setup.cmd");
    expect(captured).toBe("Nexuss-Terminal-Setup.cmd");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });
});

describe("setup verified flag", () => {
  it("round-trips through localStorage", () => {
    window.localStorage.removeItem("nexuss.terminal.setupVerified");
    expect(hasTerminalSetupVerified()).toBe(false);
    markTerminalSetupVerified();
    expect(hasTerminalSetupVerified()).toBe(true);
    window.localStorage.removeItem("nexuss.terminal.setupVerified");
  });
});

describe("isWindowsPlatform()", () => {
  it("reflects the current user agent", () => {
    const expected = /windows|win32|win64/i.test(navigator.userAgent);
    expect(isWindowsPlatform()).toBe(expected);
  });
});
