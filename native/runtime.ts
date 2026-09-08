// The native runtime seam: the ONE adapter a Nexuss desktop runtime hosts.
//
// An Electron/Tauri main process (or any trusted Node host) requires this
// module, calls `createNativeRuntime()`, and exposes the returned object to
// the renderer (e.g. as `window.nexussDesktop.workspace` for file access and
// `window.nexussDesktop.runtime` for execution). The browser build never
// imports this module; the browser tool layer only sees the bridge's
// `run`/`test` methods and returns NOT_SUPPORTED when they are absent.

import { NativeError } from "./errors";
import { runCommand } from "./exec";
import type { RunningCommand } from "./exec";
import { assertCwdInsideRoot } from "./boundary";
import { discoverTestCommand } from "./discover";
import { createProcessManager } from "./process-manager";
import type { ProcessInfo, ProcessStartRequest } from "./process-manager";
import type {
  NativeCapabilities,
  NativeCommandResult,
  NativeTestResult,
  RunRequest,
  TestPlan,
  TestRequest
} from "./types";

export interface NativeRuntime {
  /** Current trusted workspace root (canonical) or null when disconnected. */
  readonly workspaceRoot: string | null;
  /** Set the workspace the runtime may execute inside. Clears active commands. */
  setWorkspace: (root: string | null) => void;
  capabilities: () => NativeCapabilities;
  run: (req: RunRequest) => Promise<NativeCommandResult>;
  test: (req: TestRequest) => Promise<NativeTestResult>;
  discoverTest: (cwd?: string) => TestPlan | null;
  cancel: () => void;
  processStart: (req: ProcessStartRequest) => Promise<ProcessInfo>;
  processStatus: (id: string) => ProcessInfo;
  processOutput: (id: string) => { stdout: string; stderr: string; outputTruncated: boolean; redacted: boolean };
  processStop: (id: string, force?: boolean) => ProcessInfo;
  processList: () => ProcessInfo[];
}

export function createNativeRuntime(): NativeRuntime {
  let root: string | null = null;
  let active: RunningCommand | null = null;
  const pm = createProcessManager();

  return {
    get workspaceRoot() {
      return root;
    },

    setWorkspace(nextRoot: string | null) {
      // Workspace switching invalidates any in-flight execution context.
      if (active) {
        active.terminate();
        active = null;
      }
      root = nextRoot ? assertCwdInsideRoot(nextRoot, ".") : null;
    },

    capabilities: () => ({
      read: true,
      search: true,
      write: true,
      create: true,
      rename: true,
      move: true,
      delete: true,
      mkdir: true,
      run: root !== null,
      test: root !== null
    }),

    run: async (req) => {
      const workspaceRoot = root;
      if (!workspaceRoot) {
        throw new NativeError("WORKSPACE_NOT_CONNECTED");
      }
      const cwd = assertCwdInsideRoot(workspaceRoot, req.cwd);
      return runCommand(req, {
        cwd,
        workspaceRoot,
        onStart: (handle) => {
          const origTerminate = handle.terminate;
          active = handle;
          handle.terminate = () => {
            active = null;
            origTerminate();
          };
        }
      }).finally(() => {
        active = null;
      });
    },

    test: async (req) => {
      const workspaceRoot = root;
      if (!workspaceRoot) {
        throw new NativeError("WORKSPACE_NOT_CONNECTED");
      }
      const cwd = assertCwdInsideRoot(workspaceRoot, req.cwd);
      const plan = discoverTestCommand(cwd);
      if (!plan) {
        throw new NativeError("TEST_COMMAND_NOT_FOUND");
      }
      const result: NativeTestResult = {
        ...(await runCommand(
          {
            command: plan.command,
            cwd: req.cwd,
            timeoutMs: req.timeoutMs,
            maxStdoutBytes: req.maxStdoutBytes,
            maxStderrBytes: req.maxStderrBytes
          },
          {
            cwd,
            workspaceRoot,
            allowedExact: [plan.command],
            onStart: (handle) => {
              const origTerminate = handle.terminate;
              active = handle;
              handle.terminate = () => {
                active = null;
                origTerminate();
              };
            }
          }
        )),
        plan
      };
      return result;
    },

    discoverTest: (cwd) => {
      if (!root) throw new NativeError("WORKSPACE_NOT_CONNECTED");
      const resolved = assertCwdInsideRoot(root, cwd);
      return discoverTestCommand(resolved);
    },

    cancel: () => {
      if (active) {
        active.terminate();
        active = null;
      }
    },

    processStart: async (req) => {
      const workspaceRoot = root;
      if (!workspaceRoot) throw new NativeError("WORKSPACE_NOT_CONNECTED");
      const cwd = assertCwdInsideRoot(workspaceRoot, req.cwd);
      return pm.start(req, { cwd, workspaceRoot });
    },
    processStatus: (id) => pm.status(id),
    processOutput: (id) => pm.output(id),
    processStop: (id, force) => pm.stop(id, force),
    processList: () => pm.list()
  };
}
