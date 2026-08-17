// Workspace file service for the desktop host: implements the SAME surface the
// browser WorkspaceBridge exposes (list/read/create/write/delete/rename/close)
// but against real local disk inside ONE trusted root. Every relative path is
// boundary-checked with the shared native boundary code; the model never
// supplies a filesystem root. The root is selected once through an injected
// picker (Electron dialog in main), so this module stays host-agnostic and
// unit-testable.

import { existsSync, promises as fsp, realpathSync } from "node:fs";
import path from "node:path";
import { NativeError } from "../native/errors";
import { isStrictlyInside, resolveInsideRoot } from "../native/boundary";
import type { WorkspaceFileSource, WorkspaceSnapshot } from "./types";

// Mirrors src/workspace/bridge.ts exactly so desktop and browser discovery
// behave identically for the same project.
const IGNORED_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".idea",
  ".vscode"
]);

const MAX_SCAN_DEPTH = 12;
const MAX_SCANNED_FILES = 5000;

export interface FolderPickResult {
  picked: boolean;
  root?: string;
}

export interface FolderPicker {
  pick(): Promise<FolderPickResult>;
}

export interface WorkspaceServiceOptions {
  picker?: FolderPicker | null;
  /** Called whenever the trusted root changes (connect/disconnect). */
  onWorkspaceChange?: (root: string | null) => void;
}

export interface WorkspaceService {
  currentRoot(): string | null;
  list(): Promise<WorkspaceSnapshot>;
  read(rel: string): Promise<string>;
  create(rel: string, content: string): Promise<void>;
  write(rel: string, content: string): Promise<void>;
  delete(rel: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  close(): Promise<void>;
}

export function createWorkspaceService(
  opts: WorkspaceServiceOptions = {}
): WorkspaceService {
  let root: string | null = null;

  function ensureRoot(): string {
    if (!root) throw new Error("No workspace folder is connected.");
    return root;
  }

  /** Boundary-check an EXISTING workspace-relative path (realpath verified). */
  function resolveExisting(rel: string): string {
    return resolveInsideRoot(ensureRoot(), rel);
  }

  /**
   * Boundary-check a path that may not exist yet (create/write/rename target).
   * The parent directory must exist and live inside the root; the final name
   * must be a plain file/dir name (no ".."/"." or separators escaping).
   */
  function resolveForWrite(rel: string): string {
    const rootAbs = path.normalize(ensureRoot());
    const trimmed = rel.trim().replace(/[\\/]+$/, "");
    if (!trimmed) throw new NativeError("INVALID_CWD", "A relative path is required.");
    const name = path.basename(trimmed);
    if (name === "." || name === "..") {
      throw new NativeError(
        "PATH_OUTSIDE_WORKSPACE",
        `Path traversal is not allowed: "${rel}"`
      );
    }
    const dirname = path.dirname(trimmed.replace(/\\/g, "/"));
    const parentAbs = resolveInsideRoot(rootAbs, dirname === "." ? "." : dirname);
    const joined = path.join(parentAbs, name);
    if (!isStrictlyInside(rootAbs, joined)) {
      throw new NativeError(
        "PATH_OUTSIDE_WORKSPACE",
        `Path escapes the workspace root: "${rel}"`
      );
    }
    return joined;
  }

  /** Lazily connect the folder the first time the workspace is used. */
  async function ensureConnected(): Promise<void> {
    if (root) return;
    if (!opts.picker) throw new Error("This environment cannot open folders.");
    const result = await opts.picker.pick();
    if (!result.picked || !result.root) {
      throw new Error("Folder access was not granted.");
    }
    root = result.root;
    opts.onWorkspaceChange?.(root);
  }

  async function walk(
    absDir: string,
    relDir: string,
    out: WorkspaceFileSource[],
    depth: number,
    scanned: { count: number }
  ): Promise<void> {
    if (depth > MAX_SCAN_DEPTH || scanned.count >= MAX_SCANNED_FILES) return;
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip, matching the browser bridge's walk
    }
    for (const entry of entries) {
      if (scanned.count >= MAX_SCANNED_FILES) return;
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      scanned.count++;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(absDir, entry.name), rel, out, depth + 1, scanned);
      } else if (entry.isFile()) {
        try {
          const st = await fsp.stat(path.join(absDir, entry.name));
          out.push({ path: rel, size: st.size, mtime: Math.floor(st.mtimeMs) });
        } catch {
          // file vanished mid-scan: skip
        }
      }
    }
  }

  return {
    currentRoot: () => root,

    list: async () => {
      await ensureConnected();
      const rootAbs = ensureRoot();
      const files: WorkspaceFileSource[] = [];
      const scanned = { count: 0 };
      await walk(rootAbs, "", files, 0, scanned);
      return {
        rootLabel: path.basename(rootAbs),
        lastScan: { entries: scanned.count, files: files.length },
        files
      };
    },

    read: async (rel) => {
      const abs = resolveExisting(rel);
      const st = await fsp.stat(abs);
      if (!st.isFile()) throw new Error(`Not a file: ${rel}`);
      return fsp.readFile(abs, "utf8");
    },

    create: async (rel, content) => {
      const abs = resolveForWrite(rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, "utf8");
    },

    write: async (rel, content) => {
      const abs = resolveExisting(rel);
      const st = await fsp.stat(abs);
      if (!st.isFile()) throw new Error(`Not a file: ${rel}`);
      await fsp.writeFile(abs, content, "utf8");
    },

    delete: async (rel) => {
      const abs = resolveExisting(rel);
      await fsp.rm(abs, { recursive: false, force: false });
    },

    rename: async (from, to) => {
      const absFrom = resolveExisting(from);
      const absTo = resolveForWrite(to);
      await fsp.rename(absFrom, absTo);
    },

    close: async () => {
      root = null;
      opts.onWorkspaceChange?.(null);
    }
  };
}