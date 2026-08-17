// Strict parsers for the fenced blocks the model may emit in its reply.
//
//   `workspace-change`  -> proposed file edits (staged as diffs, user approved)
//   `workspace-command` -> proposed run/test (staged, user approved)
//
// The client turns a valid block into a staged, user-approved action; a
// malformed or unsafe block is ignored (never executed) so a confused model
// cannot cause harm.

import { AGENT_CHANGE_FENCE, AGENT_COMMAND_FENCE } from "./types";
import type {
  ParsedChangeBlock,
  ParsedChangeOp,
  ParsedCommandBlock,
  ParsedRunOp,
  ParsedTestOp
} from "./types";
import { isIgnoredPath, isSupportedFile } from "../indexer";
import { normalizeRelativePath } from "../path";

const FENCE_RE = new RegExp(
  "```" + AGENT_CHANGE_FENCE + "\\s*([\\s\\S]*?)```",
  "i"
);
const COMMAND_FENCE_RE = new RegExp(
  "```" + AGENT_COMMAND_FENCE + "\\s*([\\s\\S]*?)```",
  "i"
);

function isValidChangeOp(op: unknown): op is ParsedChangeOp {
  if (typeof op !== "object" || op === null) return false;
  const { path, content } = op as Record<string, unknown>;
  if (typeof path !== "string" || typeof content !== "string") return false;
  if (content.length > 1024 * 1024) return false;
  let normalized: string;
  try {
    normalized = normalizeRelativePath(path);
  } catch {
    return false;
  }
  // Only edits to indexable, non-ignored files are allowed through the gate.
  if (isIgnoredPath(normalized) || !isSupportedFile(normalized)) return false;
  return true;
}

/** Extract a valid, safely-parseable change block from an assistant reply. */
export function extractChangeBlock(reply: string): ParsedChangeBlock | null {
  const match = FENCE_RE.exec(reply);
  if (!match) return null;
  let data: unknown;
  try {
    data = JSON.parse(match[1].trim());
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const changes = (data as { changes?: unknown }).changes;
  if (!Array.isArray(changes) || changes.length === 0) return null;
  const valid = changes.filter(isValidChangeOp);
  if (valid.length === 0) return null;
  return { changes: valid };
}

/**
 * Remove any `workspace-change` fenced block from a reply so raw JSON never
 * leaks into the chat transcript. The block (valid or not) is always stripped.
 */
export function stripChangeBlock(reply: string): string {
  const stripped = reply.replace(FENCE_RE, "").trim();
  return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

function parseCwd(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    return normalizeRelativePath(raw);
  } catch {
    return undefined;
  }
}

function parseRun(raw: unknown): ParsedRunOp | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { command, cwd } = raw as Record<string, unknown>;
  if (typeof command !== "string" || !command.trim() || command.length > 2000) {
    return undefined;
  }
  if (cwd !== undefined && typeof cwd !== "string") return undefined;
  const parsedCwd = parseCwd(cwd);
  // An escaping/invalid cwd is a safety-relevant signal: drop the whole run.
  if (cwd !== undefined && parsedCwd === undefined) return undefined;
  return { command: command.trim(), cwd: parsedCwd };
}

function parseTest(raw: unknown): ParsedTestOp | undefined {
  if (typeof raw === "boolean") return raw ? {} : undefined;
  if (typeof raw !== "object" || raw === null) return undefined;
  const { cwd } = raw as Record<string, unknown>;
  if (cwd !== undefined && typeof cwd !== "string") return undefined;
  const parsedCwd = parseCwd(cwd);
  if (cwd !== undefined && parsedCwd === undefined) return undefined;
  return { cwd: parsedCwd };
}

/** Extract a valid `workspace-command` block (run and/or test) from a reply. */
export function extractCommandBlock(reply: string): ParsedCommandBlock | null {
  const match = COMMAND_FENCE_RE.exec(reply);
  if (!match) return null;
  let data: unknown;
  try {
    data = JSON.parse(match[1].trim());
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const run = parseRun(record.run);
  const test = parseTest(record.test);
  if (!run && !test) return null;
  return { run, test };
}

/** True when a reply contains a `workspace-command` fence (valid or not). */
export function hasCommandFence(reply: string): boolean {
  return COMMAND_FENCE_RE.test(reply);
}

/** Remove any `workspace-command` fenced block from a reply. */
export function stripCommandBlock(reply: string): string {
  return reply.replace(COMMAND_FENCE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}