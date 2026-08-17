// The validated workspace agent tool layer.
//
// These tools are the ONLY way the model/UI can inspect and change the
// workspace. Every call:
//   1. requires a connected workspace,
//   2. normalizes + boundary-checks the relative path (absolute paths and any
//      `..` escape are rejected before touching the bridge),
//   3. performs reads through the bridge,
//   4. stages writes/creates/deletes/renames as a ProposedChange (a diff the
//      user must approve) instead of touching the filesystem.
//
// Run/Test require the native desktop bridge; in the browser they report
// NOT_SUPPORTED rather than pretending to execute anything.

import { ToolError } from "./errors";
import type {
  AgentFileRef,
  NativeCommandResult,
  NativeRunRequest,
  NativeRuntimeBridge,
  NativeTestResult,
  ProposedChange,
  ReadToolResult,
  ToolContext,
  WorkspaceBridgeLike
} from "./types";
import { newProposalId } from "./types";
import { createUnifiedDiff } from "./diff";
import { contentHash, isIgnoredPath, isSupportedFile } from "../indexer";
import { assertInsideRoot, normalizeRelativePath } from "../path";
import { searchIndex } from "../search";

function requireWorkspace(ctx: ToolContext): WorkspaceBridgeLike {
  if (!ctx.connected || !ctx.bridge) {
    throw new ToolError("WORKSPACE_NOT_CONNECTED");
  }
  return ctx.bridge;
}

/** Normalize and enforce the workspace boundary for a raw tool path. */
export function assertValidPath(rawPath: string): string {
  let normalized: string;
  try {
    normalized = normalizeRelativePath(rawPath);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("escapes")) {
      throw new ToolError("PATH_OUTSIDE_WORKSPACE", message);
    }
    throw new ToolError("INVALID_PATH", message);
  }
  if (!normalized) {
    throw new ToolError("INVALID_PATH", "Path is empty.");
  }
  try {
    assertInsideRoot("", normalized);
  } catch (e) {
    throw new ToolError(
      "PATH_OUTSIDE_WORKSPACE",
      e instanceof Error ? e.message : String(e)
    );
  }
  return normalized;
}

function assertEditable(path: string): void {
  if (isIgnoredPath(path) || !isSupportedFile(path)) {
    throw new ToolError("UNSUPPORTED_FILE");
  }
}

async function fileExists(
  bridge: WorkspaceBridgeLike,
  path: string
): Promise<boolean> {
  try {
    await bridge.read(path);
    return true;
  } catch {
    return false;
  }
}

/** workspace_search: structured file search over the connected index. */
export function toolSearch(
  ctx: ToolContext,
  query: string,
  opts?: { path?: string; fileType?: string; maxResults?: number }
): AgentFileRef[] {
  requireWorkspace(ctx);
  if (!ctx.index) return [];
  const trimmed = query.trim();
  if (!trimmed) return [];
  const limit = Math.max(1, Math.min(opts?.maxResults ?? 20, 20));
  const dirFilter = opts?.path
    ? assertValidPath(opts.path)
    : undefined;
  const typeFilter = opts?.fileType?.toLowerCase();
  const hits = searchIndex(ctx.index, trimmed, { limit: limit * 2 });
  const refs: AgentFileRef[] = [];
  for (const hit of hits) {
    const file = hit.file;
    if (dirFilter && file.path !== dirFilter && !file.path.startsWith(dirFilter + "/")) {
      continue;
    }
    if (typeFilter) {
      const ext = file.ext.toLowerCase();
      if (!ext || !ext.includes(typeFilter)) continue;
    }
    refs.push({ path: file.path, name: file.name, type: "file", relevance: hit.score });
    if (refs.length >= limit) break;
  }
  return refs;
}

/** workspace_read: read a file through the bridge (never the raw filesystem). */
export async function toolRead(
  ctx: ToolContext,
  rawPath: string
): Promise<ReadToolResult> {
  const bridge = requireWorkspace(ctx);
  const path = assertValidPath(rawPath);
  let content: string;
  try {
    content = await bridge.read(path);
  } catch {
    throw new ToolError("FILE_NOT_FOUND");
  }
  return {
    relativePath: path,
    content,
    size: content.length,
    hash: contentHash(content)
  };
}

function buildProposal(input: {
  kind: ProposedChange["kind"];
  path: string;
  toPath?: string;
  before: string;
  after: string;
  originalHash: string | null;
}): ProposedChange {
  const diff =
    input.kind === "rename" || input.kind === "move"
      ? `--- a/${input.path}\n+++ b/${input.toPath}\n@@\n-${input.path}\n+${input.toPath}\n`
      : createUnifiedDiff(input.path, input.before, input.after);
  return {
    id: newProposalId(),
    kind: input.kind,
    path: input.path,
    toPath: input.toPath,
    content: input.kind === "write" || input.kind === "create" ? input.after : undefined,
    before: input.before,
    after: input.after,
    diff,
    originalHash: input.originalHash,
    createdAt: Date.now()
  };
}

/**
 * workspace_write (staged): propose replacing a file's content. The file must
 * already exist; returns a diff the user must approve. Nothing is written.
 */
export async function toolProposeWrite(
  ctx: ToolContext,
  rawPath: string,
  content: string
): Promise<ProposedChange> {
  const bridge = requireWorkspace(ctx);
  const path = assertValidPath(rawPath);
  assertEditable(path);
  if (typeof content !== "string") {
    throw new ToolError("INVALID_INPUT", "Write content must be a string.");
  }
  let before: string;
  try {
    before = await bridge.read(path);
  } catch {
    throw new ToolError("FILE_NOT_FOUND");
  }
  return buildProposal({
    kind: "write",
    path,
    before,
    after: content,
    originalHash: contentHash(before)
  });
}

/**
 * workspace_create (staged): propose creating a new file. Fails if the path
 * already exists. Nothing is written until approved.
 */
export async function toolProposeCreate(
  ctx: ToolContext,
  rawPath: string,
  content: string
): Promise<ProposedChange> {
  const bridge = requireWorkspace(ctx);
  const path = assertValidPath(rawPath);
  assertEditable(path);
  if (await fileExists(bridge, path)) {
    throw new ToolError("FILE_EXISTS");
  }
  return buildProposal({
    kind: "create",
    path,
    before: "",
    after: content,
    originalHash: null
  });
}

/**
 * workspace_upsert (staged): write if the file exists, create otherwise. Used
 * by the chat integration where the model just describes the desired result.
 */
export async function toolProposeUpsert(
  ctx: ToolContext,
  rawPath: string,
  content: string
): Promise<ProposedChange> {
  const bridge = requireWorkspace(ctx);
  const path = assertValidPath(rawPath);
  assertEditable(path);
  if (await fileExists(bridge, path)) {
    const before = await bridge.read(path);
    return buildProposal({
      kind: "write",
      path,
      before,
      after: content,
      originalHash: contentHash(before)
    });
  }
  return buildProposal({
    kind: "create",
    path,
    before: "",
    after: content,
    originalHash: null
  });
}

/**
 * workspace_delete (staged): propose removing a file. Nothing is removed
 * until the user approves the diff.
 */
export async function toolProposeDelete(
  ctx: ToolContext,
  rawPath: string
): Promise<ProposedChange> {
  const bridge = requireWorkspace(ctx);
  const path = assertValidPath(rawPath);
  let before: string;
  try {
    before = await bridge.read(path);
  } catch {
    throw new ToolError("FILE_NOT_FOUND");
  }
  return buildProposal({
    kind: "delete",
    path,
    before,
    after: "",
    originalHash: contentHash(before)
  });
}

/**
 * workspace_rename / workspace_move (staged): propose moving a file to a new
 * relative path. Both source and target are boundary-checked; the target must
 * not already exist.
 */
export async function toolProposeMove(
  ctx: ToolContext,
  fromRaw: string,
  toRaw: string,
  kind: "rename" | "move" = "move"
): Promise<ProposedChange> {
  const bridge = requireWorkspace(ctx);
  const from = assertValidPath(fromRaw);
  const to = assertValidPath(toRaw);
  if (from === to) {
    throw new ToolError("INVALID_INPUT", "Source and target are the same path.");
  }
  let before: string;
  try {
    before = await bridge.read(from);
  } catch {
    throw new ToolError("FILE_NOT_FOUND");
  }
  if (await fileExists(bridge, to)) {
    throw new ToolError("FILE_EXISTS");
  }
  return buildProposal({
    kind,
    path: from,
    toPath: to,
    before,
    after: before,
    originalHash: contentHash(before)
  });
}

function nativeRuntime(ctx: ToolContext): NativeRuntimeBridge {
  requireWorkspace(ctx);
  const runtime = ctx.runtime;
  if (!runtime || typeof runtime.run !== "function") {
    throw new ToolError("NATIVE_BRIDGE_UNAVAILABLE");
  }
  return runtime;
}

/**
 * workspace_run: execute a project command via the native desktop bridge.
 * Browser returns NATIVE_BRIDGE_UNAVAILABLE. The command string is untrusted;
 * the native runtime validates it against the workspace command policy before
 * spawning anything, and the cwd is boundary-checked here first.
 */
export async function toolRun(
  ctx: ToolContext,
  command: string,
  opts?: { cwd?: string }
): Promise<NativeCommandResult> {
  const runtime = nativeRuntime(ctx);
  if (typeof command !== "string" || !command.trim()) {
    throw new ToolError("INVALID_INPUT", "A command is required.");
  }
  const cwd = opts?.cwd ? assertValidPath(opts.cwd) : "";
  const caps = runtime.capabilities();
  if (!caps.run) {
    throw new ToolError(
      "NOT_SUPPORTED",
      "Command execution is not available in the current runtime."
    );
  }
  return runtime.run({ command, cwd } as NativeRunRequest);
}

/**
 * workspace_test: discover and run the project's test command via the native
 * bridge. Discovery happens inside the native runtime from project config;
 * the tool never invents a command.
 */
export async function toolTest(
  ctx: ToolContext,
  opts?: { cwd?: string }
): Promise<NativeTestResult> {
  const runtime = nativeRuntime(ctx);
  const cwd = opts?.cwd ? assertValidPath(opts.cwd) : "";
  const caps = runtime.capabilities();
  if (!caps.test) {
    throw new ToolError(
      "NOT_SUPPORTED",
      "Test execution is not available in the current runtime."
    );
  }
  return runtime.test({ cwd });
}

export function unwrapError(e: unknown): { code: ToolError["code"]; message: string } {
  if (e instanceof ToolError) return { code: e.code, message: e.message };
  const message = e instanceof Error ? e.message : String(e);
  return { code: "INVALID_INPUT", message };
}