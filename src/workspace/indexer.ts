// Lightweight local index for the workspace engine.
//
// Builds and incrementally updates a per-file index (symbols, imports, chunks)
// used for hybrid search and context retrieval. Nothing here talks to a server
// or a vector store: change detection via size/mtime/content-hash keeps indexing
// cheap and incremental.

import { baseName, dirName, extName, normalizeRelativePath } from "./path";
import type { IndexedFile, WorkspaceFile, WorkspaceIndex } from "./types";

export const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".java": "java",
  ".go": "go",
  ".rs": "rust",
  ".cpp": "cpp",
  ".c": "c",
  ".cs": "csharp",
  ".php": "php",
  ".rb": "ruby",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".sql": "sql",
  ".html": "html",
  ".css": "css",
  ".scss": "scss"
};

export const IGNORED_DIRS = new Set([
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

export const IGNORED_FILES = new Set([
  ".DS_Store",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb"
]);

// Files larger than this are listed by metadata only (never content-indexed),
// so a single giant asset cannot bloat the index.
export const MAX_FILE_SIZE = 256 * 1024;

const MAX_CHUNK_LINES = 60;
const MAX_CHUNK_CHARS = 12000;

export function isIgnoredPath(path: string): boolean {
  return (
    path.split("/").some((seg) => IGNORED_DIRS.has(seg)) ||
    IGNORED_FILES.has(baseName(path))
  );
}

/** A file is content-indexed only when it is a supported text type (and not in an ignored dir). */
export function isSupportedFile(path: string): boolean {
  if (isIgnoredPath(path)) return false;
  return !!SUPPORTED_EXTENSIONS[extName(path)];
}

/** Deterministic FNV-1a hash for change detection (not cryptographic). */
export function contentHash(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function extractSymbols(content: string, ext: string): string[] {
  const symbols = new Set<string>();
  if (ext === ".py") {
    const fn = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm;
    const cls = /^class\s+([A-Za-z_]\w*)/gm;
    for (const m of content.matchAll(fn)) symbols.add(m[1]);
    for (const m of content.matchAll(cls)) symbols.add(m[1]);
  } else if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
    const re =
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/gm;
    for (const m of content.matchAll(re)) {
      for (let i = 1; i < m.length; i++) {
        if (m[i]) symbols.add(m[i]);
      }
    }
  } else if (ext === ".java") {
    const method = /(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\],\s]+\s+([A-Za-z_]\w*)\s*\(/g;
    const cls = /\bclass\s+([A-Za-z_]\w*)/g;
    for (const m of content.matchAll(method)) symbols.add(m[1]);
    for (const m of content.matchAll(cls)) symbols.add(m[1]);
  } else if (ext === ".go") {
    const re = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm;
    for (const m of content.matchAll(re)) symbols.add(m[1]);
  } else if (ext === ".rs") {
    const re = /^(?:pub\s+)?(?:async\s+)?fn\s+([a-z_]\w*)/gm;
    for (const m of content.matchAll(re)) symbols.add(m[1]);
  }
  return [...symbols];
}

export function extractImports(content: string, ext: string): string[] {
  const imports = new Set<string>();
  if (ext === ".py") {
    const re = /^(?:from\s+([\w.]+)\s+import\b|import\s+([\w.]+))/gm;
    for (const m of content.matchAll(re)) imports.add(m[1] || m[2]);
  } else if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
    const re = /(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\))/g;
    for (const m of content.matchAll(re)) imports.add(m[1] || m[2]);
  } else if (ext === ".go") {
    const re = /"([\w./-]+)"/g;
    for (const m of content.matchAll(re)) {
      if (m[1].includes("/")) imports.add(m[1]);
    }
  }
  return [...imports];
}

/** Split content into contiguous line chunks (joined back, they reproduce the original exactly). */
export function chunkText(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const chunks: string[] = [];
  let buffer: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (line.length > MAX_CHUNK_CHARS) {
      if (buffer.length) {
        chunks.push(buffer.join("\n"));
        buffer = [];
        chars = 0;
      }
      chunks.push(line);
      continue;
    }
    if (buffer.length >= MAX_CHUNK_LINES || chars + line.length > MAX_CHUNK_CHARS) {
      chunks.push(buffer.join("\n"));
      buffer = [];
      chars = 0;
    }
    buffer.push(line);
    chars += line.length + 1;
  }
  if (buffer.length) chunks.push(buffer.join("\n"));
  return chunks;
}

export function indexFile(file: WorkspaceFile): IndexedFile {
  const path = normalizeRelativePath(file.path);
  const content = file.content ?? "";
  const ext = extName(path);
  const hasContent = content.length > 0;
  return {
    path,
    name: baseName(path),
    ext,
    language: SUPPORTED_EXTENSIONS[ext] ?? "text",
    dir: dirName(path),
    size: file.size ?? content.length,
    mtime: file.mtime ?? 0,
    contentHash: hasContent ? contentHash(content) : "",
    symbols: hasContent ? extractSymbols(content, ext) : [],
    imports: hasContent ? extractImports(content, ext) : [],
    chunks: hasContent ? chunkText(content) : []
  };
}

export function buildIndex(root: string, files: WorkspaceFile[]): WorkspaceIndex {
  const indexed: IndexedFile[] = [];
  for (const file of files) {
    try {
      indexed.push(indexFile(file));
    } catch {
      // Paths that cannot be normalized (e.g. escaping) are never indexed.
    }
  }
  return {
    root,
    files: indexed,
    byPath: new Map(indexed.map((f) => [f.path, f])),
    builtAt: Date.now(),
    scannedCount: files.length,
    changedCount: indexed.length
  };
}

/**
 * Incremental re-index: only files whose size, mtime, or content hash changed
 * are re-indexed; everything else is reused from the previous index.
 */
export function updateIndex(
  prev: WorkspaceIndex,
  files: WorkspaceFile[]
): WorkspaceIndex {
  const byPath = new Map(prev.byPath);
  const seen = new Set<string>();
  let changed = 0;
  for (const file of files) {
    let path: string;
    try {
      path = normalizeRelativePath(file.path);
    } catch {
      continue;
    }
    seen.add(path);
    const existing = byPath.get(path);
    if (!existing) {
      byPath.set(path, indexFile(file));
      changed++;
      continue;
    }
    const sizeChanged = file.size !== existing.size;
    const mtimeChanged = file.mtime !== existing.mtime;
    const contentChanged =
      file.content !== undefined &&
      (file.content.length === 0
        ? existing.contentHash !== ""
        : existing.contentHash !== contentHash(file.content));
    if (sizeChanged || mtimeChanged || contentChanged) {
      byPath.set(path, indexFile(file));
      changed++;
    }
  }
  let removed = 0;
  for (const path of [...byPath.keys()]) {
    if (!seen.has(path)) {
      byPath.delete(path);
      removed++;
    }
  }
  return {
    root: prev.root,
    files: [...byPath.values()],
    byPath,
    builtAt: Date.now(),
    scannedCount: files.length,
    changedCount: changed + removed
  };
}