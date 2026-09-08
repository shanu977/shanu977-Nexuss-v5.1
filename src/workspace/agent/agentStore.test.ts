import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @vitest-environment jsdom
import { useWorkspaceStore } from "@/workspace/store";
import type { InMemoryBridge } from "@/workspace/bridge";
import type { NativeRuntimeBridge } from "@/workspace/agent/types";

beforeEach(async () => {
  await useWorkspaceStore.getState().disconnect();
  await useWorkspaceStore.getState().connectDemo();
  useWorkspaceStore.setState({
    pendingChanges: [],
    agentLog: [],
    changeError: null,
    pendingCommand: null,
    runningCommand: false,
    lastCommandResult: null,
    commandError: null,
    pathEnabled: true,
    activeProject: null
  });
});

afterEach(async () => {
  (window as unknown as { nexussDesktop?: unknown }).nexussDesktop = undefined;
  await useWorkspaceStore.getState().disconnect();
});

function fakeRuntime(overrides?: Partial<NativeRuntimeBridge>): NativeRuntimeBridge {
  return {
    run: vi.fn(async () => ({
      command: "npm test",
      cwd: "",
      exitCode: 0,
      stdout: "all good",
      stderr: "",
      durationMs: 42,
      timedOut: false,
      killed: false,
      signal: null,
      success: true,
      outputTruncated: false,
      redacted: false
    })),
    test: vi.fn(async () => ({
      command: "npm test",
      cwd: "",
      exitCode: 1,
      stdout: "",
      stderr: "1 test failed",
      durationMs: 42,
      timedOut: false,
      killed: false,
      signal: null,
      success: false,
      outputTruncated: false,
      redacted: false,
      plan: { command: "npm test", source: "package.json#scripts.test", confidence: "high" as const }
    })),
    capabilities: () => ({ read: true, search: true, write: true, create: true, rename: true, move: true, delete: true, mkdir: true, run: true, test: true }),
    cancel: vi.fn(),
    ...overrides
  };
}

async function connectWithRuntime(runtime: NativeRuntimeBridge): Promise<void> {
  (window as unknown as { nexussDesktop: { runtime: NativeRuntimeBridge } }).nexussDesktop = {
    runtime
  };
  await useWorkspaceStore.getState().disconnect();
  await useWorkspaceStore.getState().connectDemo();
  useWorkspaceStore.setState({ pathEnabled: true });
}

function bridge(): InMemoryBridge {
  return useWorkspaceStore.getState().bridge as unknown as InMemoryBridge;
}

describe("workspace agent: staging from a model change block", () => {
  it("stages write/create proposals without writing anything", async () => {
    await useWorkspaceStore
      .getState()
      .proposeChangeFromBlock([
        { path: "README.md", content: "# New readme\n" },
        { path: "src/added.ts", content: "export const x = 1;\n" }
      ]);

    const s = useWorkspaceStore.getState();
    expect(s.pendingChanges).toHaveLength(2);
    expect(s.pendingChanges[0].kind).toBe("write");
    expect(s.pendingChanges[1].kind).toBe("create");
    // Nothing was written yet.
    expect(await bridge().read("README.md")).toContain("# Nexuss Sample Workspace");
    await expect(bridge().read("src/added.ts")).rejects.toThrow();
  });

  it("records rejected (unsafe) changes as errors and stages nothing", async () => {
    await useWorkspaceStore
      .getState()
      .proposeChangeFromBlock([{ path: "../outside.ts", content: "x" }]);

    const s = useWorkspaceStore.getState();
    expect(s.pendingChanges).toHaveLength(0);
    expect(s.changeError?.code).toBe("INVALID_INPUT");
    expect(s.agentLog.some((e) => e.kind === "error")).toBe(true);
  });

  it("does nothing when the workspace is not connected", async () => {
    await useWorkspaceStore.getState().disconnect();
    await useWorkspaceStore
      .getState()
      .proposeChangeFromBlock([{ path: "README.md", content: "x" }]);
    expect(useWorkspaceStore.getState().pendingChanges).toHaveLength(0);
  });
});

describe("workspace agent: approval flow", () => {
  it("applies staged changes on approval and refreshes the index", async () => {
    await useWorkspaceStore
      .getState()
      .proposeChangeFromBlock([
        { path: "README.md", content: "# Approved readme\n" }
      ]);

    const result = await useWorkspaceStore.getState().approvePendingChanges();
    expect(result.ok).toBe(true);
    expect(await bridge().read("README.md")).toBe("# Approved readme\n");
    const s = useWorkspaceStore.getState();
    expect(s.pendingChanges).toHaveLength(0);
    expect(s.changeError).toBeNull();
    expect(s.agentLog.some((e) => e.kind === "apply")).toBe(true);
    // The refreshed index sees the new content hash.
    expect(s.index?.byPath.get("README.md")?.contentHash).not.toBeUndefined();
  });

  it("rejects without touching the filesystem", async () => {
    await useWorkspaceStore
      .getState()
      .proposeChangeFromBlock([{ path: "README.md", content: "# Rejected\n" }]);

    useWorkspaceStore.getState().rejectPendingChanges();

    const s = useWorkspaceStore.getState();
    expect(s.pendingChanges).toHaveLength(0);
    expect(await bridge().read("README.md")).toContain("# Nexuss Sample Workspace");
    expect(s.agentLog.some((e) => e.kind === "reject")).toBe(true);
  });

  it("returns an error when there is nothing to apply", async () => {
    const result = await useWorkspaceStore.getState().approvePendingChanges();
    expect(result.ok).toBe(false);
  });
});

describe("workspace agent: version/conflict protection", () => {
  it("refuses to overwrite a file that changed after it was read", async () => {
    await useWorkspaceStore
      .getState()
      .proposeChangeFromBlock([{ path: "src/auth/login.ts", content: "changed" }]);

    // Simulate an external edit after the change was staged.
    await bridge().write("src/auth/login.ts", "// edited elsewhere\n");

    const result = await useWorkspaceStore.getState().approvePendingChanges();
    expect(result.ok).toBe(false);
    const s = useWorkspaceStore.getState();
    expect(s.changeError?.code).toBe("FILE_CHANGED");
    // The proposal is kept so the user can reload/refresh.
    expect(s.pendingChanges).toHaveLength(1);
    // The external edit was NOT overwritten.
    expect(await bridge().read("src/auth/login.ts")).toBe("// edited elsewhere\n");
  });

  it("refuses to create over an existing file", async () => {
    await useWorkspaceStore
      .getState()
      .proposeChangeFromBlock([{ path: "src/conflict.ts", content: "x" }]);

    // Another process creates the file in the meantime.
    await bridge().create("src/conflict.ts", "externally created\n");

    const result = await useWorkspaceStore.getState().approvePendingChanges();
    expect(result.ok).toBe(false);
    expect(useWorkspaceStore.getState().changeError?.code).toBe("FILE_EXISTS");
    expect(await bridge().read("src/conflict.ts")).toBe("externally created\n");
  });

  it("refresh re-reads files and recomputes diffs/hashes", async () => {
    await useWorkspaceStore
      .getState()
      .proposeChangeFromBlock([{ path: "README.md", content: "# Refreshed\n" }]);
    const staged = useWorkspaceStore.getState().pendingChanges[0];
    const oldHash = staged.originalHash;

    await bridge().write("README.md", "# Externally updated\n");
    await useWorkspaceStore.getState().refreshPendingChanges();

    const refreshed = useWorkspaceStore.getState().pendingChanges[0];
    expect(refreshed.originalHash).not.toBe(oldHash);
    expect(refreshed.before).toBe("# Externally updated\n");

    // Now approval passes because the diff is recomputed against the new file.
    const result = await useWorkspaceStore.getState().approvePendingChanges();
    expect(result.ok).toBe(true);
    expect(await bridge().read("README.md")).toBe("# Refreshed\n");
  });
});

describe("workspace agent: lifecycle safety", () => {
  it("clears staged changes on disconnect", async () => {
    await useWorkspaceStore
      .getState()
      .proposeChangeFromBlock([{ path: "README.md", content: "x" }]);
    expect(useWorkspaceStore.getState().pendingChanges).toHaveLength(1);

    await useWorkspaceStore.getState().disconnect();
    expect(useWorkspaceStore.getState().pendingChanges).toHaveLength(0);
    expect(useWorkspaceStore.getState().changeError).toBeNull();
  });
});

describe("workspace agent: run/test command staging and execution", () => {
  it("stages a run command for approval without executing anything", async () => {
    const runtime = fakeRuntime();
    await connectWithRuntime(runtime);
    await useWorkspaceStore.getState().proposeCommandFromBlock({
      run: { command: "npm test", cwd: "sub" }
    });

    const s = useWorkspaceStore.getState();
    expect(s.pendingCommand?.kind).toBe("run");
    expect(s.pendingCommand?.command).toBe("npm test");
    expect(s.pendingCommand?.cwd).toBe("sub");
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("stages a test request as a test command", async () => {
    const runtime = fakeRuntime();
    await connectWithRuntime(runtime);
    await useWorkspaceStore.getState().proposeCommandFromBlock({ test: {} });

    const s = useWorkspaceStore.getState();
    expect(s.pendingCommand?.kind).toBe("test");
    expect(runtime.test).not.toHaveBeenCalled();
  });

  it("executes the pending command on run and stores the result", async () => {
    const runtime = fakeRuntime();
    await connectWithRuntime(runtime);
    await useWorkspaceStore.getState().proposeCommandFromBlock({
      run: { command: "npm test" }
    });
    await useWorkspaceStore.getState().runPendingCommand();

    const s = useWorkspaceStore.getState();
    expect(runtime.run).toHaveBeenCalledWith({ command: "npm test", cwd: "" });
    expect(s.pendingCommand).toBeNull();
    expect(s.runningCommand).toBe(false);
    expect(s.lastCommandResult?.success).toBe(true);
    expect(s.lastCommandResult?.stdout).toBe("all good");
  });

  it("surfaces a failed test result for the model to diagnose", async () => {
    const runtime = fakeRuntime();
    await connectWithRuntime(runtime);
    await useWorkspaceStore.getState().proposeCommandFromBlock({ test: {} });
    await useWorkspaceStore.getState().runPendingCommand();

    const s = useWorkspaceStore.getState();
    expect(s.lastCommandResult?.success).toBe(false);
    expect(s.lastCommandResult?.stderr).toContain("1 test failed");
  });

  it("reports a missing runtime when staging a command", async () => {
    await useWorkspaceStore.getState().disconnect();
    await useWorkspaceStore.getState().connectDemo();
    await useWorkspaceStore.getState().proposeCommandFromBlock({
      run: { command: "npm test" }
    });

    const s = useWorkspaceStore.getState();
    expect(s.pendingCommand).toBeNull();
    expect(s.commandError).toContain("desktop runtime");
  });

  it("refuses to stage a command the runtime cannot run", async () => {
    const runtime = fakeRuntime({
      capabilities: () => ({ read: true, search: true, write: true, create: true, rename: true, move: true, delete: true, mkdir: true, run: false, test: false })
    });
    await connectWithRuntime(runtime);
    await useWorkspaceStore.getState().proposeCommandFromBlock({
      run: { command: "npm test" }
    });

    const s = useWorkspaceStore.getState();
    expect(s.pendingCommand).toBeNull();
    expect(s.commandError).toContain("not available");
  });

  it("rejects a staged command without running it", async () => {
    const runtime = fakeRuntime();
    await connectWithRuntime(runtime);
    await useWorkspaceStore.getState().proposeCommandFromBlock({
      run: { command: "npm test" }
    });
    useWorkspaceStore.getState().rejectPendingCommand();

    const s = useWorkspaceStore.getState();
    expect(s.pendingCommand).toBeNull();
    expect(runtime.run).not.toHaveBeenCalled();
  });

  it("cancels a running command through the runtime", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runtime = fakeRuntime({
      run: vi.fn(
        () =>
          new Promise<never>((resolve) => {
            void gate.then(() => resolve({} as never));
          })
      )
    });
    await connectWithRuntime(runtime);
    await useWorkspaceStore.getState().proposeCommandFromBlock({
      run: { command: "npm test" }
    });

    const runPromise = useWorkspaceStore.getState().runPendingCommand();
    expect(useWorkspaceStore.getState().runningCommand).toBe(true);
    await useWorkspaceStore.getState().cancelPendingCommand();

    const s = useWorkspaceStore.getState();
    expect(runtime.cancel).toHaveBeenCalled();
    expect(s.runningCommand).toBe(false);
    expect(s.pendingCommand).toBeNull();
    release?.();
    await runPromise;
  });

  it("clears command state on disconnect", async () => {
    const runtime = fakeRuntime();
    await connectWithRuntime(runtime);
    await useWorkspaceStore.getState().proposeCommandFromBlock({
      run: { command: "npm test" }
    });
    await useWorkspaceStore.getState().runPendingCommand();

    await useWorkspaceStore.getState().disconnect();
    const s = useWorkspaceStore.getState();
    expect(s.runtime).toBeNull();
    expect(s.pendingCommand).toBeNull();
    expect(s.runningCommand).toBe(false);
    expect(s.lastCommandResult).toBeNull();
    expect(s.commandError).toBeNull();
  });
});