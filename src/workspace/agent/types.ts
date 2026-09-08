// Types for the validated workspace agent tool layer.
//
// Tools NEVER touch the filesystem directly: they validate the active
// workspace and the relative path against the workspace root, then route every
// read/write through the existing bridge. Destructive operations are staged as
// ProposedChange values that the UI shows as a diff and the user must approve
// before anything is written.

import type { WorkspaceIndex } from "../types";

/** Shared context a tool needs to run. Built from the store by the caller. */
export interface ToolContext {
  connected: boolean;
  pathEnabled?: boolean;
  bridge: WorkspaceBridgeLike | null;
  index: WorkspaceIndex | null;
  /** Native execution surface (window.nexussDesktop.runtime) or null. */
  runtime: NativeRuntimeBridge | null;
}

/** Structural subset of the bridge the tools rely on (kept narrow on purpose). */
export interface WorkspaceBridgeLike {
  read: (path: string) => Promise<string>;
  create: (path: string, content: string) => Promise<void>;
  write: (path: string, content: string) => Promise<void>;
  delete: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  list: () => Promise<{ path: string; size: number; mtime: number; content?: string }[]>;
  rootLabel: string;
}

/** A file search result surfaced to the model/UI. */
export interface AgentFileRef {
  path: string;
  name: string;
  type: "file" | "directory";
  relevance?: number;
}

/** Result of reading a file through the validated layer. */
export interface ReadToolResult {
  relativePath: string;
  content: string;
  size: number;
  hash: string;
}

/** A single staged, user-approved-before-apply change. */
export type ProposedChangeKind =
  | "write"
  | "create"
  | "delete"
  | "rename"
  | "move"
  | "mkdir";

export interface ProposedChange {
  id: string;
  kind: ProposedChangeKind;
  /** Relative workspace path being changed. */
  path: string;
  /** Target path for rename/move. */
  toPath?: string;
  /** Proposed full file content (write/create). */
  content?: string;
  /** File content when the proposal was staged ("" for create). */
  before: string;
  /** Proposed file content ("" for delete). */
  after: string;
  /** Unified diff between before and after, for the approval UI. */
  diff: string;
  /** contentHash of the file as read when staged; null for create. */
  originalHash: string | null;
  createdAt: number;
}

/** Normalized operation parsed from a model `workspace-change` block. */
export interface ParsedChangeOp {
  path: string;
  content: string;
}

/** A structured edit request extracted from an assistant reply. */
export interface ParsedChangeBlock {
  changes: ParsedChangeOp[];
}

/** A run request extracted from a `workspace-command` block. */
export interface ParsedRunOp {
  command: string;
  cwd?: string;
}

/** A test request extracted from a `workspace-command` block. */
export interface ParsedTestOp {
  cwd?: string;
}

export interface ParsedCommandBlock {
  run?: ParsedRunOp;
  test?: ParsedTestOp;
}

/** Everything the native bridge needs to run one command. */
export interface NativeRunRequest {
  command: string;
  /** Workspace-relative working directory ("" = workspace root). */
  cwd?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

/** Fully serializable result of a native process execution. */
export interface NativeCommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  killed: boolean;
  signal: string | null;
  success: boolean;
  outputTruncated: boolean;
  redacted: boolean;
}

/** A discovered test plan returned by the native bridge. */
export interface NativeTestPlan {
  command: string;
  source: string;
  confidence: "high" | "medium";
}

export interface NativeTestResult extends NativeCommandResult {
  plan?: NativeTestPlan;
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
  mkdir: boolean;
  run: boolean;
  test: boolean;
}

/** Execution surface exposed by a native/desktop bridge, never the browser. */
export interface CommandBridge {
  run: (req: NativeRunRequest) => Promise<NativeCommandResult>;
  test: (req: { cwd?: string; timeoutMs?: number }) => Promise<NativeTestResult>;
}

/** The `window.nexussDesktop.runtime` surface hosted by the desktop runtime. */
export interface NativeRuntimeBridge {
  run: (req: NativeRunRequest) => Promise<NativeCommandResult>;
  test: (req: { cwd?: string; timeoutMs?: number }) => Promise<NativeTestResult>;
  capabilities: () => NativeCapabilities;
  /** Terminate any in-flight command (optional; absent means no cancellation). */
  cancel?: () => void;
  processStart?: (req: { command: string; cwd?: string; timeoutMs?: number | null }) => Promise<{ id: string; command: string; cwd: string; pid?: number; startedAt: number; status: string; exitCode: number | null }>;
  processStatus?: (id: string) => { id: string; status: string; exitCode: number | null; durationMs: number };
  processOutput?: (id: string) => { stdout: string; stderr: string; outputTruncated: boolean; redacted: boolean };
  processStop?: (id: string, force?: boolean) => { id: string; status: string };
  processList?: () => { id: string; command: string; status: string }[];
}

/** A command staged for the user to approve before it is executed. */
export interface PendingCommand {
  id: string;
  kind: "run" | "test";
  command: string;
  cwd: string;
  plan: NativeTestPlan | null;
  createdAt: number;
}

/** Structured result of an executed command, surfaced in the panel. */
export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  killed: boolean;
  success: boolean;
  outputTruncated: boolean;
  redacted: boolean;
}

export const AGENT_CHANGE_FENCE = "workspace-change";
export const AGENT_COMMAND_FENCE = "workspace-command";
export const AGENT_LOG_LIMIT = 20;

export interface AgentLogEntry {
  kind:
    | "read"
    | "search"
    | "propose"
    | "apply"
    | "reject"
    | "error"
    | "run"
    | "test";
  message: string;
  at: number;
}

export function newProposalId(): string {
  return `chg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function newCommandId(): string {
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}