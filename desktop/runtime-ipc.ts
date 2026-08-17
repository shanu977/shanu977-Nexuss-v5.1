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
    cancel: () => runtime.cancel()
  };
}

/** Turn native failures into plain IPC-serializable Errors (message preserved). */
export function toIpcError(e: unknown): Error {
  if (e instanceof NativeError) return new Error(e.message);
  return e instanceof Error ? e : new Error(String(e));
}