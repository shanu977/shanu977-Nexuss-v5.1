import { runAuthorizedGoal } from "./src/workspace/agent/authorizedExecutor";
import { useWorkspaceStore } from "./src/workspace/store";
import { createLocalConnectorRuntime } from "./src/workspace/localTerminalRuntime";
import { clearAgentState } from "./src/workspace/agent/agentState";
import { clearExecutionContext } from "./src/workspace/agent/executionContext";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

async function main() {
  const runtime = createLocalConnectorRuntime();
  useWorkspaceStore.setState({
    panelOpen: true,
    workspacePath: null,
    bridge: null as any,
    index: null as any,
    connected: true,
    runtime: runtime as any
  } as any);
  if (typeof globalThis.localStorage === "undefined") {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k:string)=> store.get(k)||null,
      setItem: (k:string,v:string)=> store.set(k,v),
      removeItem: (k:string)=> store.delete(k),
      clear: ()=> store.clear(),
      length: 0,
      key: () => null
    };
  }
  const chatId = "test6";
  clearAgentState(chatId);
  clearExecutionContext(chatId);
  const folderPath = path.join(os.homedir(), "connector_off_compound_test");
  try { await fs.rm(folderPath, { recursive: true, force: true }); } catch {}
  console.log("Testing with connector OFF...");
  const res = await runAuthorizedGoal(chatId, "create a folder called connector_off_compound_test", { panelOpen: true, workspacePath: null });
  console.log("executed:", res.executed, "succeeded:", res.succeeded, "failed:", res.failed);
  console.log("finalResponse:", res.finalResponse.slice(0,400));
  console.log("observations:", res.observations.map(o=> ({success:o.success, stderr:o.stderr.slice(0,100), executor:o.executor, executed:o.executed, verified:o.verified})));
  try {
    const s = await fs.stat(folderPath);
    console.log("folder exists (should be false):", s.isDirectory());
  } catch {
    console.log("folder correctly NOT created");
  }
  const pass = res.executed===0 && res.failed===1 && res.observations[0]?.stderr.includes("CONNECTOR_UNAVAILABLE") && res.finalResponse.includes("CONNECTOR_UNAVAILABLE");
  console.log("TEST6 PASS:", pass);
  // Restart connector for cleanup
  console.log("Restarting connector...");
  const { spawn } = await import("child_process");
  spawn("node", ["local-connector/server.js"], { detached: true, stdio: "ignore" }).unref();
  await new Promise(r=> setTimeout(r, 2000));
  console.log("connector restarted, health check should be true again");
}

main().catch(e=> console.error(e));
