// Stable error codes for native execution. The browser tool layer mirrors
// these codes; never invent parallel code sets.

import { DEFAULT_MESSAGES as TOOL_DEFAULT_MESSAGES } from "../src/workspace/agent/errors";

export type NativeErrorCode =
  | "NATIVE_BRIDGE_UNAVAILABLE"
  | "WORKSPACE_NOT_CONNECTED"
  | "PATH_OUTSIDE_WORKSPACE"
  | "INVALID_CWD"
  | "COMMAND_NOT_ALLOWED"
  | "COMMAND_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "COMMAND_TIMEOUT"
  | "COMMAND_FAILED"
  | "OUTPUT_LIMIT"
  | "TEST_COMMAND_NOT_FOUND"
  | "TEST_TIMEOUT"
  | "TEST_FAILED";

const MESSAGES: Record<NativeErrorCode, string> = {
  NATIVE_BRIDGE_UNAVAILABLE: "Command execution requires the Nexuss desktop runtime.",
  WORKSPACE_NOT_CONNECTED: "No workspace is connected.",
  PATH_OUTSIDE_WORKSPACE: "The requested path escapes the workspace root.",
  INVALID_CWD: "The working directory is not a valid workspace-relative path.",
  COMMAND_NOT_ALLOWED: "That command is not allowed by the workspace command policy.",
  COMMAND_NOT_FOUND: "The command binary was not found.",
  PERMISSION_DENIED: "The command was denied by the execution policy.",
  COMMAND_TIMEOUT: "The command timed out and was terminated.",
  COMMAND_FAILED: "The command exited with a non-zero status.",
  OUTPUT_LIMIT: "The command produced too much output and was terminated.",
  TEST_COMMAND_NOT_FOUND: "No test command could be discovered for this project.",
  TEST_TIMEOUT: "The test run timed out and was terminated.",
  TEST_FAILED: "The test run failed."
};

export class NativeError extends Error {
  readonly code: NativeErrorCode;

  constructor(code: NativeErrorCode, message?: string) {
    super(message ?? MESSAGES[code]);
    this.name = "NativeError";
    this.code = code;
  }
}

/** Map a native execution failure into the browser tool layer's code space. */
export function toToolErrorCode(code: NativeErrorCode): string {
  const known = TOOL_DEFAULT_MESSAGES as Record<string, string>;
  return code in known ? code : "INVALID_INPUT";
}

export function isNativeError(e: unknown): e is NativeError {
  return e instanceof NativeError;
}