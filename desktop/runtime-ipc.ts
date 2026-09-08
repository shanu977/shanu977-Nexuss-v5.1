// Runtime IPC adapter: translates the renderer's runtime request surface into
// calls on the trusted NativeRuntime (native/runtime.ts). No Electron imports
// here, so the whole adapter is unit-testable and host-agnostic (Electron,
// Tauri, or any trusted Node host can reuse it).

import { NativeError } from "../native/errors";
import type { NativeRuntime } from "../native/runtime";
import type {
  NativeCapabilities,
  NativeCommandResult,
  NativeTestResult,
  RunRequest,
  TestRequest
} from "../native/types";

export interface RuntimeHandlers {
  run: (req: RunRequest) => Promise<NativeCommandResult>;
  test: (req: TestRequest) => Promise<NativeTestResult>;
  capabilities: () => NativeCapabilities;
  cancel: () => void;
  processStart: (req: import("../native/process-manager").ProcessStartRequest) => Promise<import("../native/process-manager").ProcessInfo>;
  processStatus: (id: string) => import("../native/process-manager").ProcessInfo;
  processOutput: (id: string) => { stdout: string; stderr: string; outputTruncated: boolean; redacted: boolean };
  processStop: (id: string, force?: boolean) => import("../native/process-manager").ProcessInfo;
  processList: () => import("../native/process-manager").ProcessInfo[];
}

export function createRuntimeHandlers(runtime: NativeRuntime): RuntimeHandlers {
  return {
    run: async (req) => {
      try {
        return await runtime.run(req);
      } catch (e) {
        throw toIpcError(e);
      }
    },
    test: async (req) => {
      try {
        return await runtime.test(req);
      } catch (e) {
        throw toIpcError(e);
      }
    },
    capabilities: () => runtime.capabilities(),
    cancel: () => runtime.cancel(),
    processStart: async (req) => {
      try { return await runtime.processStart(req); } catch (e) { throw toIpcError(e); }
    },
    processStatus: (id) => {
      try { return runtime.processStatus(id); } catch (e) { throw toIpcError(e); }
    },
    processOutput: (id) => {
      try { return runtime.processOutput(id); } catch (e) { throw toIpcError(e); }
    },
    processStop: (id, force) => {
      try { return runtime.processStop(id, force); } catch (e) { throw toIpcError(e); }
    },
    processList: () => runtime.processList()
  };
}

/** Turn native failures into plain IPC-serializable Errors (message preserved). */
export function toIpcError(e: unknown): Error {
  if (e instanceof NativeError) return new Error(e.message);
  return e instanceof Error ? e : new Error(String(e));
}