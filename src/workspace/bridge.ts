// Workspace bridges: how the workspace engine talks to local files.
//
// The UI/store only ever sees the {@link WorkspaceBridge} interface, so the
// whole engine runs unchanged against:
//   - the File System Access API (real folder access in supporting browsers),
//   - an in-memory sample workspace (demo / tests / unsupported browsers),
//   - a future Nexuss desktop / local-agent bridge (window.nexussDesktop).
//
// Bridges only ever receive paths already validated as workspace-relative.

import type { WorkspaceKind } from "./types";
import type {
  NativeRuntimeBridge
} from "./agent/types";

export type { NativeRuntimeBridge } from "./agent/types";

export interface FileSource {
  path: string;
  size: number;
  mtime: number;
  content?: string;
}

export interface WorkspaceBridge {
  readonly kind: WorkspaceKind;
  readonly rootLabel: string;
  readonly rootPath: string;
  /** Discovery stats from the most recent list() call, when available. */
  readonly lastScan?: { entries: number; files: number };
  list(): Promise<FileSource[]>;
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Minimal structural typings for the File System Access API, declared locally
// so the bridge compiles regardless of the TS DOM lib version.
interface FsFileLike {
  size: number;
  lastModified: number;
  text(): Promise<string>;
}
interface FsWritableLike {
  write(data: string | Blob): Promise<void>;
  close(): Promise<void>;
}
interface FsHandleLike {
  kind: "file" | "directory";
  name: string;
  getFile?(): Promise<FsFileLike>;
  createWritable?(): Promise<FsWritableLike>;
  getFileHandle?(name: string, options?: { create?: boolean }): Promise<FsHandleLike>;
  getDirectoryHandle?(name: string, options?: { create?: boolean }): Promise<FsHandleLike>;
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries?(): AsyncIterable<[string, FsHandleLike]>;
  toURL?(): string;
}

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

export class FileSystemAccessBridge implements WorkspaceBridge {
  readonly kind = "fs-access" as const;
  readonly rootLabel: string;
  readonly rootPath: string;
  readonly lastScan = { entries: 0, files: 0 };
  private readonly root: FsHandleLike;
  private closed = false;
  private scanned = 0;

  constructor(root: FsHandleLike, rootPath: string) {
    this.root = root;
    this.rootLabel = root.name;
    this.rootPath = rootPath;
  }

  static async pick(): Promise<FileSystemAccessBridge> {
    const win = window as unknown as {
      showDirectoryPicker?: (options?: {
        mode?: "read" | "readwrite";
      }) => Promise<FsHandleLike>;
    };
    if (typeof win.showDirectoryPicker !== "function") {
      throw new Error("This browser does not support folder access.");
    }
    const handle = await win.showDirectoryPicker({ mode: "readwrite" });
    const rootPath = handle.toURL?.() ?? handle.name;
    return new FileSystemAccessBridge(handle, rootPath);
  }

  async list(): Promise<FileSource[]> {
    const out: FileSource[] = [];
    this.scanned = 0;
    await this.walk(this.root, "", out, 0);
    this.lastScan.entries = this.scanned;
    this.lastScan.files = out.length;
    return out;
  }

  private async walk(
    handle: FsHandleLike,
    rel: string,
    out: FileSource[],
    depth: number
  ): Promise<void> {
    if (this.closed || depth > MAX_SCAN_DEPTH) return;
    if (typeof handle.entries !== "function") {
      // Never fail silently: a handle without entries() would otherwise make
      // discovery return "0 files" with no explanation. Surface the real
      // condition so the store can classify it and the UI can show it.
      throw new Error(
        "This folder cannot be read by the browser: it does not support folder iteration."
      );
    }
    // Call entries() directly on the handle so `this` stays bound to it. File
    // System Access API methods brand-check their receiver and throw
    // `TypeError: Illegal invocation` if called detached (e.g. after being
    // assigned to a local variable).
    for await (const [name, child] of handle.entries()) {
      if (this.closed || this.scanned >= MAX_SCANNED_FILES) return;
      if (IGNORED_DIR_NAMES.has(name)) continue;
      this.scanned++;
      const path = rel ? `${rel}/${name}` : name;
      if (child.kind === "directory") {
        await this.walk(child, path, out, depth + 1);
      } else {
        const file = await child.getFile?.();
        if (!file) continue;
        out.push({ path, size: file.size, mtime: file.lastModified ?? 0 });
      }
    }
  }

  private async resolve(path: string): Promise<FsHandleLike> {
    const segments = path.split("/");
    let handle = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const dir = await handle.getDirectoryHandle?.(segments[i]);
      if (!dir) throw new Error(`Directory not found: ${segments[i]}`);
      handle = dir;
    }
    const file = await handle.getFileHandle?.(segments[segments.length - 1]);
    if (!file) throw new Error(`File not found: ${path}`);
    return file;
  }

  async read(path: string): Promise<string> {
    const handle = await this.resolve(path);
    const file = await handle.getFile?.();
    if (!file) throw new Error(`Not a file: ${path}`);
    return file.text();
  }

  private async getParentDir(path: string, create: boolean): Promise<FsHandleLike> {
    const segments = path.split("/");
    let handle = this.root;
    for (let i = 0; i < segments.length - 1; i++) {
      const dir = await handle.getDirectoryHandle?.(
        segments[i],
        create ? { create: true } : undefined
      );
      if (!dir) throw new Error(`Directory not found: ${segments[i]}`);
      handle = dir;
    }
    return handle;
  }

  async create(path: string, content: string): Promise<void> {
    const dir = await this.getParentDir(path, true);
    const file = await dir.getFileHandle?.(path.split("/").pop()!, { create: true });
    if (!file) throw new Error(`Could not create file: ${path}`);
    await this.writeTo(file, content);
  }

  async write(path: string, content: string): Promise<void> {
    const handle = await this.resolve(path);
    await this.writeTo(handle, content);
  }

  private async writeTo(handle: FsHandleLike, content: string): Promise<void> {
    const writable = await handle.createWritable?.();
    if (!writable) throw new Error("Permission to write was not granted.");
    await writable.write(content);
    await writable.close();
  }

  async delete(path: string): Promise<void> {
    const segments = path.split("/");
    const dir = await this.getParentDir(path, false);
    await dir.removeEntry?.(segments[segments.length - 1]);
  }

  async rename(from: string, to: string): Promise<void> {
    const content = await this.read(from);
    await this.create(to, content);
    await this.delete(from);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class InMemoryBridge implements WorkspaceBridge {
  readonly kind = "in-memory" as const;
  readonly rootLabel: string;
  readonly rootPath: string;
  readonly lastScan = { entries: 0, files: 0 };
  private readonly files = new Map<string, string>();

  constructor(name: string, rootPath = name, files: Record<string, string> = {}) {
    this.rootLabel = name;
    this.rootPath = rootPath;
    for (const [path, content] of Object.entries(files)) {
      this.files.set(path, content);
    }
  }

  async list(): Promise<FileSource[]> {
    this.lastScan.entries = this.files.size;
    this.lastScan.files = this.files.size;
    return [...this.files.entries()].map(([path, content]) => ({
      path,
      size: content.length,
      mtime: 0,
      content
    }));
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }

  async create(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async write(path: string, content: string): Promise<void> {
    if (!this.files.has(path)) throw new Error(`File not found: ${path}`);
    this.files.set(path, content);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`File not found: ${from}`);
    this.files.delete(from);
    this.files.set(to, content);
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Native desktop / local-agent bridge (future Nexuss desktop app). A native
// shell exposes an object implementing the WorkspaceBridge surface on
// window.nexussDesktop.workspace; the entire workspace engine then runs against
// real local disk without any UI/store changes. When the desktop runtime hosts
// the native execution layer, window.nexussDesktop.runtime exposes run/test.

export interface NativeWorkspaceBridge extends WorkspaceBridge {
  readonly kind: "native";
}

export interface NexussDesktop {
  workspace?: NativeWorkspaceBridge;
  runtime?: NativeRuntimeBridge;
}

export function detectNativeBridge(): NativeWorkspaceBridge | null {
  const win = window as unknown as { nexussDesktop?: NexussDesktop };
  const native = win.nexussDesktop?.workspace;
  return native && typeof native.list === "function" ? native : null;
}

export function detectNativeRuntime(): NativeRuntimeBridge | null {
  const win = window as unknown as { nexussDesktop?: NexussDesktop };
  const runtime = win.nexussDesktop?.runtime;
  return runtime && typeof runtime.run === "function" ? runtime : null;
}

export function isRuntimeCapable(
  runtime: NativeRuntimeBridge | null,
  capability: "run" | "test"
): boolean {
  if (!runtime) return false;
  const caps = runtime.capabilities();
  return caps[capability] === true;
}