// Nexuss native execution runtime (STEP 1-14).
//
// A desktop runtime (Electron main / Tauri / any trusted Node host) requires
// this package and hosts `createNativeRuntime()` behind `window.nexussDesktop`.
// The browser never bundles this code; it only talks to the bridge surface.

export { NativeError, toToolErrorCode, isNativeError } from "./errors";
export type { NativeErrorCode } from "./errors";
export { createNativeRuntime } from "./runtime";
export type { NativeRuntime } from "./runtime";
export { runCommand } from "./exec";
export type { RunningCommand } from "./exec";
export {
  validateCommand,
  tokenizeCommand,
  normalizeCommand
} from "./policy";
export {
  discoverBuildCommand,
  discoverLintCommand,
  discoverTestCommand
} from "./discover";
export {
  assertCwdInsideRoot,
  isStrictlyInside,
  resolveInsideRoot
} from "./boundary";
export {
  buildScrubbedEnv,
  collectSensitiveEnvValues,
  redactOutput
} from "./redact";
export {
  detectPackageManager,
  hasPytestConfig,
  readPackageJson,
  readText
} from "./project";
export {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  KILL_GRACE_MS,
  MAX_TIMEOUT_MS
} from "./types";
export type {
  NativeCapabilities,
  NativeCommandResult,
  NativeTestResult,
  RunRequest,
  TestPlan,
  TestRequest
} from "./types";
