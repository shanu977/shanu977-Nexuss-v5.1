// Security-critical path utilities for the workspace engine.
//
// All workspace file paths are relative to the workspace root. These helpers
// normalize separators, resolve "." and "..", and REJECT anything that would
// escape the root (absolute paths, leading "..", drive letters). They are the
// first line of defense for the workspace boundary.

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

function isAbsolute(input: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(input)) return true;
  return input.startsWith("/") || input.startsWith("\\");
}

/**
 * Normalize a workspace-relative path to POSIX form, resolving "." and "..".
 * Throws {@link WorkspacePathError} for absolute paths and for any traversal
 * that would escape the workspace root.
 */
export function normalizeRelativePath(input: string): string {
  const cleaned = input.replace(/\\/g, "/").trim();
  if (!cleaned) return "";
  if (isAbsolute(cleaned)) {
    throw new WorkspacePathError(`Absolute paths are not allowed: "${input}"`);
  }
  const segments = cleaned.split("/").filter((s) => s.length > 0);
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) {
        throw new WorkspacePathError(`Path escapes the workspace root: "${input}"`);
      }
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}

/**
 * True when `candidate` is the root itself or lives beneath it. Both are
 * normalized first; anything unnormalizable (escape/absolute) is rejected.
 */
export function isPathInside(root: string, candidate: string): boolean {
  let r: string;
  let c: string;
  try {
    r = normalizeRelativePath(root);
    c = normalizeRelativePath(candidate);
  } catch {
    return false;
  }
  if (r === "") return true;
  return c === r || c.startsWith(r + "/");
}

/**
 * Final defense for file operations: normalize `relativePath` (throwing on
 * absolute/escaping input) and verify it stays inside `root`.
 */
export function assertInsideRoot(root: string, relativePath: string): void {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    throw new WorkspacePathError("Path is empty.");
  }
  if (!isPathInside(root, normalized)) {
    throw new WorkspacePathError(`Path is outside the workspace root: "${relativePath}"`);
  }
}

export function joinRelative(...parts: string[]): string {
  return normalizeRelativePath(parts.join("/"));
}

export function dirName(path: string): string {
  const n = normalizeRelativePath(path);
  const idx = n.lastIndexOf("/");
  return idx === -1 ? "" : n.slice(0, idx);
}

export function baseName(path: string): string {
  const n = normalizeRelativePath(path);
  const idx = n.lastIndexOf("/");
  return idx === -1 ? n : n.slice(idx + 1);
}

export function extName(path: string): string {
  const name = baseName(path);
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx).toLowerCase();
}