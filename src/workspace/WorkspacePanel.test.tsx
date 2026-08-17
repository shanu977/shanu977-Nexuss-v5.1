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
  it("shows connect controls when no workspace is connected", () => {
    render(<WorkspacePanel />);
    expect(screen.getByLabelText("Workspace")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect a folder" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try sample workspace" })
    ).toBeInTheDocument();
  });

  it("connects the sample workspace and shows the indexed file count", async () => {
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Try sample workspace" }));
    expect(await screen.findByText(/files indexed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(useWorkspaceStore.getState().connected).toBe(true);
  });

  it("runs a hybrid search and lists ranked results", async () => {
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Try sample workspace" }));
    await screen.findByText(/files indexed/);

    const input = screen.getByLabelText("Search workspace");
    fireEvent.change(input, { target: { value: "login" } });

    const result = await screen.findByText("src/auth/login.ts");
    expect(result).toBeInTheDocument();
  });

  it("shows no-matches feedback for an unmatched query", async () => {
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Try sample workspace" }));
    await screen.findByText(/files indexed/);

    const input = screen.getByLabelText("Search workspace");
    fireEvent.change(input, { target: { value: "zzzznothing" } });

    expect(await screen.findByText("No matches.")).toBeInTheDocument();
  });

  it("closes the panel via the header close button", () => {
    useWorkspaceStore.getState().openPanel();
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByLabelText("Close workspace panel"));
    expect(useWorkspaceStore.getState().panelOpen).toBe(false);
  });

  it("surfaces a browser-support error when folder access is unavailable", async () => {
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Connect a folder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /does not support folder access/i
    );
  });

  it("starts collapsed and expands via the header toggle", () => {
    render(<WorkspacePanel />);
    const toggle = screen.getByRole("button", { name: /Path/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Connect a folder" })
    ).toBeInTheDocument();
  });

  it("keeps the connection and search query across collapse/expand", async () => {
    render(<WorkspacePanel />);
    fireEvent.click(screen.getByRole("button", { name: "Try sample workspace" }));
    await screen.findByText(/files indexed/);

    const input = screen.getByLabelText("Search workspace");
    fireEvent.change(input, { target: { value: "login" } });
    await screen.findByText("src/auth/login.ts");

    const toggle = screen.getByRole("button", { name: /Path/i });

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(useWorkspaceStore.getState().connected).toBe(true);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Search workspace")).toHaveValue("login");
    expect(useWorkspaceStore.getState().connected).toBe(true);
  });
});

describe("WorkspacePanel agent section", () => {
  beforeEach(async () => {
    await useWorkspaceStore.getState().connectDemo();
    useWorkspaceStore.setState({ pendingChanges: [], agentLog: [], changeError: null });
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