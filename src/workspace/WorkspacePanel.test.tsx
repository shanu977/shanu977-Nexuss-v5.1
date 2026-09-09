import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import WorkspacePanel from "@/components/WorkspacePanel";
import { useWorkspaceStore } from "@/workspace/store";

beforeEach(async () => {
  await useWorkspaceStore.getState().disconnect();
  useWorkspaceStore.getState().closePanel();
});

afterEach(async () => {
  await useWorkspaceStore.getState().disconnect();
  cleanup();
});

describe("WorkspacePanel", () => {
  it("shows terminal workspace when no workspace is connected", () => {
    render(<WorkspacePanel />);
    expect(screen.getByLabelText("Terminal workspace")).toBeInTheDocument();
    expect(screen.getByText("Terminal ready")).toBeInTheDocument();
    expect(screen.getByText(/Nexuss can execute commands when needed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect workspace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try demo workspace" })).not.toBeInTheDocument();
  });

  it("shows terminal ready immediately without folder picker", async () => {
    render(<WorkspacePanel />);
    expect(screen.getByText("Terminal ready")).toBeInTheDocument();
    expect(screen.queryByText(/Connect a folder/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Try sample workspace/)).not.toBeInTheDocument();
  });

  it("runs a hybrid search and lists ranked results", async () => {
    await useWorkspaceStore.getState().connectDemo();
    useWorkspaceStore.setState({ pathEnabled: true });
    render(<WorkspacePanel />);
    // Expand collapsed panel to reveal search
    fireEvent.click(screen.getByRole("button", { name: /Terminal/i }));
    const input = await screen.findByPlaceholderText("Search files, symbols, error text…");
    fireEvent.change(input, { target: { value: "login" } });
    const result = await screen.findByText("src/auth/login.ts");
    expect(result).toBeInTheDocument();
  });

  it("shows no-matches feedback for an unmatched query", async () => {
    await useWorkspaceStore.getState().connectDemo();
    useWorkspaceStore.setState({ pathEnabled: true });
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: /Terminal/i }));
    const input = await screen.findByPlaceholderText("Search files, symbols, error text…");
    fireEvent.change(input, { target: { value: "zzzznothing" } });
    expect(await screen.findByText("No matches.")).toBeInTheDocument();
  });

  it("closes the panel via the header close button", () => {
    useWorkspaceStore.getState().openPanel();
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByLabelText("Close workspace panel"));
    expect(useWorkspaceStore.getState().panelOpen).toBe(false);
  });

  it("shows terminal ready even when folder access is unavailable — no picker required", async () => {
    render(<WorkspacePanel />);
    expect(screen.getByText("Terminal ready")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect workspace" })).not.toBeInTheDocument();
    expect(screen.queryByText(/does not support folder access/i)).not.toBeInTheDocument();
  });

  it("starts collapsed and expands via the header toggle", () => {
    render(<WorkspacePanel />);
    const toggle = screen.getByRole("button", { name: /Terminal/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Terminal ready")).toBeInTheDocument();
    expect(screen.getByText(/Nexuss can execute commands when needed/)).toBeInTheDocument();
  });

  it("keeps the terminal ready across collapse/expand", async () => {
    render(<WorkspacePanel />);
    expect(screen.getByText("Terminal ready")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Terminal/i }));
    expect(screen.getByText("Terminal ready")).toBeInTheDocument();
  });
});

describe("WorkspacePanel agent section", () => {
  beforeEach(async () => {
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
        }
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