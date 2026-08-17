// Desktop host contracts: the IPC channels and serializable payloads that
// cross the secure preload bridge. This is the ONLY place channel names are
// declared, so renderer and host can never drift.

export const RUNTIME_CHANNELS = {
  run: "nexuss:runtime:run",
  test: "nexuss:runtime:test",
  capabilities: "nexuss:runtime:capabilities",
  cancel: "nexuss:runtime:cancel"
} as const;

export const WORKSPACE_CHANNELS = {
  list: "nexuss:workspace:list",
  read: "nexuss:workspace:read",
  create: "nexuss:workspace:create",
  write: "nexuss:workspace:write",
  delete: "nexuss:workspace:delete",
  rename: "nexuss:workspace:rename",
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