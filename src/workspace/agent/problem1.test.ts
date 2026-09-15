// Reproduction test for Problem #1
import { describe, it, expect, beforeEach } from "vitest";
import { runAuthorizedGoal } from "./authorizedExecutor";
import { getAgentState, clearAgentState } from "./agentState";
import { getRecentExecutionContext, clearExecutionContext } from "./executionContext";
import { useWorkspaceStore } from "@/workspace/store";
import { InMemoryBridge } from "@/workspace/bridge";
import { toolRun } from "./tools";
import { vi } from "vitest";

vi.mock("@/workspace/agent/tools", async () => {
  const actual = await vi.importActual("@/workspace/agent/tools") as any;
  return {
    ...actual,
    toolRun: vi.fn(async (_ctx: any, cmd: string) => {
      if (cmd.includes("New-Item -ItemType Directory")) {
        const m = cmd.match(/-Path '([^']+)'/);
        const p = m ? m[1].replace(/\\\.\\/, "") : "unknown";
        return { success: true, stdout: `C:\\mock\\${p}`, stderr: "", exitCode: 0, cwd: "C:\\mock", command: cmd, durationMs: 10, timedOut: false, killed: false, signal: null, outputTruncated: false, redacted: false };
      }
      return { success: true, stdout: "ok", stderr: "", exitCode: 0, cwd: "C:\\mock", command: cmd, durationMs: 5, timedOut: false, killed: false, signal: null, outputTruncated: false, redacted: false };
    })
  };
});

vi.mock("./loop", async () => {
  return {
    getToolContext: () => ({
      connected: true, pathEnabled: true,
      bridge: new InMemoryBridge("test", {}),
      index: null,
      runtime: { run: (req:any)=> (toolRun as any)({}, req.command), capabilities: ()=> ({ run:true, test:true }) }
    })
  };
});

function setupWorkspace(panelOpen = true) {
  useWorkspaceStore.setState({ panelOpen, workspacePath: "C:\\mock", bridge: new InMemoryBridge("test", {}), index: null, connected: true, runtime: { run: async (req:any)=> (toolRun as any)({}, req.command), capabilities: ()=> ({ run:true, test:true }) } as any });
}

describe("Problem #1 - Explicit target overrides old execution context", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAgentState("chat1");
    clearExecutionContext("chat1");
    vi.clearAllMocks();
  });

  it("TEST 1: create a folder called shanu 1999 should create shanu 1999, not shanu", async () => {
    setupWorkspace(true);
    const res = await runAuthorizedGoal("chat1", "create a folder called shanu 1999", { panelOpen: true, workspacePath: "C:\\mock" });
    console.log("TEST 1 response:", res.finalResponse);
    console.log("TEST 1 executed:", res.executed, "succeeded:", res.succeeded);
    expect(res.executed).toBe(1);
    expect(res.succeeded).toBe(1);
    expect(res.finalResponse).toContain("shanu 1999");
  });

  it("TEST 3: explicit path should not return old shanu path", async () => {
    setupWorkspace(true);
    // First create shanu 1999
    await runAuthorizedGoal("chat1", "create a folder called shanu 1999", { panelOpen: true, workspacePath: "C:\\mock" });
    // Now use explicit path
    const res = await runAuthorizedGoal("chat1", "C:\\Users\\pilli\\Downloads create a folder in this path name it as raju", { panelOpen: true, workspacePath: "C:\\mock" });
    console.log("TEST 3 response:", res.finalResponse);
    console.log("TEST 3 executed:", res.executed, "succeeded:", res.succeeded);
    expect(res.executed).toBe(1);
    expect(res.succeeded).toBe(1);
    expect(res.finalResponse).toContain("raju");
    expect(res.finalResponse).not.toContain("shanu");
  });

  it("TEST 5: create a folder called kumar should create kumar, not raju", async () => {
    setupWorkspace(true);
    // Create shanu 1999
    await runAuthorizedGoal("chat1", "create a folder called shanu 1999", { panelOpen: true, workspacePath: "C:\\mock" });
    // Create raju with explicit path
    await runAuthorizedGoal("chat1", "C:\\Users\\pilli\\Downloads create a folder in this path name it as raju", { panelOpen: true, workspacePath: "C:\\mock" });
    // Create kumar - should be kumar, not raju or shanu
    const res = await runAuthorizedGoal("chat1", "create a folder called kumar", { panelOpen: true, workspacePath: "C:\\mock" });
    console.log("TEST 5 response:", res.finalResponse);
    expect(res.executed).toBe(1);
    expect(res.succeeded).toBe(1);
    expect(res.finalResponse).toContain("kumar");
    expect(res.finalResponse).not.toContain("raju");
    expect(res.finalResponse).not.toContain("shanu");
  });
});
