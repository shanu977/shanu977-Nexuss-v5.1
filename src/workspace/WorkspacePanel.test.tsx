import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import WorkspacePanel from "@/components/WorkspacePanel";
import { useWorkspaceStore } from "@/workspace/store";
import {
  useTerminalConnectionStore,
  resetTerminalConnection
} from "@/workspace/terminalConnection";
import { isWindowsPlatform, hasTerminalSetupVerified } from "@/workspace/terminalSetup";
import { configureTerminalRecovery } from "@/workspace/terminalRecovery";
import { clearConnectorLauncherMemory } from "@/workspace/connectorProtocol";

// Deterministic platform: the setup/recovery branches key off Windows, and
// jsdom's UA varies with the host OS.
vi.mock("@/workspace/terminalSetup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/workspace/terminalSetup")>();
  return { ...actual, isWindowsPlatform: vi.fn(actual.isWindowsPlatform) };
});

/** Health response the local connector answers with when it is running. */
function healthOk() {
  return new Response(JSON.stringify({ status: "ok", connector: "nexuss-local", terminal: "enabled" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/** Stub the connector health probe: reachable or unreachable. */
function stubHealth(reachable: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (!reachable) throw new Error("Failed to fetch");
      return healthOk();
    })
  );
}

beforeEach(async () => {
  resetTerminalConnection();
  clearConnectorLauncherMemory();
  vi.mocked(isWindowsPlatform).mockReturnValue(true);
  window.localStorage.removeItem("nexuss.terminal.setupVerified");
  await useWorkspaceStore.getState().disconnect();
  useWorkspaceStore.getState().closePanel();
});

afterEach(async () => {
  await useWorkspaceStore.getState().disconnect();
  cleanup();
  resetTerminalConnection();
  vi.unstubAllGlobals();
});

describe("WorkspacePanel connection screen", () => {
  beforeEach(() => {
    // Passive check on mount must not reach a connector.
    stubHealth(false);
  });

  it("shows the one-click connect screen when the terminal is not connected", async () => {
    render(<WorkspacePanel />);
    // The passive check runs on mount; wait for it to settle back to the
    // connect screen before asserting.
    expect(await screen.findByRole("button", { name: /Connect Terminal/ }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByLabelText("Terminal workspace")).toBeInTheDocument();
    expect(screen.getByText("Connect Nexuss to your computer's terminal.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect workspace/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Try demo workspace/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Connect a folder/)).not.toBeInTheDocument();
    expect(screen.queryByText(/127\.0\.0\.1|ECONNREFUSED|Failed to fetch/)).not.toBeInTheDocument();
  });

  it("starts expanded on the connection screen and toggles via the header", async () => {
    render(<WorkspacePanel />);
    const toggle = screen.getByRole("button", { name: /Terminal/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await screen.findByRole("button", { name: /Connect Terminal/ }, { timeout: 5000 });

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Connect Terminal/ })).toBeInTheDocument();
  });

  it("shows the connecting screen while the connector is being verified", () => {
    useTerminalConnectionStore.setState({ status: "connecting" });
    render(<WorkspacePanel />);
    expect(screen.getByText("Connecting to your terminal...")).toBeInTheDocument();
    expect(screen.getByLabelText("Connecting to terminal")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect Terminal/ })).not.toBeInTheDocument();
  });

  it("offers the one-time setup card on failure without any technical details", async () => {
    useTerminalConnectionStore.setState({
      status: "error",
      failureReason: "invalid-response",
      lastError: "unexpected health response"
    });
    render(<WorkspacePanel />);
    // Passive check re-attempts and settles back to the failure screen.
    // (Heading + button share the label, so use findAllByText.)
    expect(
      (await screen.findAllByText("Set up terminal access", {}, { timeout: 5000 })).length
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Set up terminal access/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    expect(
      screen.queryByText(/node local-connector|server\.js|127\.0\.0\.1|localhost|ECONNREFUSED|Failed to fetch/)
    ).not.toBeInTheDocument();
  });

  it("connects the terminal after clicking Connect Terminal", async () => {
    stubHealth(false);
    render(<WorkspacePanel />);
    const connectBtn = await screen.findByRole("button", { name: /Connect Terminal/ }, { timeout: 5000 });
    // The connector starts, then the user connects with one click.
    stubHealth(true);
    fireEvent.click(connectBtn);

    expect(await screen.findByText("Terminal Connected", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Disconnect/ })).toBeInTheDocument();
    expect(
      screen.getByText("Nexuss can now execute authorized terminal tasks on this device.")
    ).toBeInTheDocument();
    expect(useTerminalConnectionStore.getState().status).toBe("connected");
  });

  it("shows the first-time setup offer when the connector is unreachable", async () => {
    stubHealth(false);
    render(<WorkspacePanel />);
    const connectBtn = await screen.findByRole("button", { name: /Connect Terminal/ }, { timeout: 5000 });
    fireEvent.click(connectBtn);

    expect(
      (await screen.findAllByText("Set up terminal access", {}, { timeout: 5000 })).length
    ).toBeGreaterThan(0);
    expect(hasTerminalSetupVerified()).toBe(false);
    expect(useTerminalConnectionStore.getState().status).toBe("unavailable");
    expect(
      screen.queryByText(/node local-connector|server\.js|127\.0\.0\.1|localhost|port/)
    ).not.toBeInTheDocument();
  });

  it("shows the simple recovery screen after a previously working setup", async () => {
    // A verified install triggers one bounded auto-recovery session before the
    // failure screen — keep it fast and deterministic for the test.
    const prevCfg = configureTerminalRecovery({ baseDelayMs: 5, maxDelayMs: 10, maxAttempts: 1, jitterRatio: 0 });
    try {
      window.localStorage.setItem("nexuss.terminal.setupVerified", "1");
      stubHealth(false);
      render(<WorkspacePanel />);
      const connectBtn = await screen.findByRole("button", { name: /Connect Terminal/ }, { timeout: 5000 });
      fireEvent.click(connectBtn);

      expect(await screen.findByText("Terminal connection lost", {}, { timeout: 5000 })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Set up again/ })).toBeInTheDocument();
    } finally {
      configureTerminalRecovery(prevCfg);
    }
  });

  it("shows the recovering screen with progress and Cancel during a repair", async () => {
    useTerminalConnectionStore.setState({
      status: "recovering",
      recoveryStep: "restarting",
      recoveryAttempt: 0
    });
    render(<WorkspacePanel />);
    expect(screen.getByText("Recovering connection…")).toBeInTheDocument();
    expect(screen.getByText("Restarting the terminal service…")).toBeInTheDocument();
    expect(screen.getByLabelText("Recovering terminal connection")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Cancel/ })).toBeInTheDocument();
    expect(screen.queryByText("Terminal Connected")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(useTerminalConnectionStore.getState().status).toBe("unavailable");
  });

  it("shows the setup progress screen while the one-time setup is in progress", async () => {
    useTerminalConnectionStore.setState({ status: "setting_up" });
    render(<WorkspacePanel />);
    expect(screen.getByText("Setting up terminal access")).toBeInTheDocument();
    expect(screen.getByLabelText("Setting up terminal")).toBeInTheDocument();
    expect(screen.getByText(/Nexuss-Terminal-Setup\.cmd/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download setup file again/ })).toBeInTheDocument();
    expect(screen.queryByText(/127\.0\.0\.1|ECONNREFUSED|localhost/)).not.toBeInTheDocument();
  });

  it("downloads the guided setup file when Set up terminal access is clicked", async () => {
    stubHealth(false);
    const createObjectURL = vi.fn(() => "blob:setup");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    let captured: { download: string; href: string } | null = null;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        captured = { download: this.download, href: this.href };
      });

    render(<WorkspacePanel />);
    const connectBtn = await screen.findByRole("button", { name: /Connect Terminal/ }, { timeout: 5000 });
    fireEvent.click(connectBtn);
    fireEvent.click(await screen.findByRole("button", { name: /Set up terminal access/ }, { timeout: 5000 }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(captured).not.toBeNull();
    expect(captured!.download).toBe("Nexuss-Terminal-Setup.cmd");
    expect(captured!.href).toBe("blob:setup");
    clickSpy.mockRestore();
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it("explains the platform limitation instead of setup on non-Windows", async () => {
    vi.mocked(isWindowsPlatform).mockReturnValue(false);
    stubHealth(false);
    render(<WorkspacePanel />);
    const connectBtn = await screen.findByRole("button", { name: /Connect Terminal/ }, { timeout: 5000 });
    fireEvent.click(connectBtn);

    expect(await screen.findByText("Terminal access unavailable", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/supports Windows computers/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Set up terminal access/ })).not.toBeInTheDocument();
  });

  it("marks the one-time setup as verified after a successful connection", async () => {
    stubHealth(false);
    render(<WorkspacePanel />);
    const connectBtn = await screen.findByRole("button", { name: /Connect Terminal/ }, { timeout: 5000 });
    stubHealth(true);
    fireEvent.click(connectBtn);

    expect(await screen.findByText("Terminal Connected", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(hasTerminalSetupVerified()).toBe(true);
  });

  it("shows permission guidance when the browser blocks the local-network request", async () => {
    stubHealth(false);
    Object.defineProperty(window.navigator, "permissions", {
      configurable: true,
      value: { query: vi.fn(async () => ({ state: "denied" })) }
    });
    render(<WorkspacePanel />);
    const connectBtn = await screen.findByRole("button", { name: /Connect Terminal/ }, { timeout: 5000 });
    fireEvent.click(connectBtn);

    expect(await screen.findByText("Local network permission required", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try Again/ })).toBeInTheDocument();
    expect(useTerminalConnectionStore.getState().status).toBe("permission_required");
    delete (window.navigator as unknown as { permissions?: unknown }).permissions;
  });

  it("explains an origin-blocked refusal without leaking technical details", async () => {
    useTerminalConnectionStore.setState({
      status: "error",
      failureReason: "origin_blocked",
      diagnosticCode: "origin_blocked"
    });
    render(<WorkspacePanel />);

    expect(
      await screen.findByText("Terminal access blocked for this site", {}, { timeout: 5000 })
    ).toBeInTheDocument();
    expect(screen.getByText(/isn't allowed to use the local terminal service/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try Again/ })).toBeInTheDocument();
    expect(
      screen.queryByText(/127\.0\.0\.1|CORS|localhost|ECONNREFUSED|allowlist/)
    ).not.toBeInTheDocument();
  });

  it("tells the user to allow the OS dialog after a restart request was issued", async () => {
    window.localStorage.setItem("nexuss.terminal.setupVerified", "1");
    stubHealth(false);
    useTerminalConnectionStore.setState({
      status: "unavailable",
      failureReason: "unreachable",
      lastRestartRequested: true
    });
    render(<WorkspacePanel />);

    expect(await screen.findByText(/asks to open/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/Terminal connection lost/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });

  it("omits the OS-dialog hint when no restart request was ever issued", async () => {
    // Same verified-install failure screen, but this cycle never issued a
    // launcher request — the Allow hint must not appear.
    window.localStorage.setItem("nexuss.terminal.setupVerified", "1");
    stubHealth(false);
    useTerminalConnectionStore.setState({
      status: "unavailable",
      failureReason: "unreachable",
      lastRestartRequested: false
    });
    render(<WorkspacePanel />);

    expect(await screen.findByText(/Terminal connection lost/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(/asks to open/)).not.toBeInTheDocument();
  });

  it("Disconnect returns to the connect screen and is remembered for the session", async () => {
    stubHealth(false);
    render(<WorkspacePanel />);
    const connectBtn = await screen.findByRole("button", { name: /Connect Terminal/ }, { timeout: 5000 });
    stubHealth(true);
    fireEvent.click(connectBtn);
    expect(await screen.findByText("Terminal Connected", {}, { timeout: 5000 })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Disconnect/ }));

    expect(await screen.findByRole("button", { name: /Connect Terminal/ }, { timeout: 5000 })).toBeInTheDocument();
    expect(useTerminalConnectionStore.getState().status).toBe("disconnected");
    expect(window.sessionStorage.getItem("nexuss.terminal.disconnected")).toBe("1");
  });

  it("closes the panel via the header close button", () => {
    useWorkspaceStore.getState().openPanel();
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByLabelText("Close workspace panel"));
    expect(useWorkspaceStore.getState().panelOpen).toBe(false);
  });
});

describe("WorkspacePanel connected workspace", () => {
  beforeEach(async () => {
    stubHealth(true);
    useTerminalConnectionStore.setState({
      status: "connected",
      lastVerifiedAt: Date.now(),
      justConnected: false,
      lastError: null
    });
    await useWorkspaceStore.getState().connectDemo();
    useWorkspaceStore.setState({ pathEnabled: true });
  });

  it("shows the verified connection status with a Disconnect action", () => {
    render(<WorkspacePanel />);
    expect(screen.getByText("Terminal Connected")).toBeInTheDocument();
    expect(
      screen.getByText("Nexuss can use the authorized terminal on this device.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Disconnect/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect Terminal/ })).not.toBeInTheDocument();
  });

  it("runs a hybrid search and lists ranked results", async () => {
    render(<WorkspacePanel />);
    // Expands the collapsed connected panel to reveal search.
    fireEvent.click(screen.getByRole("button", { name: /Terminal/i }));
    const input = await screen.findByPlaceholderText("Search files, symbols, error text…");
    fireEvent.change(input, { target: { value: "login" } });
    const result = await screen.findByText("src/auth/login.ts");
    expect(result).toBeInTheDocument();
  });

  it("shows no-matches feedback for an unmatched query", async () => {
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: /Terminal/i }));
    const input = await screen.findByPlaceholderText("Search files, symbols, error text…");
    fireEvent.change(input, { target: { value: "zzzznothing" } });
    expect(await screen.findByText("No matches.")).toBeInTheDocument();
  });
});

describe("WorkspacePanel agent section", () => {
  beforeEach(async () => {
    stubHealth(true);
    useTerminalConnectionStore.setState({
      status: "connected",
      lastVerifiedAt: Date.now(),
      justConnected: false,
      lastError: null
    });
    await useWorkspaceStore.getState().connectDemo();
    useWorkspaceStore.setState({ pathEnabled: true, pendingChanges: [], agentLog: [], changeError: null });
  });

  it("shows a staged change with its diff and approval controls", async () => {
    await useWorkspaceStore
      .getState()
      .proposeChangeFromBlock([{ path: "README.md", content: "# Changed\n" }]);

    render(<WorkspacePanel />);

    expect(
      screen.getByText(/Proposed changes — review before applying/)
    ).toBeInTheDocument();
    expect(screen.getByText(/write README.md/)).toBeInTheDocument();
    expect(screen.getByText(/\+# Changed/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Approve & apply/ })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reject/ })).toBeInTheDocument();
  });

  it("applies the change on approval", async () => {
    await useWorkspaceStore
      .getState()
      .proposeChangeFromBlock([{ path: "README.md", content: "# Approved\n" }]);

    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: /Approve & apply/ }));

    expect(await screen.findByText(/Applied 1 change/)).toBeInTheDocument();
    const bridge = useWorkspaceStore.getState().bridge as unknown as {
      read: (p: string) => Promise<string>;
    };
    expect(await bridge.read("README.md")).toBe("# Approved\n");
    expect(useWorkspaceStore.getState().pendingChanges).toHaveLength(0);
  });

  it("discards the change on reject without writing", async () => {
    await useWorkspaceStore
      .getState()
      .proposeChangeFromBlock([{ path: "README.md", content: "# Rejected\n" }]);

    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: /Reject/ }));

    const bridge = useWorkspaceStore.getState().bridge as unknown as {
      read: (p: string) => Promise<string>;
    };
    expect(await bridge.read("README.md")).toContain("# Nexuss Sample Workspace");
    expect(useWorkspaceStore.getState().pendingChanges).toHaveLength(0);
  });

  it("surfaces a version-conflict alert without overwriting the file", async () => {
    await useWorkspaceStore
      .getState()
      .proposeChangeFromBlock([{ path: "README.md", content: "# Conflicted\n" }]);

    // External edit after the change was staged.
    const bridge = useWorkspaceStore.getState().bridge as unknown as {
      write: (p: string, c: string) => Promise<void>;
      read: (p: string) => Promise<string>;
    };
    await bridge.write("README.md", "# Externally edited\n");

    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: /Approve & apply/ }));

    expect(
      await screen.findByText(/changed after it was read/i)
    ).toBeInTheDocument();
    expect(await bridge.read("README.md")).toBe("# Externally edited\n");
    expect(useWorkspaceStore.getState().pendingChanges).toHaveLength(1);
  });

  it("shows recent agent activity when there are no pending changes", async () => {
    useWorkspaceStore.setState({
      agentLog: [
        { kind: "apply", message: "Applied 1 change: README.md", at: 1 }
      ]
    });

    render(<WorkspacePanel />);
    expect(screen.getByText(/Recent agent activity/)).toBeInTheDocument();
    expect(screen.getByText("Applied 1 change: README.md")).toBeInTheDocument();
  });
});

describe("WorkspacePanel command execution card", () => {
  beforeEach(async () => {
    (window as unknown as {
      nexussDesktop: { runtime: { run: () => Promise<unknown>; test: () => Promise<unknown>; capabilities: () => { run: boolean; test: boolean } } }
    }).nexussDesktop = {
      runtime: {
        run: async () => ({ success: true }),
        test: async () => ({ success: true }),
        capabilities: () => ({ run: true, test: true })
      }
    };
    stubHealth(true);
    useTerminalConnectionStore.setState({
      status: "connected",
      lastVerifiedAt: Date.now(),
      justConnected: false,
      lastError: null
    });
    await useWorkspaceStore.getState().disconnect();
    await useWorkspaceStore.getState().connectDemo();
    useWorkspaceStore.setState({
      pathEnabled: true,
      pendingChanges: [],
      agentLog: [],
      changeError: null,
      pendingCommand: null,
      runningCommand: false,
      lastCommandResult: null,
      commandError: null
    });
  });

  afterEach(async () => {
    (window as unknown as { nexussDesktop?: unknown }).nexussDesktop = undefined;
    await useWorkspaceStore.getState().disconnect();
  });

  it("shows a staged run command with Run/Reject controls", async () => {
    await useWorkspaceStore.getState().proposeCommandFromBlock({
      run: { command: "npm test" }
    });

    render(<WorkspacePanel />);

    expect(screen.getByText(/Command execution/)).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reject/ })).toBeInTheDocument();
  });

  it("rejects a staged command without executing it", async () => {
    await useWorkspaceStore.getState().proposeCommandFromBlock({
      run: { command: "npm test" }
    });

    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: /Reject/ }));

    expect(useWorkspaceStore.getState().pendingCommand).toBeNull();
    expect(useWorkspaceStore.getState().lastCommandResult).toBeNull();
  });

  it("runs a staged command and surfaces the result", async () => {
    const captured: string[] = [];
    (window as unknown as {
      nexussDesktop: {
        runtime: {
          run: (req: { command: string }) => Promise<unknown>;
          test: () => Promise<unknown>;
          capabilities: () => { run: boolean; test: boolean };
        };
      }
    }).nexussDesktop = {
      runtime: {
        run: async (req: { command: string }) => {
          captured.push(req.command);
          return { command: req.command, cwd: "", exitCode: 0, stdout: "passed", stderr: "", durationMs: 5, timedOut: false, killed: false, success: true, outputTruncated: false, redacted: false };
        },
        test: async () => ({ success: true }),
        capabilities: () => ({ run: true, test: true })
      }
    };
    await useWorkspaceStore.getState().disconnect();
    await useWorkspaceStore.getState().connectDemo();
    await useWorkspaceStore.getState().proposeCommandFromBlock({
      run: { command: "npm test" }
    });

    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));

    expect(await screen.findByText("passed")).toBeInTheDocument();
    expect(captured).toEqual(["npm test"]);
    expect(useWorkspaceStore.getState().pendingCommand).toBeNull();
  });
});
