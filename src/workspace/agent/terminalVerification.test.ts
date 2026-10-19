import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore } from "@/workspace/store";
import { InMemoryBridge } from "@/workspace/bridge";
import { useTerminalConnectionStore, resetTerminalConnection } from "@/workspace/terminalConnection";
import { runAuthorizedGoal } from "./authorizedExecutor";
import { getAgentState, clearAgentState } from "./agentState";
import { clearExecutionContext, getRecentExecutionContext } from "./executionContext";
import { planFilesystemActions, synthesizeCommand, resolveActionTargetPath } from "./actionPlanner";
import { toolRun } from "./tools";

// The browser cannot resolve a real user home (getDefaultUserWorkspace() === "").
// Tests drive both worlds: home = "" (browser) and an absolute Windows home.
const h = vi.hoisted(() => ({ home: "", cwd: "C:\\mock", readFile: undefined as string | undefined, calls: [] as string[] }));

vi.mock("./specialFolders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./specialFolders")>();
  return { ...actual, getDefaultUserWorkspace: () => h.home };
});

vi.mock("./tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools")>();
  return {
    ...actual,
    toolRun: vi.fn(async (_ctx: any, cmd: string) => {
      h.calls.push(cmd);
      // Simulate the filesystem read-back when the test provides file content.
      const stdout = cmd.includes("Get-Content") && h.readFile !== undefined ? h.readFile : "";
      return {
        success: true, stdout, stderr: "", exitCode: 0, cwd: h.cwd,
        command: cmd, durationMs: 5, timedOut: false, killed: false, signal: null,
        outputTruncated: false, redacted: false,
      };
    }),
  };
});

vi.mock("./loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./loop")>();
  return {
    ...actual,
    getToolContext: vi.fn(() => {
      const storeRuntime = (useWorkspaceStore.getState() as any).runtime;
      const runtime = storeRuntime !== undefined
        ? storeRuntime
        : { run: (req: any) => (toolRun as any)({}, req.command), capabilities: () => ({ run: true, test: true }) };
      return {
        connected: true,
        pathEnabled: true,
        bridge: new InMemoryBridge("test", {}),
        index: null,
        runtime,
      };
    }),
  };
});

function setup(workspacePath: string | null) {
  useWorkspaceStore.setState({
    panelOpen: true,
    workspacePath,
    bridge: new InMemoryBridge("test", {}),
    index: null,
    connected: true,
    runtime: { run: async (req: any) => (toolRun as any)({}, req.command), capabilities: () => ({ run: true, test: true }) } as any,
  });
  useTerminalConnectionStore.setState({ status: "connected", lastVerifiedAt: Date.now(), justConnected: false, lastError: null });
}

const CHAT = "chatVerify";

describe("terminal verification path consistency", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAgentState(CHAT);
    clearExecutionContext(CHAT);
    resetTerminalConnection();
    h.home = "";
    h.cwd = "C:\\mock";
    h.readFile = undefined;
    h.calls.length = 0;
    vi.clearAllMocks();
  });

  it("keeps $env:USERPROFILE as a connector-side template when the client cannot resolve home", () => {
    h.home = "";
    const p = resolveActionTargetPath(
      { kind: "createFolder", name: "nexuss-connection-test", clause: "create a folder nexuss-connection-test" },
      CHAT,
      false
    );
    expect(p).toBe("$env:USERPROFILE\\nexuss-connection-test");
    // The historical bug: a browser cwd of "/" produced a bogus UNC path.
    expect(p?.startsWith("\\\\")).toBe(false);
    expect(p).not.toMatch(/^[/\\]{2}[^$]/);
  });

  it("resolves to a real absolute path when the client home is known", () => {
    h.home = "C:\\Users\\pilli";
    const p = resolveActionTargetPath(
      { kind: "createFolder", name: "nexuss-connection-test", clause: "" },
      CHAT,
      false
    );
    expect(p).toBe("C:\\Users\\pilli\\nexuss-connection-test");
  });

  it("never resolves a browser home of '/' into a fake Windows path", () => {
    h.home = "";
    const p = resolveActionTargetPath(
      { kind: "createFolder", name: "plain-folder", clause: "" },
      CHAT,
      false
    );
    expect(p).toBe("$env:USERPROFILE\\plain-folder");
    expect(p).not.toContain("//");
  });

  it("executes and verifies with the SAME $env: template path", async () => {
    h.home = "";
    setup(null);
    const res = await runAuthorizedGoal(CHAT, "create a folder called nexuss-connection-test", {
      panelOpen: true,
      workspacePath: null,
    });
    expect(res.executed).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.observations[0].verified).toBe(true);

    const execCmd = h.calls.find((c) => c.includes("New-Item -ItemType Directory"));
    expect(execCmd).toBeTruthy();
    expect(execCmd).toContain('-Path "$env:USERPROFILE\\nexuss-connection-test"');

    const verifyCmd = h.calls.find((c) => c.includes("Test-Path"));
    expect(verifyCmd).toBeTruthy();
    // PowerShell expands $env: only inside double quotes — single quotes would
    // make exec and verify resolve different locations.
    expect(verifyCmd).toContain('-LiteralPath "$env:USERPROFILE\\nexuss-connection-test"');
    expect(verifyCmd).not.toContain("'$env:USERPROFILE");
    expect(execCmd).not.toContain("'$env:USERPROFILE");

    expect(res.finalResponse).not.toContain("Missing:");
    expect(res.finalResponse).toContain("verified against the real filesystem");
  });

  it("the exact original request no longer produces a false Missing: error", async () => {
    h.home = "";
    setup(null);
    const res = await runAuthorizedGoal(
      CHAT,
      "create a folder nexuss-connection-test on my permitted local workspace",
      { panelOpen: true, workspacePath: null }
    );
    expect(res.executed).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.finalResponse).not.toContain("Missing:");
    expect(res.observations[0].verified).toBe(true);
    const verifyCmd = h.calls.find((c) => c.includes("Test-Path"));
    expect(verifyCmd).toContain('"$env:USERPROFILE\\nexuss-connection-test"');
  });

  it("uses the selected workspace path for creation and verification alike", async () => {
    h.home = "";
    const ws = "C:\\ws\\allowed";
    setup(ws);
    const res = await runAuthorizedGoal(CHAT, "create a folder nexuss-connection-test on my permitted local workspace", {
      panelOpen: true,
      workspacePath: ws,
    });
    expect(res.executed).toBe(1);
    expect(res.observations[0].verified).toBe(true);
    const execCmd = h.calls.find((c) => c.includes("New-Item -ItemType Directory"));
    const verifyCmd = h.calls.find((c) => c.includes("Test-Path"));
    expect(execCmd).toContain("'C:\\ws\\allowed\\nexuss-connection-test'");
    expect(verifyCmd).toContain("-LiteralPath 'C:\\ws\\allowed\\nexuss-connection-test'");
    expect(res.finalResponse).not.toContain("Missing:");
  });

  it("expands $env: paths when verifying file content", async () => {
    h.home = "";
    setup(null);
    const res = await runAuthorizedGoal(CHAT, "create nexuss-content.txt with hello world", {
      panelOpen: true,
      workspacePath: null,
    });
    expect(res.executed).toBe(1);
    expect(res.failed).toBe(0);
    const contentCmd = h.calls.find((c) => c.includes("ReadAllBytes"));
    expect(contentCmd).toBeTruthy();
    expect(contentCmd).toContain('"$env:USERPROFILE\\nexuss-content.txt"');
    expect(contentCmd).not.toContain("'$env:USERPROFILE");
    expect(res.finalResponse).not.toContain("Missing:");
    expect(res.finalResponse).not.toContain("Content mismatch");
  });

  it("special folder (Downloads): execution and verification resolve the same path", () => {
    const action = {
      kind: "createFolder" as const,
      name: "nexuss-dl-test",
      clause: "create folder nexuss-dl-test in Downloads",
      basePath: "Downloads",
    };
    h.home = "";
    const execBrowser = synthesizeCommand(action, CHAT, false);
    const verifyBrowser = resolveActionTargetPath(action, CHAT, false);
    expect(execBrowser).toContain('-Path "$env:USERPROFILE\\Downloads\\nexuss-dl-test"');
    expect(execBrowser).not.toContain("'$env:USERPROFILE");
    expect(verifyBrowser).toBe("$env:USERPROFILE\\Downloads\\nexuss-dl-test");

    h.home = "C:\\Users\\pilli";
    const verifyAbs = resolveActionTargetPath(action, CHAT, false);
    expect(verifyAbs).toBe("C:\\Users\\pilli\\Downloads\\nexuss-dl-test");
    // The connector expands the exec template with the very same home.
    const expanded = execBrowser.match(/-Path "\$env:USERPROFILE([^"]+)"/)?.[1];
    expect(expanded).toBeTruthy();
    expect(verifyAbs).toBe(`C:\\Users\\pilli${expanded}`);
  });

  it("extracts the folder name without the location phrase", () => {
    const plan = planFilesystemActions("create a folder nexuss-connection-test on my permitted local workspace", CHAT);
    const folder = plan.find((a) => a.kind === "createFolder");
    expect(folder).toBeTruthy();
    expect((folder as any).name).toBe("nexuss-connection-test");
  });

  it("cuts 'in my workspace' from folder names", () => {
    const plan = planFilesystemActions("create a folder my-test-folder in my workspace", CHAT);
    const folder = plan.find((a) => a.kind === "createFolder");
    expect((folder as any).name).toBe("my-test-folder");
  });

  it("preserves intentional multi-word folder names like shanu 1999", () => {
    const plan = planFilesystemActions("create a folder called shanu 1999", CHAT);
    const folder = plan.find((a) => a.kind === "createFolder");
    expect((folder as any).name).toBe("shanu 1999");
  });

  it("skipped verification never reports verified success", async () => {
    h.home = "";
    setup(null);
    const res = await runAuthorizedGoal(CHAT, "delete orphan-test-file.tmp", {
      panelOpen: true,
      workspacePath: null,
    });
    expect(res.executed).toBe(1);
    expect(res.failed).toBe(0);
    // No resolvable absolute target in the browser world -> verification skipped.
    expect(res.observations[0].verified).toBe(false);
    expect(res.finalResponse).toContain("verification could not be completed");
    expect(res.finalResponse).not.toContain("verified against the real filesystem");
    const ctx = getRecentExecutionContext(CHAT);
    expect(ctx[0]?.verified).toBe(false);
    expect(getAgentState(CHAT)?.status).toBe("completed");
  });

  it("workspace authorization is unchanged: nothing is ever created outside the selected workspace", async () => {
    h.home = "";
    const ws = "C:\\ws\\allowed";
    setup(ws);
    const res = await runAuthorizedGoal(CHAT, "create a folder called ..\\..\\escape-xyz", {
      panelOpen: true,
      workspacePath: ws,
    });
    // Either the unsafe name never reaches execution, or every executed
    // creation stays rooted in the permitted workspace — never outside it.
    const outsideCreations = h.calls.filter((c) => c.includes("New-Item") && !c.includes(`${ws}\\`));
    expect(outsideCreations).toHaveLength(0);
    expect(res.finalResponse).not.toContain("Missing:");
  });

  it("resolves drive-letter Windows paths unchanged", () => {
    h.home = "C:\\ws\\allowed";
    const folderP = resolveActionTargetPath(
      { kind: "createFolder", name: "proj", clause: "", basePath: "C:\\ws\\allowed" },
      CHAT,
      false
    );
    expect(folderP).toBe("C:\\ws\\allowed\\proj");
    const fileP = resolveActionTargetPath(
      { kind: "createFile", name: "notes.txt", folderRef: "C:\\ws\\allowed", clause: "" },
      CHAT,
      false
    );
    expect(fileP).toBe("C:\\ws\\allowed\\notes.txt");
    const writeP = resolveActionTargetPath(
      { kind: "writeFile", name: "C:\\ws\\allowed\\notes.txt", content: "x", clause: "" } as any,
      CHAT,
      false
    );
    expect(writeP).toBe("C:\\ws\\allowed\\notes.txt");
    // The matching execution command uses the same absolute path.
    const cmd = synthesizeCommand(
      { kind: "createFolder", name: "proj", clause: "", basePath: "C:\\ws\\allowed" },
      CHAT,
      false
    );
    expect(cmd).toContain("C:\\ws\\allowed\\proj");
  });

  it("double-quotes $env: templates in every read-family synthesis (parity with verification)", () => {
    h.home = "";
    const readCmd = synthesizeCommand({ kind: "read", target: "$env:USERPROFILE\\hello.txt", clause: "" }, CHAT, false);
    expect(readCmd).toContain('Get-Content -LiteralPath "$env:USERPROFILE\\hello.txt"');
    expect(readCmd).not.toContain("'$env:USERPROFILE");
    const listCmd = synthesizeCommand({ kind: "list", target: "$env:USERPROFILE\\nexuss-test", clause: "" }, CHAT, false);
    expect(listCmd).toContain('-LiteralPath "$env:USERPROFILE\\nexuss-test"');
    expect(listCmd).not.toContain("'$env:USERPROFILE");
    const countCmd = synthesizeCommand({ kind: "count", target: "$env:USERPROFILE\\nexuss-test", clause: "" }, CHAT, false);
    expect(countCmd).toContain('-LiteralPath "$env:USERPROFILE\\nexuss-test"');
    const deleteCmd = synthesizeCommand({ kind: "delete", target: "$env:USERPROFILE\\dead.tmp", clause: "" }, CHAT, false);
    expect(deleteCmd).toContain('-LiteralPath "$env:USERPROFILE\\dead.tmp"');
    expect(deleteCmd).not.toContain("'$env:USERPROFILE");
    const goToCmd = synthesizeCommand({ kind: "goTo", target: "$env:USERPROFILE\\nexuss-test", clause: "" }, CHAT, false);
    expect(goToCmd).toContain('-LiteralPath "$env:USERPROFILE\\nexuss-test"');
    // Non-template paths keep the existing single-quote form.
    const realRead = synthesizeCommand({ kind: "read", target: "C:\\ws\\allowed\\hello.txt", clause: "" }, CHAT, false);
    expect(realRead).toContain("-LiteralPath 'C:\\ws\\allowed\\hello.txt'");
  });

  it("never fabricates a UNC verification path from non-UNC input", () => {
    h.home = "";
    // A slash-collapsed browser leftover ("/" base) must not become "\\x".
    const p1 = resolveActionTargetPath(
      { kind: "createFolder", name: "x", clause: "", basePath: "/" },
      CHAT,
      false
    );
    expect(p1).toBeUndefined();
    // A genuine UNC base is never a verifiable target either: the connector
    // rejects UNC paths at execution time, so verification of one would only
    // produce the confusing "could not verify outcome: UNC paths are not allowed".
    const p2 = resolveActionTargetPath(
      { kind: "createFolder", name: "x", clause: "", basePath: "\\\\evil.example\\share" },
      CHAT,
      false
    );
    expect(p2).toBeUndefined();
  });

  it("bare write then read under browser conditions stays on the same canonical path", async () => {
    h.home = "";
    h.cwd = ""; // browser: no client home AND no connector cwd reported
    setup(null);
    await runAuthorizedGoal(CHAT, "write Nexuss terminal is working! into the file nexuss-roundtrip.txt", {
      panelOpen: true,
      workspacePath: null,
    });
    const fileCtx = getRecentExecutionContext(CHAT).find((c) => c.object === "file");
    // The stored path is the connector-side template or a drive path — never
    // a fabricated "\nexuss-roundtrip.txt".
    expect(fileCtx?.path).toBe("$env:USERPROFILE\\nexuss-roundtrip.txt");
    expect(fileCtx?.path?.startsWith("\\")).toBe(false);

    h.calls.length = 0;
    await runAuthorizedGoal(CHAT, "read nexuss-roundtrip.txt", { panelOpen: true, workspacePath: null });
    const readCmd = h.calls.find((c) => c.includes("Get-Content"));
    expect(readCmd).toBeTruthy();
    expect(readCmd).toContain('Get-Content -LiteralPath "$env:USERPROFILE\\nexuss-roundtrip.txt"');
    expect(readCmd).not.toContain("'$env:USERPROFILE");
  });

  it("stores the connector-reported cwd in context when the client home is unknown", async () => {
    h.home = "";
    h.cwd = "C:\\mock"; // connector reports its permitted root
    setup(null);
    await runAuthorizedGoal(CHAT, "write hello world into the file nexuss-cwd.txt", {
      panelOpen: true,
      workspacePath: null,
    });
    const fileCtx = getRecentExecutionContext(CHAT).find((c) => c.object === "file");
    // Real drive-absolute path from the connector — later commands use it as-is.
    expect(fileCtx?.path).toBe("C:\\mock\\nexuss-cwd.txt");
  });

  it("extracts 'containing exactly ...' payload so the file is never created empty", () => {
    h.home = "";
    const plan = planFilesystemActions(
      "create hello.txt containing exactly Nexuss terminal is working!",
      CHAT
    );
    const file = plan.find((a) => a.kind === "createFile") as any;
    expect(file?.name).toBe("hello.txt");
    expect(file?.content).toBe("Nexuss terminal is working!");
  });

  it("extracts 'with content ...' and quoted payloads; ignores quantity phrases", () => {
    h.home = "";
    const kw = planFilesystemActions("create hello.txt with content Nexuss terminal is working!", CHAT)
      .find((a) => a.kind === "createFile") as any;
    expect(kw?.content).toBe("Nexuss terminal is working!");
    const quoted = planFilesystemActions("create hello.txt containing exactly \"Nexuss terminal is working!\"", CHAT)
      .find((a) => a.kind === "createFile") as any;
    expect(quoted?.content).toBe("Nexuss terminal is working!");
    const qty = planFilesystemActions("create notes.txt with 100 lines", CHAT)
      .find((a) => a.kind === "createFile") as any;
    expect(qty?.content).toBeUndefined();
  });

  it("verifies the actual content of the full user's task (folder + file + read back)", async () => {
    h.home = "";
    h.cwd = "C:\\mock";
    h.readFile = "Nexuss terminal is working!\r\n"; // simulated Get-Content output
    const savedUP = process.env.USERPROFILE;
    process.env.USERPROFILE = ""; // browser: no client-side home either
    try {
      setup(null);
      const res = await runAuthorizedGoal(
        CHAT,
        "Create a folder named nexuss-test in my permitted workspace. Inside it, create hello.txt containing exactly Nexuss terminal is working!. Read the file back and verify its actual contents on my computer.",
        { panelOpen: true, workspacePath: null }
      );
      expect(res.failed).toBe(0);
      // Content verification must have actually run against the written bytes.
      const contentCmd = h.calls.find((c) => c.includes("ReadAllBytes"));
      expect(contentCmd).toBeTruthy();
      expect(contentCmd).toContain("hello.txt");
      expect(contentCmd).toContain("-ceq"); // case-sensitive byte comparison
      expect(res.observations.every((o) => o.verified)).toBe(true);
      expect(res.finalResponse).toContain("verified against the real filesystem");
      const fileCtx = getRecentExecutionContext(CHAT).find((c) => c.object === "file" && c.name === "hello.txt");
      // Drive-absolute canonical path — never a fabricated "\hello.txt".
      expect(fileCtx?.path).toMatch(/^[a-zA-Z]:\\/);
      expect(fileCtx?.path?.endsWith("hello.txt")).toBe(true);
    } finally {
      if (savedUP === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUP;
      h.readFile = undefined;
    }
  });
});
