// Typed errors for the validated workspace agent tool layer.
//
// Every tool reports failure through a stable machine-readable code so the UI
// (and a future backend tool-controller) can render a precise, safe message
// instead of a raw exception string.

/** Stable machine-readable failure codes returned by agent tools. */
export type ToolErrorCode =
  | "WORKSPACE_NOT_CONNECTED"
  | "PERMISSION_REQUIRED"
  | "PATH_OUTSIDE_WORKSPACE"
  | "INVALID_PATH"
  | "FILE_NOT_FOUND"
  | "FILE_EXISTS"
  | "FILE_CHANGED"
  | "UNSUPPORTED_FILE"
  | "NOT_SUPPORTED"
  | "INVALID_INPUT"
  | "NATIVE_BRIDGE_UNAVAILABLE"
  | "COMMAND_NOT_ALLOWED"
  | "COMMAND_NOT_FOUND"
  | "INVALID_CWD"
  | "PERMISSION_DENIED"
  | "COMMAND_TIMEOUT"
  | "COMMAND_FAILED"
  | "OUTPUT_LIMIT"
  | "TEST_COMMAND_NOT_FOUND"
  | "TEST_TIMEOUT"
  | "TEST_FAILED"
  | "EDIT_CONFLICT"
  | "PROCESS_NOT_FOUND"
  | "PATH_DISABLED";

export const DEFAULT_MESSAGES: Record<ToolErrorCode, string> = {
  WORKSPACE_NOT_CONNECTED:
    "No workspace is connected. Connect workspace before using terminal tools.",
  PERMISSION_REQUIRED:
    "The folder permission has expired. Re-grant read access and try again.",
  PATH_OUTSIDE_WORKSPACE:
    "That path escapes the workspace root and was rejected.",
  INVALID_PATH: "That path is not a valid relative workspace path.",
  FILE_NOT_FOUND: "That file does not exist in the workspace.",
  FILE_EXISTS: "A file with that path already exists.",
  FILE_CHANGED:
    "That file changed after it was read. Reload it before applying the change.",
  UNSUPPORTED_FILE:
    "That file type is not supported for workspace edits.",
  NOT_SUPPORTED:
    "This operation requires the Nexuss desktop bridge and is not available in the browser.",
  INVALID_INPUT: "The tool received an invalid argument.",
  NATIVE_BRIDGE_UNAVAILABLE:
    "Command execution requires the Nexuss desktop runtime.",
  COMMAND_NOT_ALLOWED: "That command is not allowed by the workspace command policy.",
  COMMAND_NOT_FOUND: "The command binary was not found.",
  INVALID_CWD: "The working directory is not a valid workspace-relative path.",
  PERMISSION_DENIED: "The command was denied by the execution policy.",
  COMMAND_TIMEOUT: "The command timed out and was terminated.",
  COMMAND_FAILED: "The command exited with a non-zero status.",
  OUTPUT_LIMIT: "The command produced too much output and was terminated.",
  TEST_COMMAND_NOT_FOUND: "No test command could be discovered for this project.",
  TEST_TIMEOUT: "The test run timed out and was terminated.",
  TEST_FAILED: "The test run failed.",
  EDIT_CONFLICT: "The edit target was not found or matched multiple locations. Provide unique surrounding context.",
  PROCESS_NOT_FOUND: "The requested process does not exist or has already exited.",
  PATH_DISABLED: "Terminal is not connected — connect workspace to use terminal tools."
};

export class ToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message?: string) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = "ToolError";
    this.code = code;
  }
}