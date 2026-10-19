import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import WorkspacePanel from "@/components/WorkspacePanel";
import { useWorkspaceStore } from "@/workspace/store";
import {
  useTerminalConnectionStore,
  resetTerminalConnection
} from "@/workspace/terminalConnection";

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

  it("shows the error screen with a Try Again action, without technical details", async () => {
    useTerminalConnectionStore.setState({
      status: "error",
      failureReason: "invalid-response",
      lastError: "unexpected health response"
    });
    render(<WorkspacePanel />);
    // The passive check re-attempts once and settles back to the error screen.
    expect(await screen.findByText("Terminal connection failed", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("node local-connector/server.js")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try Again/ })).toBeInTheDocument();
    expect(screen.queryByText(/127\.0\.0\.1|ECONNREFUSED|Failed to fetch/)).not.toBeInTheDocument();
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

  it("shows the connector-unavailable screen with the startup command when unreachable", async () => {
    stubHealth(false);
    render(<WorkspacePanel />);
    const connectBtn = await screen.findByRole("button", { name: /Connect Terminal/ }, { timeout: 5000 });
    fireEvent.click(connectBtn);

    expect(await screen.findByText("Local connector not running", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("node local-connector/server.js")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try Again/ })).toBeInTheDocument();
    expect(useTerminalConnectionStore.getState().status).toBe("unavailable");
    expect(screen.queryByText(/127\.0\.0\.1|ECONNREFUSED|Failed to fetch/)).not.toBeInTheDocument();
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
