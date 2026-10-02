// The preload bridge surface: builds the exact object the Nexuss frontend
// expects on window.nexussDesktop. Only this whitelist crosses the boundary;
// the renderer never receives Node.js or IPC primitives. Pure (the `invoke`
// function is injected) so it is unit-testable without Electron.
//
// The runtime's `capabilities()` must be synchronous (the store reads it during
// propose/run/test), so the bridge keeps a capability snapshot refreshed from
// the host whenever the workspace connects or disconnects. Before any folder is
// connected the snapshot reports run/test = false, exactly like a browser.

import type {
  NativeCapabilities,
  NativeCommandResult,
  NativeTestResult
} from "../native/types";
import {
  OLLAMA_CHANNELS,
  RUNTIME_CHANNELS,
  WORKSPACE_CHANNELS
} from "./types";
import type { WorkspaceSnapshot } from "./types";

export interface FileSourceLike {
  path: string;
  size: number;
  mtime: number;
}

export type InvokeFn = (
  channel: string,
  payload?: unknown
) => Promise<unknown>;

export type OnFn = (
  channel: string,
  callback: (payload: unknown) => void
) => () => void;

const NO_CAPABILITIES: NativeCapabilities = {
  read: false,
  search: false,
  write: false,
  create: false,
  rename: false,
  move: false,
  delete: false,
  run: false,
  test: false
};

export interface NexussDesktopApi {
  workspace: {
    readonly kind: "native";
    rootLabel: string;
    lastScan?: { entries: number; files: number };
    list(): Promise<FileSourceLike[]>;
    read(path: string): Promise<string>;
    create(path: string, content: string): Promise<void>;
    write(path: string, content: string): Promise<void>;
    delete(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    close(): Promise<void>;
  };

  runtime: {
    run(req: {
      command: string;
      cwd?: string;
      timeoutMs?: number;
      maxStdoutBytes?: number;
      maxStderrBytes?: number;
    }): Promise<NativeCommandResult>;

    test(req: {
      cwd?: string;
      timeoutMs?: number;
    }): Promise<NativeTestResult>;

    capabilities(): NativeCapabilities;
    cancel(): Promise<void>;
  };

  ollama: {
    test(req: {
      endpoint: string;
      apiKey?: string;
    }): Promise<{
      ok: boolean;
      message: string;
      models?: string[];
      endpointReachable: boolean;
      modelsDiscoverable: boolean;
    }>;

    chat(req: {
      endpoint: string;
      modelId: string;
      messages: {
        role: string;
        content: string;
      }[];
      apiKey?: string;
    }): Promise<{ content: string }>;

    state(): Promise<{
      status:
        | "checking"
        | "not_installed"
        | "starting"
        | "running"
        | "error";
      message: string;
      installed: boolean;
      running: boolean;
      version?: string;
      endpoint: string;
      models?: {
        name: string;
        size?: number;
        modifiedAt?: string;
        family?: string;
        parameterSize?: string;
        quantization?: string;
      }[];
    }>;

    ensureRunning(): Promise<{
      status:
        | "checking"
        | "not_installed"
        | "starting"
        | "running"
        | "error";
      message: string;
      installed: boolean;
      running: boolean;
      version?: string;
      endpoint: string;
      models?: {
        name: string;
        size?: number;
        modifiedAt?: string;
        family?: string;
        parameterSize?: string;
        quantization?: string;
      }[];
    }>;

    discoverModels(): Promise<
      {
        name: string;
        size?: number;
        modifiedAt?: string;
        family?: string;
        parameterSize?: string;
        quantization?: string;
      }[]
    >;

    recommendModel(): Promise<{
      system: unknown;
      recommendations: {
        model: string;
        reason: string;
        suitable: boolean;
      }[];
    }>;

    pullModel(model: string): Promise<{
      name: string;
      size?: number;
      modifiedAt?: string;
      family?: string;
      parameterSize?: string;
      quantization?: string;
    }>;

onPullProgress(
  callback: (progress: {
    model: string;
    status: string;
    completed?: number;
    total?: number;
    percent?: number;
  }) => void
): () => void;

  };
}
    
export function createDesktopApi(
  invoke: InvokeFn,
  on: OnFn
): NexussDesktopApi {
  let capabilities: NativeCapabilities = {
    ...NO_CAPABILITIES
  };

  async function refreshCapabilities(): Promise<void> {
    try {
      capabilities = (await invoke(
        RUNTIME_CHANNELS.capabilities
      )) as NativeCapabilities;
    } catch {
      capabilities = {
        ...NO_CAPABILITIES
      };
    }
  }

  const workspaceState: {
    rootLabel: string;
    lastScan?: {
      entries: number;
      files: number;
    };
  } = {
    rootLabel: ""
  };

  return {
    workspace: {
      kind: "native",

      get rootLabel() {
        return workspaceState.rootLabel;
      },

      get lastScan() {
        return workspaceState.lastScan;
      },

      list: async () => {
        const snapshot = (await invoke(
          WORKSPACE_CHANNELS.list
        )) as WorkspaceSnapshot;

        workspaceState.rootLabel = snapshot.rootLabel;
        workspaceState.lastScan = snapshot.lastScan;

        await refreshCapabilities();

        return snapshot.files;
      },

      read: (p) =>
        invoke(
          WORKSPACE_CHANNELS.read,
          p
        ) as Promise<string>,

      create: (p, c) =>
        invoke(
          WORKSPACE_CHANNELS.create,
          {
            path: p,
            content: c
          }
        ) as Promise<void>,

      write: (p, c) =>
        invoke(
          WORKSPACE_CHANNELS.write,
          {
            path: p,
            content: c
          }
        ) as Promise<void>,

      delete: (p) =>
        invoke(
          WORKSPACE_CHANNELS.delete,
          p
        ) as Promise<void>,

      rename: (from, to) =>
        invoke(
          WORKSPACE_CHANNELS.rename,
          {
            from,
            to
          }
        ) as Promise<void>,

      close: async () => {
        await invoke(WORKSPACE_CHANNELS.close);

        workspaceState.rootLabel = "";
        workspaceState.lastScan = undefined;

        capabilities = {
          ...NO_CAPABILITIES
        };
      }
    },

    runtime: {
      run: (req) =>
        invoke(
          RUNTIME_CHANNELS.run,
          req
        ) as Promise<NativeCommandResult>,

      test: (req) =>
        invoke(
          RUNTIME_CHANNELS.test,
          req
        ) as Promise<NativeTestResult>,

      capabilities: () => capabilities,

      cancel: () =>
        invoke(
          RUNTIME_CHANNELS.cancel
        ) as Promise<void>
    },

    ollama: {
      test: (req) =>
        invoke(
          OLLAMA_CHANNELS.test,
          req
        ) as Promise<{
          ok: boolean;
          message: string;
          models?: string[];
          endpointReachable: boolean;
          modelsDiscoverable: boolean;
        }>,

      chat: (req) =>
        invoke(
          OLLAMA_CHANNELS.chat,
          req
        ) as Promise<{ content: string }>,

      state: () =>
        invoke(
          OLLAMA_CHANNELS.state
        ) as Promise<{
          status:
            | "checking"
            | "not_installed"
            | "starting"
            | "running"
            | "error";
          message: string;
          installed: boolean;
          running: boolean;
          version?: string;
          endpoint: string;
          models?: {
            name: string;
            size?: number;
            modifiedAt?: string;
            family?: string;
            parameterSize?: string;
            quantization?: string;
          }[];
        }>,

      ensureRunning: () =>
        invoke(
          OLLAMA_CHANNELS.ensureRunning
        ) as Promise<{
          status:
            | "checking"
            | "not_installed"
            | "starting"
            | "running"
            | "error";
          message: string;
          installed: boolean;
          running: boolean;
          version?: string;
          endpoint: string;
          models?: {
            name: string;
            size?: number;
            modifiedAt?: string;
            family?: string;
            parameterSize?: string;
            quantization?: string;
          }[];
        }>,

      discoverModels: () =>
        invoke(
          OLLAMA_CHANNELS.discoverModels
        ) as Promise<
          {
            name: string;
            size?: number;
            modifiedAt?: string;
            family?: string;
            parameterSize?: string;
            quantization?: string;
          }[]
        >,

      recommendModel: () =>
        invoke(
          OLLAMA_CHANNELS.recommendModel
        ) as Promise<{
          system: unknown;
          recommendations: {
            model: string;
            reason: string;
            suitable: boolean;
          }[];
        }>,

      pullModel: (model: string) =>
        invoke(
          OLLAMA_CHANNELS.pullModel,
          model
        ) as Promise<{
          name: string;
          size?: number;
          modifiedAt?: string;
          family?: string;
          parameterSize?: string;
          quantization?: string;
        }>,

      onPullProgress: (callback) => {
        return on(
          OLLAMA_CHANNELS.pullProgress,
          (payload) => {
            callback(
              payload as {
                model: string;
                status: string;
                completed?: number;
                total?: number;
                percent?: number;
              }
            );
          }
        );
      }
    }
  };
}