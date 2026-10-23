// The consented restart bridge: a fixed-action nexuss:// URL, launcher
// evidence memory, and SSR-safe fire-and-forget request semantics.

import { afterEach, describe, expect, it } from "vitest";
import {
  clearConnectorLauncherMemory,
  CONNECTOR_START_URL,
  hasConnectorLauncher,
  rememberConnectorProtocol,
  requestConnectorStart
} from "@/workspace/connectorProtocol";

afterEach(() => {
  clearConnectorLauncherMemory();
  document.querySelectorAll("iframe").forEach((f) => f.remove());
});

describe("launcher evidence memory", () => {
  it("records a current-generation protocol and forgets on clear", () => {
    expect(hasConnectorLauncher()).toBe(false);
    rememberConnectorProtocol(2);
    expect(hasConnectorLauncher()).toBe(true);
    clearConnectorLauncherMemory();
    expect(hasConnectorLauncher()).toBe(false);
  });

  it("ignores legacy connectors without a protocol", () => {
    rememberConnectorProtocol(undefined);
    expect(hasConnectorLauncher()).toBe(false);
  });

  it("ignores protocols below the launcher generation", () => {
    rememberConnectorProtocol(1);
    expect(hasConnectorLauncher()).toBe(false);
  });
});

describe("requestConnectorStart()", () => {
  it("fires a hidden iframe at the fixed start URL and reports the request as issued", () => {
    expect(CONNECTOR_START_URL).toBe("nexuss://start-connector");
    const outcome = requestConnectorStart();
    // "requested" only means the DOM navigation was issued — never that the
    // connector actually started (the OS confirmation dialog is invisible).
    expect(outcome).toBe("requested");
    const iframe = document.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute("src")).toBe(CONNECTOR_START_URL);
    expect(iframe!.style.display).toBe("none");
  });

  it("carries no query string, so a page can never pass shell parameters", () => {
    requestConnectorStart();
    const iframe = document.querySelector("iframe")!;
    expect(iframe.getAttribute("src")).not.toMatch(/[?&]/);
  });
});
