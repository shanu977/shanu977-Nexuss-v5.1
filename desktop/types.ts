// Desktop host contracts: the IPC channels and serializable payloads that
// cross the secure preload bridge. This is the ONLY place channel names are
// declared, so renderer and host can never drift.

export const RUNTIME_CHANNELS = {
  run: "nexuss:runtime:run",
  test: "nexuss:runtime:test",
  capabilities: "nexuss:runtime:capabilities",
  cancel: "nexuss:runtime:cancel",
  processStart: "nexuss:runtime:processStart",
  processStatus: "nexuss:runtime:processStatus",
  processOutput: "nexuss:runtime:processOutput",
  processStop: "nexuss:runtime:processStop",
  processList: "nexuss:runtime:processList"
} as const;

export const OLLAMA_CHANNELS = {
  test: "nexuss:ollama:test",
  chat: "nexuss:ollama:chat",
  state: "nexuss:ollama:state",
  ensureRunning: "nexuss:ollama:ensure-running",
  discoverModels: "nexuss:ollama:discover-models",
  recommendModel: "nexuss:ollama:recommend-model",
  pullModel: "nexuss:ollama:pull-model",
  pullProgress: "nexuss:ollama:pull-progress"
} as const;

export const WORKSPACE_CHANNELS = {
  list: "nexuss:workspace:list",
  read: "nexuss:workspace:read",
  create: "nexuss:workspace:create",
  write: "nexuss:workspace:write",
  delete: "nexuss:workspace:delete",
  rename: "nexuss:workspace:rename",
  mkdir: "nexuss:workspace:mkdir",
  close: "nexuss:workspace:close"
} as const;

export interface WorkspaceFileSource {
  path: string;
  size: number;
  mtime: number;
}

/** Full result of a workspace listing, including the discovered folder label. */
export interface WorkspaceSnapshot {
  rootLabel: string;
  lastScan: { entries: number; files: number };
  files: WorkspaceFileSource[];
}

export interface CreateFilePayload {
  path: string;
  content: string;
}

export interface WriteFilePayload {
  path: string;
  content: string;
}

export interface RenameFilePayload {
  from: string;
  to: string;
}




