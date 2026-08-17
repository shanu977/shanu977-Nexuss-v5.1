// Zustand store for the Path workspace engine.
//
// Owns the current workspace/bridge/index, the panel visibility, hybrid search,
// context retrieval for chat, and safe file operations. The workspace root is
// the boundary: every operation path is validated before touching the bridge.

import { create } from "zustand";
import { FileSystemAccessBridge, InMemoryBridge, detectNativeBridge } from "./bridge";
import type { FileSource, WorkspaceBridge } from "./bridge";
import {
  DEFAULT_CONTEXT_BUDGET,
  buildContextText,
  buildManifestContext,
  buildStatusContext
} from "./context";
import { buildManifest } from "./manifest";
import type { WorkspaceManifest } from "./manifest";
import { classifyWorkspaceIntent } from "./intent";
import { MAX_FILE_SIZE, buildIndex, isSupportedFile, updateIndex } from "./indexer";
import { assertInsideRoot, normalizeRelativePath } from "./path";
import { searchIndex } from "./search";
import { redactSecrets } from "./security";
import type {
  ContextBudget,
  ContextResult,
  FileOperation,
  OperationResult,
  SearchHit,
  Workspace,
  WorkspaceErrorKind,
  WorkspaceFile,
  WorkspaceIndex,
  WorkspaceStatus
} from "./types";

const DEMO_FILES: Record<string, string> = {
  "README.md":
    "# Nexuss Sample Workspace\n\nA small project to try Path.\n\n## Files\n- src/auth/login.ts\n- src/auth/token.ts\n- src/utils/format.ts\n- server/api.py\n- tests/test_auth.py\n",
  "package.json":
    '{\n  "name": "nexuss-sample",\n  "version": "1.0.0",\n  "scripts": { "test": "vitest run" }\n}\n',
  "src/auth/login.ts": `import { validateToken } from "./token";

export interface LoginResult {
  ok: boolean;
  error?: string;
}

export async function login(username: string, password: string): Promise<LoginResult> {
  if (!username || !password) {
    return { ok: false, error: "Username and password are required." };
  }
  const token = await validateToken(username, password);
  if (!token) return { ok: false, error: "Invalid credentials." };
  return { ok: true };
}
`,
  "src/auth/token.ts": `export async function validateToken(username: string, password: string): Promise<string | null> {
  // In a real app this would verify against the backend.
  return password.length >= 8 ? "valid-token" : null;
}
`,
  "src/utils/format.ts": `export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString();
}

export function toSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
`,
  "server/api.py": `from fastapi import FastAPI, HTTPException

app = FastAPI()

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/auth/login")
def login(payload: dict):
    username = payload.get("username")
    password = payload.get("password")
    if not username or not password:
        raise HTTPException(status_code=400, detail="missing credentials")
    return {"ok": True}
`,
  "tests/test_auth.py": `from server.api import app

def test_health():
    assert app.router is not None
`
};

function normalizePathSafe(path: string): string | null {
  try {
    return normalizeRelativePath(path);
  } catch {
    return null;
  }
}

/** Read+redact every supported file once when (re)building the index. */
async function loadWorkspaceFiles(bridge: WorkspaceBridge): Promise<WorkspaceFile[]> {
  const list: FileSource[] = await bridge.list();
  const files: WorkspaceFile[] = [];
  for (const source of list) {
    const path = normalizePathSafe(source.path);
    if (path === null) continue;
    let content: string | undefined = source.content;
    if (content === undefined && isSupportedFile(path) && source.size <= MAX_FILE_SIZE) {
      content = await bridge.read(path);
    }
    files.push({
      path,
      size: source.size,
      mtime: source.mtime,
      content: content !== undefined ? redactSecrets(content, path) : undefined
    });
  }
  return files;
}

function classifyError(e: unknown): { kind: WorkspaceErrorKind; message: string } {
  const raw = e instanceof Error ? e.message : String(e);
  if (/does not support folder access|does not support folder iteration/i.test(raw)) {
    return {
      kind: "unsupported-browser",
      message:
        "This browser does not support folder access. Try Chrome or Edge, or use the sample workspace."
    };
  }
  if (/not allowed|permission|denied|illegal invocation|read only/i.test(raw)) {
    return {
      kind: "permission",
      message:
        "Folder access was not granted. Allow read permission and try connecting again."
    };
  }
  return { kind: "unknown", message: raw || "Could not open the workspace." };
}

async function initializeWorkspace(
  bridge: WorkspaceBridge,
  kind: Workspace["kind"]
): Promise<void> {
  useWorkspaceStore.setState({ status: "reading" });
  const files = await loadWorkspaceFiles(bridge);
  useWorkspaceStore.setState({ status: "indexing" });
  const index = buildIndex(bridge.rootLabel, files);
  const manifest = buildManifest(index);
  useWorkspaceStore.setState({
    workspace: { name: bridge.rootLabel, root: bridge.rootLabel, kind },
    bridge,
    index,
    manifest,
    connected: true,
    connecting: false,
    error: null,
    errorKind: null,
    status: "connected",
    discoveredFiles: bridge.lastScan?.files ?? files.length,
    searchQuery: "",
    searchResults: []
  });
}

interface WorkspaceState {
  workspace: Workspace | null;
  bridge: WorkspaceBridge | null;
  index: WorkspaceIndex | null;
  manifest: WorkspaceManifest | null;
  connected: boolean;
  connecting: boolean;
  status: WorkspaceStatus;
  errorKind: WorkspaceErrorKind | null;
  error: string | null;
  discoveredFiles: number;
  panelOpen: boolean;
  searchQuery: string;
  searchResults: SearchHit[];
  searching: boolean;
  contextBudget: ContextBudget;

  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  connectLocal: () => Promise<void>;
  connectDemo: () => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  search: (query: string) => void;
  clearError: () => void;
  setContextBudget: (budget: Partial<ContextBudget>) => void;
  buildContextFor: (question: string) => ContextResult | null;
  applyOperation: (op: FileOperation) => Promise<OperationResult>;
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => ({
  workspace: null,
  bridge: null,
  index: null,
  manifest: null,
  connected: false,
  connecting: false,
  status: "idle",
  errorKind: null,
  error: null,
  discoveredFiles: 0,
  panelOpen: false,
  searchQuery: "",
  searchResults: [],
  searching: false,
  contextBudget: DEFAULT_CONTEXT_BUDGET,

  openPanel: () => set({ panelOpen: true }),

  closePanel: () => set({ panelOpen: false }),

  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  // Connect via the native desktop bridge when present, otherwise via the
  // browser's File System Access picker (a real user gesture). Never falls
  // back to anything that would reach outside the picked directory.
  connectLocal: async () => {
    if (get().connecting) return;
    set({ connecting: true, error: null, errorKind: null, status: "selecting" });
    try {
      const native = detectNativeBridge();
      const bridge = native ?? (await FileSystemAccessBridge.pick());
      await initializeWorkspace(bridge, native ? "native" : "fs-access");
    } catch (e) {
      const { kind, message } = classifyError(e);
      set({
        connecting: false,
        connected: false,
        status: "error",
        errorKind: kind,
        error: message
      });
    }
  },

  connectDemo: async () => {
    set({ connecting: true, error: null, errorKind: null, status: "reading" });
    try {
      await initializeWorkspace(
        new InMemoryBridge("nexuss-sample", DEMO_FILES),
        "in-memory"
      );
    } catch (e) {
      const { kind, message } = classifyError(e);
      set({
        connecting: false,
        connected: false,
        status: "error",
        errorKind: kind,
        error: message
      });
    }
  },

  disconnect: async () => {
    const { bridge } = get();
    await bridge?.close().catch(() => {});
    set({
      workspace: null,
      bridge: null,
      index: null,
      manifest: null,
      connected: false,
      connecting: false,
      status: "idle",
      errorKind: null,
      error: null,
      discoveredFiles: 0,
      searchQuery: "",
      searchResults: []
    });
  },

  refresh: async () => {
    const { bridge, index, connecting } = get();
    if (!bridge || connecting) return;
    set({ connecting: true, error: null, errorKind: null, status: "reading" });
    try {
      const files = await loadWorkspaceFiles(bridge);
      const next = index
        ? updateIndex(index, files)
        : buildIndex(bridge.rootLabel, files);
      const manifest = buildManifest(next);
      set({
        index: next,
        manifest,
        connecting: false,
        status: "connected",
        discoveredFiles: bridge.lastScan?.files ?? files.length
      });
    } catch (e) {
      const { kind, message } = classifyError(e);
      set({
        connecting: false,
        status: "error",
        errorKind: kind,
        error: message
      });
    }
  },

  search: (query) => {
    const { index } = get();
    set({ searchQuery: query, searching: true });
    const results = index ? searchIndex(index, query) : [];
    set({ searchResults: results, searching: false });
  },

  clearError: () =>
    set((s) => ({
      error: null,
      errorKind: null,
      status: s.connected ? "connected" : "idle"
    })),

  setContextBudget: (budget) =>
    set((s) => ({ contextBudget: { ...s.contextBudget, ...budget } })),

  // Token-minimized context for the CURRENT question: the model only ever sees
  // the most relevant files/sections, never the whole project. Questions about
  // the workspace itself (status / manifest / summary) get a small dedicated
  // context instead of keyword retrieval, which can never match them.
  buildContextFor: (question) => {
    const { workspace, index, manifest, contextBudget } = get();
    if (!workspace) return null;
    const intent = classifyWorkspaceIntent(question);
    if (intent === "status") {
      return buildStatusContext(workspace, index);
    }
    if (intent === "manifest" || intent === "summary") {
      if (manifest && manifest.files.length > 0) {
        return buildManifestContext(workspace, manifest, contextBudget);
      }
      return buildStatusContext(workspace, index);
    }
    if (!index || index.files.length === 0 || !question.trim()) return null;
    const result = buildContextText(index, question, contextBudget);
    return result.contextText ? result : null;
  },

  // Safe file operations: paths are validated against the workspace root
  // BEFORE touching the bridge; the index is refreshed so the next request
  // reflects the change.
  applyOperation: async (op) => {
    const { bridge, index } = get();
    if (!bridge) return { ok: false, error: "No workspace connected." };
    try {
      switch (op.type) {
        case "create":
        case "write":
          assertInsideRoot("", op.path);
          if (op.type === "create") await bridge.create(op.path, op.content);
          else await bridge.write(op.path, op.content);
          break;
        case "delete":
          assertInsideRoot("", op.path);
          await bridge.delete(op.path);
          break;
        case "rename":
          assertInsideRoot("", op.from);
          assertInsideRoot("", op.to);
          await bridge.rename(op.from, op.to);
          break;
      }
      if (index) {
        try {
          const files = await loadWorkspaceFiles(bridge);
          const next = updateIndex(index, files);
          set({
            index: next,
            manifest: buildManifest(next),
            discoveredFiles: bridge.lastScan?.files ?? files.length
          });
        } catch {
          // Index refresh is best-effort; the operation itself already succeeded.
        }
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}));