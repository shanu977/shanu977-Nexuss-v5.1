// Zustand store for the Path workspace engine.
//
// Owns the current workspace/bridge/index, the panel visibility, hybrid search,
// context retrieval for chat, and safe file operations. The workspace root is
// the boundary: every operation path is validated before touching the bridge.

import { create } from "zustand";
import { FileSystemAccessBridge, InMemoryBridge, detectNativeBridge, detectNativeRuntime } from "./bridge";
import type { FileSource, NativeRuntimeBridge, WorkspaceBridge } from "./bridge";
import { createLocalConnectorRuntime } from "./localTerminalRuntime";
import {
  DEFAULT_CONTEXT_BUDGET,
  buildAmbiguityContext,
  buildContextText,
  buildDisconnectedContext,
  buildFileContext,
  buildManifestContext,
  buildStatusContext
} from "./context";
import { buildManifest } from "./manifest";
import type { WorkspaceManifest } from "./manifest";
import { classifyWorkspaceIntent } from "./intent";
import { resolveReference } from "./references";
import { MAX_FILE_SIZE, buildIndex, contentHash, isSupportedFile, updateIndex } from "./indexer";
import { assertInsideRoot, normalizeRelativePath } from "./path";
import { searchIndex } from "./search";
import { redactSecrets } from "./security";
import {
  toolProposeDelete,
  toolProposeMove,
  toolProposeUpsert,
  toolRun,
  toolTest,
  unwrapError
} from "./agent/tools";
import type {
  AgentLogEntry,
  CommandResult,
  ParsedChangeOp,
  ParsedCommandBlock,
  PendingCommand,
  ProposedChange
} from "./agent/types";
import { AGENT_LOG_LIMIT, newCommandId } from "./agent/types";
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

/** Append entries to the agent log, keeping only the most recent ones. */
function withLog(log: AgentLogEntry[], ...entries: AgentLogEntry[]): AgentLogEntry[] {
  return [...log, ...entries].slice(-AGENT_LOG_LIMIT);
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

const STORE_INSTANCE_ID = Math.random().toString(36).slice(2, 6);
console.debug(`[Path Store ${STORE_INSTANCE_ID}] initialized`);

async function initializeWorkspace(
  bridge: WorkspaceBridge,
  kind: Workspace["kind"]
): Promise<void> {
  console.debug(`[Path ${STORE_INSTANCE_ID}] initializeWorkspace start`, { kind, rootLabel: bridge.rootLabel, rootPath: bridge.rootPath });
  useWorkspaceStore.setState({ status: "reading" });
  const files = await loadWorkspaceFiles(bridge);
  console.debug(`[Path ${STORE_INSTANCE_ID}] loadWorkspaceFiles done`, { files: files.length });
  useWorkspaceStore.setState({ status: "indexing" });
  const index = buildIndex(bridge.rootLabel, files);
  const manifest = buildManifest(index);
  console.debug(`[Path ${STORE_INSTANCE_ID}] buildIndex done`, { files: index.files.length });
  useWorkspaceStore.setState({
    workspace: { name: bridge.rootLabel, root: bridge.rootPath, kind },
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
    searchResults: [],
    // A new workspace replaces the previous one: conversation references must
    // never survive a switch between different projects.
    lastSearchResults: [],
    lastReferencedFile: null,
    // The native execution runtime is independent of the workspace bridge; it
    // is detected once at connect time and tracks its own active workspace.
    runtime: detectNativeRuntime(),
    // Staged changes/commands never survive a workspace switch.
    pendingChanges: [],
    pendingCommand: null,
    runningCommand: false,
    lastCommandResult: null,
    commandError: null,
    workspacePath: bridge.rootPath,
    // Successful connection automatically enables Path capability
    pathEnabled: true,
    activeProject: null,
    panelOpen: true,
    agentLog: withLog(useWorkspaceStore.getState().agentLog, { kind: "apply", message: `Path enabled — connected to ${bridge.rootLabel}`, at: Date.now() })
  });
  const after = useWorkspaceStore.getState();
  console.debug(`[Path ${STORE_INSTANCE_ID}] initializeWorkspace completed`, { connected: after.connected, pathEnabled: after.pathEnabled, workspace: after.workspace?.name, visibleSelector: { connected: after.connected, pathEnabled: after.pathEnabled } });
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
  /** File paths from the last workspace result the user saw, in display order. */
  lastSearchResults: string[];
  /** The last file the user explicitly referenced ("the first one", "test.py"). */
  lastReferencedFile: string | null;
  /** The path of the connected workspace folder. */
  workspacePath: string | null;
  /** Staged, user-approved-before-apply agent changes (diffs shown in the UI). */
  pendingChanges: ProposedChange[];
  /** Native execution surface (window.nexussDesktop.runtime), when present. */
  runtime: NativeRuntimeBridge | null;
  /** A command staged for the user to approve before it runs. */
  pendingCommand: PendingCommand | null;
  /** True while an approved command is executing. */
  runningCommand: boolean;
  /** Structured result of the last executed command (shown in the panel). */
  lastCommandResult: CommandResult | null;
  /** Non-execution error from the last command attempt (policy/discovery). */
  commandError: string | null;
  /** Recent agent activity surfaced in the panel (reads, applies, errors). */
  agentLog: AgentLogEntry[];
  /** Last error from staging/applying a change, if any. */
  changeError: { code: string; message: string } | null;
  /** Long-running processes (dev servers etc.) */
  processes: { id: string; command: string; cwd: string; status: string; exitCode: number | null; durationMs: number }[];
  /** Incremental streaming output for the currently running command */
  streamingOutput: { stdout: string; stderr: string } | null;
  /** Path toggle — single capability for workspace + terminal */
  pathEnabled: boolean;
  /** Discovered active project within workspace (e.g. Nexuss) */
  activeProject: string | null;
  /** When true, agent loop auto-applies safe writes for autonomous demo/E2E */
  agentAutoLoop: boolean;

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
  /** Stage validated write/create proposals from a model change block. */
  proposeChangeFromBlock: (changes: ParsedChangeOp[]) => Promise<void>;
  /** Stage a run/test request from a model command block (user approves next). */
  proposeCommandFromBlock: (block: ParsedCommandBlock) => Promise<void>;
  /** Execute the approved pending command via the native runtime. */
  runPendingCommand: () => Promise<void>;
  /** Cancel a running command (terminates the native process). */
  cancelPendingCommand: () => Promise<void>;
  /** Discard a staged command without executing anything. */
  rejectPendingCommand: () => void;
  clearCommandError: () => void;
  clearLastCommandResult: () => void;
  /** Apply all pending changes after checking nothing changed since they were read. */
  approvePendingChanges: () => Promise<OperationResult>;
  /** Discard pending changes without touching the filesystem. */
  rejectPendingChanges: () => void;
  /** Re-read files and recompute diffs for stale pending changes. */
  refreshPendingChanges: () => Promise<void>;
  clearChangeError: () => void;
  clearAgentLog: () => void;
  processStart: (command: string, cwd?: string) => Promise<void>;
  processStop: (id: string) => Promise<void>;
  processList: () => Promise<void>;
  togglePath: () => void;
  setPathEnabled: (enabled: boolean) => void;
  discoverProject: (name: string) => string | null;
  setActiveProject: (project: string | null) => void;
  setAgentAutoLoop: (enabled: boolean) => void;
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
  lastSearchResults: [],
  lastReferencedFile: null,
  pendingChanges: [],
  runtime: null,
  pendingCommand: null,
  runningCommand: false,
  lastCommandResult: null,
  commandError: null,
  agentLog: [],
  changeError: null,
  processes: [],
  streamingOutput: null,
  pathEnabled: false,
  activeProject: null,
  agentAutoLoop: false,
  workspacePath: null,

  openPanel: () => {
    const cur = get();
    if (!cur.runtime) {
      try {
        const connector = createLocalConnectorRuntime() as unknown as NativeRuntimeBridge;
        set({ panelOpen: true, runtime: connector });
        return;
      } catch {}
    }
    set({ panelOpen: true });
  },

  closePanel: () => set({ panelOpen: false }),

  togglePanel: () => {
    const s = get();
    if (!s.panelOpen && !s.runtime) {
      try {
        const connector = createLocalConnectorRuntime() as unknown as NativeRuntimeBridge;
        set({ panelOpen: true, runtime: connector });
        return;
      } catch {}
    }
    set({ panelOpen: !s.panelOpen });
  },

  // Connect via the native desktop bridge when present, otherwise via the
  // browser's File System Access picker (a real user gesture). Never falls
  // back to anything that would reach outside the picked directory.
  connectLocal: async () => {
    console.debug(`[Path ${STORE_INSTANCE_ID}] connectLocal click`, { connecting: get().connecting, hasNative: !!detectNativeBridge(), hasPicker: typeof window !== "undefined" && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function" });
    if (get().connecting) return;
    set({ connecting: true, error: null, errorKind: null, status: "selecting" });
    try {
      const native = detectNativeBridge();
      console.debug(`[Path ${STORE_INSTANCE_ID}] connectLocal native bridge`, { found: !!native });
      let bridge: WorkspaceBridge;
      if (native) {
        bridge = native;
      } else {
        console.debug(`[Path ${STORE_INSTANCE_ID}] calling FileSystemAccessBridge.pick() -> showDirectoryPicker`);
        bridge = await FileSystemAccessBridge.pick();
        console.debug(`[Path ${STORE_INSTANCE_ID}] FileSystemAccessBridge.pick() succeeded`, { rootLabel: bridge.rootLabel, rootPath: bridge.rootPath });
      }
      await initializeWorkspace(bridge, native ? "native" : "fs-access");
      console.debug(`[Path ${STORE_INSTANCE_ID}] connectLocal success`, { connected: get().connected, pathEnabled: get().pathEnabled });
    } catch (e) {
      const { kind, message } = classifyError(e);
      // If already connected, preserve the connection on cancel rather than
      // disconnecting. If previously disconnected, remain disconnected.
      const alreadyConnected = get().connected;
      set({
        connecting: false,
        connected: alreadyConnected ? true : false,
        status: alreadyConnected ? "connected" : "error",
        errorKind: alreadyConnected ? null : kind,
        error: alreadyConnected ? null : message
      });
    }
  },

  connectDemo: async () => {
    set({ connecting: true, error: null, errorKind: null, status: "reading" });
    try {
      await initializeWorkspace(
        new InMemoryBridge("nexuss-sample", "nexuss-sample", DEMO_FILES),
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
      searchResults: [],
      lastSearchResults: [],
      lastReferencedFile: null,
      // Staged changes never survive a disconnect: the user must re-review.
      pendingChanges: [],
      changeError: null,
      // Execution context is invalidated on disconnect (STEP 22): the native
      // runtime is told the workspace is gone and all pending command state
      // is cleared.
      runtime: null,
      pendingCommand: null,
      runningCommand: false,
      lastCommandResult: null,
      commandError: null,
      workspacePath: null,
      pathEnabled: false,
      activeProject: null,
      agentAutoLoop: false
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

  // Token-minimized context for the CURRENT question, conversation-aware: the
  // model only ever sees the most relevant files/sections, never the whole
  // project. Workspace questions get a small dedicated context (status /
  // manifest / referenced file / retrieval). Conversation references ("the
  // first one", "it", "this code") are resolved against lightweight metadata
  // recorded from previous workspace results, and every resolution updates that
  // metadata so follow-up references keep working. Without a connected
  // workspace only explicit workspace questions get a "disconnected" note;
  // everything else stays normal chat.
  buildContextFor: (question) => {
    const {
      workspace,
      index,
      manifest,
      contextBudget,
      lastSearchResults,
      lastReferencedFile,
      pathEnabled
    } = get();

    if (!workspace) {
      const intent = classifyWorkspaceIntent(question);
      if (intent === "status" || intent === "manifest" || intent === "summary") {
        return buildDisconnectedContext();
      }
      return null;
    }
    if (!pathEnabled) return null;

    // Fast path: trivial greetings like "hi", "hello" must not trigger expensive
    // workspace search/scan. Saves ~10-50ms per simple chat and keeps "hi" minimal.
    const trimmedLower = question.trim().toLowerCase();
    if (trimmedLower.length <= 12 && /^(hi|hello|hey|hiya|yo|sup|howdy|greetings)(\s*[!?.]*)?$/.test(trimmedLower)) {
      return null;
    }

    const intent = classifyWorkspaceIntent(question);
    if (intent === "status") {
      return buildStatusContext(workspace, index);
    }
    if (intent === "manifest" || intent === "summary") {
      const result =
        manifest && manifest.files.length > 0
          ? buildManifestContext(workspace, manifest, contextBudget)
          : buildStatusContext(workspace, index);
      // The listed files become the current result set so follow-ups like
      // "open the first one" can resolve against them.
      if (result.includedFiles.length > 0) {
        set({ lastSearchResults: result.includedFiles });
      }
      return result;
    }

    const ref = resolveReference(
      question,
      { lastSearchResults, lastReferencedFile },
      index
    );

    if (ref.kind === "ambiguous") {
      return buildAmbiguityContext(workspace, ref.candidates);
    }

    if (ref.kind === "workspace-deictic") {
      const result =
        manifest && manifest.files.length > 0
          ? buildManifestContext(workspace, manifest, contextBudget)
          : buildStatusContext(workspace, index);
      if (result.includedFiles.length > 0) {
        set({ lastSearchResults: result.includedFiles });
      }
      return result;
    }

    if (
      ref.kind === "explicit-file" ||
      ref.kind === "ordinal" ||
      ref.kind === "last-referenced"
    ) {
      const path =
        ref.kind === "explicit-file"
          ? ref.path
          : ref.kind === "ordinal"
            ? lastSearchResults[ref.position - 1]
            : lastReferencedFile;
      if (path && index) {
        const result = buildFileContext(index, path, question, contextBudget);
        if (result) {
          // This is the file the user explicitly picked; later "it"/"this"
          // references resolve to it. The last result list is untouched so
          // "second one" still resolves against the original search.
          set({ lastReferencedFile: path });
          return result;
        }
      }
    }

    if (!index || index.files.length === 0 || !question.trim()) return null;
    const result = buildContextText(index, question, contextBudget);
    if (result.contextText) {
      set({ lastSearchResults: result.includedFiles });
    }
    return result.contextText ? result : null;
  },

  // Safe file operations: paths are validated against the workspace root
  // BEFORE touching the bridge; the index is refreshed so the next request
  // reflects the change.
  applyOperation: async (op) => {
    const { bridge, index, pathEnabled } = get();
    if (!pathEnabled) return { ok: false, error: "Terminal is not connected — connect workspace to perform file operations." };
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
        case "mkdir":
          assertInsideRoot("", op.path);
          await bridge.mkdir(op.path);
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
  },

  // Workspace Agent: everything a change does is staged as a diff, validated
  // against the workspace boundary, and only applied after the user approves.
  // Writes/creates/deletes/renames all flow through applyOperation, which
  // re-validates the path and refreshes the index on success.
  proposeChangeFromBlock: async (changes) => {
    const { connected, pathEnabled } = get();
    if (!connected) return;
    if (!pathEnabled) {
      set((s) => ({ changeError: { code: "PATH_DISABLED", message: "Terminal is not connected — connect workspace to allow file edits." }, agentLog: withLog(s.agentLog, { kind: "error", message: "Blocked file edit: terminal not connected", at: Date.now() }) }));
      return;
    }
    const proposals: ProposedChange[] = [];
    const errors: string[] = [];
    for (const op of changes) {
      try {
        proposals.push(await toolProposeUpsert(get(), op.path, op.content));
      } catch (e) {
        const { message } = unwrapError(e);
        errors.push(`${op.path}: ${message}`);
      }
    }
    const log: AgentLogEntry[] = [];
    if (proposals.length > 0) {
      log.push({
        kind: "propose",
        message: `Staged ${proposals.length} change${proposals.length === 1 ? "" : "s"} for review.`,
        at: Date.now()
      });
    }
    if (errors.length > 0) {
      log.push({ kind: "error", message: errors.join("; "), at: Date.now() });
    }
    set((s) => ({
      pendingChanges: proposals.length > 0 ? proposals : s.pendingChanges,
      changeError: errors.length > 0 ? { code: "INVALID_INPUT", message: errors.join("; ") } : null,
      agentLog: withLog(s.agentLog, ...log)
    }));
  },

  approvePendingChanges: async () => {
    const { bridge, pendingChanges, agentLog } = get();
    if (!bridge || pendingChanges.length === 0) {
      return { ok: false, error: "Nothing to apply." };
    }
    const applied: string[] = [];
    for (const change of pendingChanges) {
      try {
        const path = normalizeRelativePath(change.path);
        // Version/conflict protection: never overwrite a file that changed
        // after it was read, and never create over an existing file.
        if (change.kind === "write") {
          let current: string;
          try {
            current = await bridge.read(path);
          } catch {
            set({
              changeError: { code: "FILE_NOT_FOUND", message: `"${change.path}" no longer exists.` }
            });
            return { ok: false, error: `"${change.path}" no longer exists.` };
          }
          if (change.originalHash && contentHash(current) !== change.originalHash) {
            set({
              changeError: {
                code: "FILE_CHANGED",
                message: `"${change.path}" changed after it was read. Reload the file before applying this change.`
              }
            });
            return { ok: false, error: `"${change.path}" changed after it was read.` };
          }
          const r = await get().applyOperation({ type: "write", path, content: change.after });
          if (!r.ok) throw new Error(r.error ?? "Write failed.");
        } else if (change.kind === "create") {
          let exists = false;
          try {
            await bridge.read(path);
            exists = true;
          } catch {
            // File is still missing; safe to create.
          }
          if (exists) {
            set({ changeError: { code: "FILE_EXISTS", message: `"${change.path}" already exists.` } });
            return { ok: false, error: `"${change.path}" already exists.` };
          }
          const r = await get().applyOperation({ type: "create", path, content: change.after });
          if (!r.ok) throw new Error(r.error ?? "Create failed.");
        } else if (change.kind === "delete") {
          let current: string;
          try {
            current = await bridge.read(path);
          } catch {
            set({
              changeError: { code: "FILE_NOT_FOUND", message: `"${change.path}" no longer exists.` }
            });
            return { ok: false, error: `"${change.path}" no longer exists.` };
          }
          if (change.originalHash && contentHash(current) !== change.originalHash) {
            set({
              changeError: {
                code: "FILE_CHANGED",
                message: `"${change.path}" changed after it was read. Reload the file before applying this change.`
              }
            });
            return { ok: false, error: `"${change.path}" changed after it was read.` };
          }
          const r = await get().applyOperation({ type: "delete", path });
          if (!r.ok) throw new Error(r.error ?? "Delete failed.");
        } else if (change.kind === "rename" || change.kind === "move") {
          if (!change.toPath) throw new Error("Missing target path.");
          const to = normalizeRelativePath(change.toPath);
          const r = await get().applyOperation({ type: "rename", from: path, to });
          if (!r.ok) throw new Error(r.error ?? "Rename failed.");
        } else if (change.kind === "mkdir") {
          const r = await get().applyOperation({ type: "mkdir", path });
          if (!r.ok) throw new Error(r.error ?? "Mkdir failed.");
        }
        applied.push(change.path);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set({
          changeError: { code: "INVALID_INPUT", message },
          agentLog: withLog(agentLog, { kind: "error", message, at: Date.now() })
        });
        return { ok: false, error: message };
      }
    }
    set({
      pendingChanges: [],
      changeError: null,
      agentLog: withLog(agentLog, {
        kind: "apply",
        message: `Applied ${applied.length} change${applied.length === 1 ? "" : "s"}: ${applied.join(", ")}`,
        at: Date.now()
      })
    });
    return { ok: true };
  },

  rejectPendingChanges: () => {
    const { pendingChanges, agentLog } = get();
    if (pendingChanges.length === 0) return;
    set({
      pendingChanges: [],
      changeError: null,
      agentLog: withLog(agentLog, {
        kind: "reject",
        message: `Discarded ${pendingChanges.length} proposed change${pendingChanges.length === 1 ? "" : "s"}.`,
        at: Date.now()
      })
    });
  },

  refreshPendingChanges: async () => {
    const { pendingChanges } = get();
    if (pendingChanges.length === 0) return;
    const refreshed: ProposedChange[] = [];
    for (const change of pendingChanges) {
      try {
        if (change.kind === "write" || change.kind === "create") {
          refreshed.push(await toolProposeUpsert(get(), change.path, change.after));
        } else if (change.kind === "delete") {
          refreshed.push(await toolProposeDelete(get(), change.path));
        } else if (change.kind === "rename" || change.kind === "move") {
          if (!change.toPath) continue;
          refreshed.push(await toolProposeMove(get(), change.path, change.toPath, change.kind));
        }
      } catch {
        // A file that moved or disappeared is simply dropped from the refresh.
      }
    }
    set({ pendingChanges: refreshed, changeError: null });
  },

  clearChangeError: () => set({ changeError: null }),

  clearAgentLog: () => set({ agentLog: [] }),

  // --- Native command execution (run/test) ----------------------------------

  proposeCommandFromBlock: async (block) => {
    const { runtime, agentLog } = get();
    if (!runtime) {
      set({
        commandError: "Command execution requires the Nexuss desktop runtime.",
        agentLog: withLog(agentLog, {
          kind: "error",
          message: "Run/test requires the Nexuss desktop runtime.",
          at: Date.now()
        })
      });
      return;
    }
    const caps = runtime.capabilities();
    if (block.run) {
      if (!caps.run) {
        set({
          commandError: "Command execution is not available in this runtime.",
          agentLog: withLog(agentLog, {
            kind: "error",
            message: "Run is not available in this runtime.",
            at: Date.now()
          })
        });
        return;
      }
      set({
        pendingCommand: {
          id: newCommandId(),
          kind: "run",
          command: block.run.command,
          cwd: block.run.cwd ?? "",
          plan: null,
          createdAt: Date.now()
        },
        commandError: null,
        lastCommandResult: null
      });
    } else if (block.test) {
      if (!caps.test) {
        set({
          commandError: "Test execution is not available in this runtime.",
          agentLog: withLog(agentLog, {
            kind: "error",
            message: "Test is not available in this runtime.",
            at: Date.now()
          })
        });
        return;
      }
      set({
        pendingCommand: {
          id: newCommandId(),
          kind: "test",
          command: "(auto-discovered)",
          cwd: block.test.cwd ?? "",
          plan: null,
          createdAt: Date.now()
        },
        commandError: null,
        lastCommandResult: null
      });
    }
  },

  runPendingCommand: async () => {
    const { pendingCommand, runtime } = get();
    if (!pendingCommand || !runtime) return;
    if (get().runningCommand) return;
    const { kind, command, cwd } = pendingCommand;
    set({ runningCommand: true, commandError: null, lastCommandResult: null });
    try {
      const result =
        kind === "run"
          ? await toolRun(get(), command, { cwd: cwd || undefined })
          : await toolTest(get(), { cwd: cwd || undefined });
      set({
        lastCommandResult: result,
        pendingCommand: null,
        runningCommand: false,
        agentLog: withLog(get().agentLog, {
          kind: kind === "run" ? "run" : "test",
          message: result.success
            ? `${command}: completed in ${(result.durationMs / 1000).toFixed(1)}s`
            : `${command}: ${result.timedOut ? "timed out" : `exit ${result.exitCode ?? "n/a"}`}`,
          at: Date.now()
        })
      });
    } catch (e) {
      const { message } = unwrapError(e);
      set({
        commandError: message,
        runningCommand: false,
        pendingCommand: null,
        agentLog: withLog(get().agentLog, {
          kind: "error",
          message,
          at: Date.now()
        })
      });
    }
  },

  cancelPendingCommand: async () => {
    const { runtime } = get();
    if (!get().runningCommand) {
      set({ pendingCommand: null });
      return;
    }
    runtime?.cancel?.();
    set({
      runningCommand: false,
      pendingCommand: null,
      commandError: null,
      agentLog: withLog(get().agentLog, {
        kind: "reject",
        message: "Command cancelled.",
        at: Date.now()
      })
    });
  },

  rejectPendingCommand: () => {
    const { pendingCommand, agentLog } = get();
    if (!pendingCommand) return;
    set({
      pendingCommand: null,
      commandError: null,
      agentLog: withLog(agentLog, {
        kind: "reject",
        message: `Discarded pending ${pendingCommand.kind} command: ${pendingCommand.command}.`,
        at: Date.now()
      })
    });
  },

  clearCommandError: () => set({ commandError: null }),

  clearLastCommandResult: () => set({ lastCommandResult: null }),

  processStart: async (command, cwd) => {
    const { runtime } = get();
    if (!runtime?.processStart) {
      set({ commandError: "Long-running processes require the desktop runtime." });
      return;
    }
    try {
      const info = await runtime.processStart!({ command, cwd: cwd || "" });
      set((s) => ({ processes: [...s.processes, { id: info.id, command: info.command, cwd: info.cwd, status: info.status, exitCode: info.exitCode, durationMs: 0 }], agentLog: withLog(s.agentLog, { kind: "run", message: `Started ${command} (${info.id})`, at: Date.now() }) }));
    } catch (e) {
      set({ commandError: e instanceof Error ? e.message : String(e) });
    }
  },

  processStop: async (id) => {
    const { runtime } = get();
    if (!runtime?.processStop) return;
    try {
      await runtime.processStop!(id);
      set((s) => ({ processes: s.processes.map((p) => p.id === id ? { ...p, status: "killed" } : p) }));
    } catch (e) {
      set({ commandError: e instanceof Error ? e.message : String(e) });
    }
  },

  processList: async () => {
    const { runtime } = get();
    if (!runtime?.processList) return;
    try {
      const list = await runtime.processList!();
      set({ processes: list.map((p) => ({ id: p.id, command: p.command, cwd: (p as unknown as { cwd: string }).cwd || "", status: p.status, exitCode: (p as unknown as { exitCode: number | null }).exitCode ?? null, durationMs: (p as unknown as { durationMs: number }).durationMs ?? 0 })) });
    } catch {}
  },

  togglePath: () => {
    const enabled = !get().pathEnabled;
    get().setPathEnabled(enabled);
  },

  setPathEnabled: (enabled) => {
    if (!enabled) {
      // Disable: cancel any staged commands, clear capability, keep workspace for session but block tools
      const { runtime, processes } = get();
      // Do not kill unrelated user processes abruptly; just clear agent-owned pending state
      if (runtime?.cancel) {
        try { runtime.cancel(); } catch {}
      }
      set({
        pathEnabled: false,
        activeProject: null,
        pendingCommand: null,
        runningCommand: false,
        processes: processes.map((p) => p.status === "running" ? { ...p, status: "killed" } : p),
        agentLog: withLog(get().agentLog, { kind: "reject", message: "Path disabled — workspace access revoked.", at: Date.now() })
      });
    } else {
      set({
        pathEnabled: true,
        agentLog: withLog(get().agentLog, { kind: "apply", message: "Path enabled — agent workspace access granted.", at: Date.now() })
      });
      // Auto-open panel to show authorized workspace
      set({ panelOpen: true });
    }
  },

  discoverProject: (name) => {
    const { index } = get();
    if (!index) return null;
    const lower = name.toLowerCase();
    // Find directory that matches project name
    const dirs = new Set<string>();
    for (const f of index.files) {
      const dir = f.dir;
      if (dir) dirs.add(dir.split("/")[0]);
      if (f.path.toLowerCase().includes(lower)) {
        const top = f.path.split("/")[0].toLowerCase();
        if (top === lower) {
          set({ activeProject: f.path.split("/")[0] });
          return f.path.split("/")[0];
        }
      }
    }
    for (const d of dirs) {
      if (d.toLowerCase() === lower) {
        set({ activeProject: d });
        return d;
      }
    }
    // Heuristic: look for marker files
    for (const d of dirs) {
      const hasMarker = index.files.some((f) => f.dir === d && ["package.json","pyproject.toml","Cargo.toml","go.mod",".git"].includes(f.name));
      if (hasMarker && d.toLowerCase().includes(lower.slice(0,3))) {
        set({ activeProject: d });
        return d;
      }
    }
    return null;
  },

  setActiveProject: (project) => set({ activeProject: project }),

  setAgentAutoLoop: (enabled) => set({ agentAutoLoop: enabled })
}));