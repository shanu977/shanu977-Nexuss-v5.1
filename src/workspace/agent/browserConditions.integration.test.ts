// Gated real-connector integration: reproduces the reported terminal bug
// end-to-end and asserts it stays fixed.
//   "I couldn't complete the action: could not verify outcome: UNC paths are not allowed."
//
// Browser conditions are simulated faithfully: no USERPROFILE/HOME in
// process.env and a process.cwd() of "/" (webpack's process polyfill).
// Nothing in the path-conversion layer is mocked. Requires a running local
// connector on 127.0.0.1:11435, so it is gated behind NEXUSS_REAL_CONNECTOR=1
// like realConnector.integration.test.ts:
//   NEXUSS_REAL_CONNECTOR=1 npx vitest run src/workspace/agent/browserConditions.integration.test.ts

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useWorkspaceStore } from "@/workspace/store";
import { InMemoryBridge } from "@/workspace/bridge";
import { useTerminalConnectionStore, resetTerminalConnection } from "@/workspace/terminalConnection";
import { connectorHttpError } from "@/workspace/localTerminalRuntime";
import { runAuthorizedGoal } from "./authorizedExecutor";
import { clearAgentState, getAgentState } from "./agentState";
import { clearExecutionContext, getRecentExecutionContext } from "./executionContext";
import { getDefaultUserWorkspace } from "./specialFolders";

const RUN = process.env.NEXUSS_REAL_CONNECTOR === "1";
const CONNECTOR = "http://127.0.0.1:11435/v1/terminal/run";
const calls: string[] = [];
const errors: string[] = [];

vi.mock("./tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools")>();
  return {
    ...actual,
    toolRun: vi.fn(async (_ctx: any, cmd: string, opts?: { cwd?: string }) => {
      calls.push(cmd);
      const res = await fetch(CONNECTOR, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd, cwd: opts?.cwd || "" })
      });
      if (!res.ok) {
        const body = await res.text();
        const err = connectorHttpError(res.status, body);
        errors.push(`${err.message} << ${cmd}`);
        throw err;
      }
      const data = await res.json();
      return {
        command: cmd, cwd: data.cwd || opts?.cwd || "", exitCode: data.exitCode ?? null,
        stdout: data.stdout || "", stderr: data.stderr || "", durationMs: data.durationMs || 0,
        timedOut: !!data.timedOut, killed: !!data.killed, signal: data.signal || null,
        success: !!data.success, outputTruncated: !!data.outputTruncated, redacted: !!data.redacted
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
      return { connected: true, pathEnabled: true, bridge: new InMemoryBridge("test", {}), index: null, runtime: storeRuntime };
    }),
  };
});

const realCwd = process.cwd.bind(process);
const savedUserProfile = process.env.USERPROFILE;
const savedHome = process.env.HOME;

function enterBrowserWorld() {
  process.env.USERPROFILE = "";
  process.env.HOME = "";
  (process as any).cwd = () => "/";
}

function leaveBrowserWorld() {
  (process as any).cwd = realCwd;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
}

function setup(workspacePath: string | null) {
  useWorkspaceStore.setState({
    panelOpen: true, workspacePath, bridge: new InMemoryBridge("test", {}),
    index: null, connected: true,
    runtime: {
      run: async (req: any) => {
        const { toolRun } = await import("./tools");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (toolRun as any)({}, req.command);
      },
      capabilities: () => ({ run: true, test: true })
    } as any,
  });
  useTerminalConnectionStore.setState({ status: "connected", lastVerifiedAt: Date.now(), justConnected: false, lastError: null });
}

const HOME_DIR = savedUserProfile || "C:\\Users\\pilli";
const TASK = "create a folder called nexuss-test in my permitted local workspace, create hello.txt inside it, write Nexuss terminal is working! into the file, then read the file";

beforeAll(() => {
  try { fs.rmSync(path.join(HOME_DIR, "nexuss-test"), { recursive: true, force: true }); } catch {}
});

afterAll(() => {
  leaveBrowserWorld();
  try { fs.rmSync(path.join(HOME_DIR, "nexuss-test"), { recursive: true, force: true }); } catch {}
});

describe.skipIf(!RUN)("browser cwd = / against the real local connector", () => {
  beforeEach(() => {
    localStorage.clear();
    clearAgentState("browserRepro");
    clearExecutionContext("browserRepro");
    resetTerminalConnection();
    calls.length = 0;
    errors.length = 0;
  });

  afterEach(() => {
    leaveBrowserWorld();
  });

  it("runs the real create/write/read task without the UNC verification error", async () => {
    enterBrowserWorld();
    // The webpack polyfill's "/" cwd must never surface as a workspace.
    expect(getDefaultUserWorkspace()).toBe("");

    setup(null);
    const res = await runAuthorizedGoal("browserRepro", TASK, { panelOpen: true, workspacePath: null });

    expect(res.executed).toBeGreaterThanOrEqual(3);
    expect(res.failed).toBe(0);
    // The historical failure surfaced as a verification error naming UNC paths.
    expect(res.finalResponse).not.toContain("UNC paths are not allowed");
    expect(res.finalResponse).not.toContain("could not verify outcome");
    expect(res.finalResponse).toContain("verified against the real filesystem");
    expect(getAgentState("browserRepro")?.status).toBe("completed");

    // No command may target a fabricated UNC ("\\...") or drive-root ("\x") path.
    const bad = calls.filter((c) =>
      /-LiteralPath\s+["']?\\\\/.test(c) ||
      /-LiteralPath\s+'\\[^\\]/.test(c) ||
      /-LiteralPath\s+"\\[^\\]/.test(c)
    );
    expect(bad).toEqual([]);

    // The task genuinely landed in the real home via the connector.
    const folder = path.join(HOME_DIR, "nexuss-test");
    const file = path.join(folder, "hello.txt");
    expect(fs.existsSync(folder)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("Nexuss terminal is working!");

    // The file context recorded a drive-absolute (or $env:) canonical path.
    const fileCtx = getRecentExecutionContext("browserRepro").find((c) => c.object === "file");
    expect(fileCtx?.path).toBeTruthy();
    expect(fileCtx?.path?.startsWith("\\")).toBe(false);
    expect(fileCtx?.path?.startsWith("\\\\")).toBe(false);
  }, 90000);
});
