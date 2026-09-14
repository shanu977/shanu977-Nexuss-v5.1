import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore } from "@/workspace/store";
import { InMemoryBridge } from "@/workspace/bridge";
import { runAuthorizedGoal, isModelCommandAuthorized } from "./authorizedExecutor";
import { getAgentState, clearAgentState } from "./agentState";
import { getRecentExecutionContext, clearExecutionContext } from "./executionContext";
import { toolRun } from "./tools";

vi.mock("@/workspace/agent/tools", async () => {
  const actual = await vi.importActual("@/workspace/agent/tools") as any;
  return {
    ...actual,
    toolRun: vi.fn(async (_ctx: any, cmd: string) => {
      // Simulate successful powershell execution with stdout as path
      if (cmd.includes("New-Item -ItemType Directory")) {
        const m = cmd.match(/-Path '([^']+)'/);
        const p = m ? m[1].replace(/\.\\/,"") : "unknown";
        return { success: true, stdout: `C:\\mock\\${p}`, stderr: "", exitCode: 0, cwd: "C:\\mock", command: cmd, durationMs: 10, timedOut: false, killed: false, signal: null, outputTruncated: false, redacted: false };
      }
      if (cmd.includes("New-Item -ItemType File")) {
        const m = cmd.match(/-Path '([^']+)'/);
        const p = m ? m[1] : "file.txt";
        return { success: true, stdout: `C:\\mock\\${p}`, stderr: "", exitCode: 0, cwd: "C:\\mock", command: cmd, durationMs: 10, timedOut: false, killed: false, signal: null, outputTruncated: false, redacted: false };
      }
      if (cmd.includes("Set-Content")) {
        return { success: true, stdout: "", stderr: "", exitCode: 0, cwd: "C:\\mock", command: cmd, durationMs: 5, timedOut: false, killed: false, signal: null, outputTruncated: false, redacted: false };
      }
      if (cmd.includes("Get-ChildItem")) {
        return { success: true, stdout: "test.txt\n", stderr: "", exitCode: 0, cwd: "C:\\mock", command: cmd, durationMs: 5, timedOut: false, killed: false, signal: null, outputTruncated: false, redacted: false };
      }
      if (cmd.includes("Remove-Item")) {
        return { success: true, stdout: "", stderr: "", exitCode: 0, cwd: "C:\\mock", command: cmd, durationMs: 5, timedOut: false, killed: false, signal: null, outputTruncated: false, redacted: false };
      }
      return { success: true, stdout: "ok", stderr: "", exitCode: 0, cwd: "C:\\mock", command: cmd, durationMs: 5, timedOut: false, killed: false, signal: null, outputTruncated: false, redacted: false };
    })
  };
});

// Mock getToolContext to provide a fake context with runtime
vi.mock("./loop", async () => {
  const actual = await vi.importActual("./loop") as any;
  return {
    ...actual,
    getToolContext: () => ({
      connected: true,
      pathEnabled: true,
      bridge: new InMemoryBridge("test", {}),
      index: null,
      runtime: { run: (req:any)=> (toolRun as any)({}, req.command), capabilities: ()=> ({ run:true, test:true }) }
    })
  };
});

function setupWorkspace(panelOpen = true) {
  useWorkspaceStore.setState({ panelOpen, workspacePath: "C:\\mock", bridge: new InMemoryBridge("test", {}), index: null, connected: true, runtime: { run: async (req:any)=> (toolRun as any)({}, req.command), capabilities: ()=> ({ run:true, test:true }) } as any });
}

describe("authorizedExecutor", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAgentState("chatA");
    clearAgentState("chatB");
    clearExecutionContext("chatA");
    clearExecutionContext("chatB");
    vi.clearAllMocks();
  });

  it("creates and executes a simple folder action, verifies observation", async () => {
    setupWorkspace(true);
    const res = await runAuthorizedGoal("chatA", "create a folder called shanu10", { panelOpen: true, workspacePath: "C:\\mock" });
    expect(res.executed).toBe(1);
    expect(res.succeeded).toBe(1);
    expect(res.finalResponse).toContain("shanu10");
    const state = getAgentState("chatA");
    expect(state?.status).toBe("completed");
    expect(state?.completedActions[0].target).toBe("shanu10");
    // ExecutionContext must contain verified observation, not hallucinated
    const ctx = getRecentExecutionContext("chatA");
    expect(ctx.length).toBe(1);
    expect(ctx[0].verified).toBe(true);
    expect(ctx[0].success).toBe(true);
  });

  it("does NOT execute when terminal is closed, returns honest message", async () => {
    setupWorkspace(false);
    const res = await runAuthorizedGoal("chatA", "create a folder called shanu10", { panelOpen: false, workspacePath: null });
    expect(res.executed).toBe(0);
    expect(res.finalResponse.toLowerCase()).toContain("terminal is not available");
    expect(getAgentState("chatA")?.failureReason).toBe("terminal_closed");
    expect(getRecentExecutionContext("chatA").length).toBe(0);
  });

  it("HOW-TO does not execute", async () => {
    setupWorkspace(true);
    const res = await runAuthorizedGoal("chatA", "how do I create a folder called shanu10?", { panelOpen: true, workspacePath: "C:\\mock" });
    expect(res.executed).toBe(0);
    expect(res.finalResponse).toBe("");
  });

  it("multi-step: create folder, file, write, list", async () => {
    setupWorkspace(true);
    const res = await runAuthorizedGoal("chatA", "Create a folder called shanu10, create test.txt inside it, write hello world to the file, then list the folder", { panelOpen: true, workspacePath: "C:\\mock" });
    expect(res.executed).toBe(4);
    expect(res.succeeded).toBe(4);
    expect(res.failed).toBe(0);
    const state = getAgentState("chatA");
    expect(state?.completedActions.length).toBe(4);
  });

  it("'do the thing' resolves previous pending goal, does not invent shanuSecure", async () => {
    setupWorkspace(true);
    await runAuthorizedGoal("chatA", "create a folder called shanu10", { panelOpen: true, workspacePath: "C:\\mock" });
    // Add a second pending goal: create file inside it
    // Simulate follow-up that is actually a completed goal repeat
    const res = await runAuthorizedGoal("chatA", "use the terminal and do the thing what i said", { panelOpen: true, workspacePath: "C:\\mock" });
    // Since previous goal completed, should honestly say already complete, not invent
    expect(res.executed).toBe(0);
    expect(res.finalResponse.toLowerCase()).not.toContain("shanusecure");
    expect(res.finalResponse.toLowerCase()).not.toContain("large.jpg");
  });

  it("model command authorization rejects unrelated actions", async () => {
    setupWorkspace(true);
    await runAuthorizedGoal("chatA", "create a folder called shanu10", { panelOpen: true, workspacePath: "C:\\mock" });
    // Simulate fresh goal for auth check
    clearAgentState("chatB");
    const { createGoalState, updateGoalWithActions } = await import("./agentState");
    createGoalState("chatB", "create a folder called shanu10", "C:\\mock");
    updateGoalWithActions("chatB", [{ id:"1", type:"create_folder", target:"shanu10", rawClause:"create shanu10", status:"pending" } as any]);
    expect(isModelCommandAuthorized("chatB", "New-Item -ItemType Directory -Path '.\\shanu10'")).toBe(true);
    expect(isModelCommandAuthorized("chatB", "Remove-Item C:\\Users\\pilli\\Desktop\\important.docx")).toBe(false);
    expect(isModelCommandAuthorized("chatB", "New-Item -ItemType Directory -Path '.\\shanuSecure'")).toBe(false);
  });

  it("cross-chat isolation: references remain per chat", async () => {
    setupWorkspace(true);
    await runAuthorizedGoal("chatA", "create a folder called shanu10", { panelOpen: true, workspacePath: "C:\\mock" });
    await runAuthorizedGoal("chatB", "create a folder called shanu20", { panelOpen: true, workspacePath: "C:\\mock" });
    const a = getAgentState("chatA");
    const b = getAgentState("chatB");
    expect(a?.completedActions[0].target).toBe("shanu10");
    expect(b?.completedActions[0].target).toBe("shanu20");
    const ctxA = getRecentExecutionContext("chatA");
    const ctxB = getRecentExecutionContext("chatB");
    expect(ctxA[0].path).toContain("shanu10");
    expect(ctxB[0].path).toContain("shanu20");
  });

  it("failed action is not marked complete", async () => {
    setupWorkspace(true);
    // Mock toolRun to fail for this test
    const mod = await import("./tools");
    vi.mocked(mod.toolRun).mockRejectedValueOnce(new Error("Access denied"));
    const res = await runAuthorizedGoal("chatA", "create a folder called shanu10", { panelOpen: true, workspacePath: "C:\\mock" });
    expect(res.failed).toBe(1);
    const state = getAgentState("chatA");
    expect(state?.pendingActions.length).toBe(1);
    expect(state?.status).toBe("failed");
  });
});
