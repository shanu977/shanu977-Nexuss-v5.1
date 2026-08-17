// Shared contracts for native command/test execution.
//
// This module is the ONE place the run/test contract is defined. The browser
// tool layer and the desktop runtime (which hosts this package in its main
// process) both speak these types; the runtime NEVER leaks raw child-process
// objects across the boundary, only this serializable shape.

/** Everything the native runtime needs to run one command. */
export interface RunRequest {
  /** Full command line, e.g. "npm test" or "python -m pytest". Untrusted: the
   *  runtime validates it against the command policy before executing. */
  command: string;
  /** Workspace-relative working directory ("" = workspace root). */
  cwd?: string;
  /** Hard kill-after timeout; defaults to DEFAULT_COMMAND_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Max bytes of stdout kept (per stream); excess is dropped + flagged. */
  maxStdoutBytes?: number;
  /** Max bytes of stderr kept (per stream); excess is dropped + flagged. */
  maxStderrBytes?: number;
}

/** Result of a single native process execution. Fully serializable. */
export interface NativeCommandResult {
  command: string;
  /** Canonical absolute cwd the process actually ran in. */
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  killed: boolean;
  /** Signal that terminated the process, when the platform reports one. */
  signal: string | null;
  success: boolean;
  outputTruncated: boolean;
  /** True when the runtime redacted secret-shaped text from the output. */
  redacted: boolean;
}

/** Test execution request; the command itself is discovered, never invented. */
export interface TestRequest {
  /** Workspace-relative directory containing the project under test. */
  cwd?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

/** The result of a test run (extends the command result with the plan). */
export interface NativeTestResult extends NativeCommandResult {
  /** The discovered test plan that produced `command`. */
  plan: TestPlan;
}

export interface TestPlan {
  command: string;
  /** Where the command came from (package.json, pytest.ini, ...). */
  source: string;
  /** High when the project config states the test command explicitly. */
  confidence: "high" | "medium";
}

/** Which runtime capabilities the connected bridge currently offers. */
export interface NativeCapabilities {
  read: boolean;
  search: boolean;
  write: boolean;
  create: boolean;
  rename: boolean;
  move: boolean;
  delete: boolean;
  run: boolean;
  test: boolean;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
export const KILL_GRACE_MS = 1500;
