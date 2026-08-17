// Workspace boundary enforcement for native execution.
//
// The model NEVER supplies a filesystem root. The runtime holds ONE trusted
// root (set when the workspace is connected) and every cwd/command runs inside
// it. Relative paths are resolved against the root, canonicalized (realpath),
// and re-checked: `..`, absolute paths, drive letters, UNC hosts, and symlink
// escapes are rejected.

import { realpathSync } from "node:fs";
import path from "node:path";
import { NativeError } from "./errors";

function isAbsolute(input: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(input)) return true;
  if (/^\\\\[^\\]+\\[^\\]+/.test(input)) return true; // UNC host\share
  return input.startsWith("/") || input.startsWith("\\");
}

/**
 * Resolve a workspace-relative path against the trusted root and verify the
 * canonical (realpath) result is still inside the root. Rejects:
 *   - absolute paths and UNC shares (they are never workspace-relative)
 *   - `..` traversal that escapes the root
 *   - symlinks whose target escapes the root (detected via realpath)
 *   - paths that do not exist (the command cwd must exist)
 */
export function resolveInsideRoot(
  root: string,
  relativePath: string
): string {
  const normalizedRoot = path.normalize(root);
  const trimmed = relativePath.trim();
  if (!trimmed || trimmed === ".") return canonicalize(normalizedRoot);

  if (isAbsolute(trimmed)) {
    throw new NativeError("INVALID_CWD", `Absolute path is not allowed: "${relativePath}"`);
  }
  const segments = trimmed.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.some((seg) => seg === "..")) {
    throw new NativeError("PATH_OUTSIDE_WORKSPACE", `Path traversal is not allowed: "${relativePath}"`);
  }
  const joined = path.join(normalizedRoot, ...segments);
  const canonical = canonicalize(joined);
  if (!isStrictlyInside(normalizedRoot, canonical)) {
    throw new NativeError("PATH_OUTSIDE_WORKSPACE", `Path escapes the workspace root: "${relativePath}"`);
  }
  return canonical;
}

/** Verify a canonical path lives inside a canonical root (or equals it). */
export function isStrictlyInside(root: string, candidate: string): boolean {
  const r = path.normalize(root).toLowerCase();
  const c = path.normalize(candidate).toLowerCase();
  return c === r || c.startsWith(r + path.sep);
}

/** realpath the given path; throws INVALID_CWD when it does not exist. */
function canonicalize(p: string): string {
  try {
    return realpathSync.native ? realpathSync.native(p) : realpathSync(p);
  } catch {
    throw new NativeError("INVALID_CWD", `Directory does not exist: "${p}"`);
  }
}

/**
 * True when the runtime may attempt execution for the given request cwd. Used
 * to fail fast before any process is spawned.
 */
export function assertCwdInsideRoot(root: string, relativePath?: string): string {
  if (!root) throw new NativeError("WORKSPACE_NOT_CONNECTED");
  return resolveInsideRoot(root, relativePath ?? ".");
}
