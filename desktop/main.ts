// Nexuss desktop host (Electron main process).
//
// Responsibilities:
//   - own the ONE NativeRuntime instance (native/runtime.ts) — the only code
//     that ever spawns processes;
//   - own the workspace file service (real disk, boundary-checked);
//   - serve those over specific, whitelisted IPC channels;
//   - start/connect to the Next.js frontend and host it in a hardened window;
//   - clean up every process on shutdown.
//
// The renderer never spawns anything: it only ever sees the preload whitelist.

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { createNativeRuntime } from "../native/runtime";
import { createRuntimeHandlers } from "./runtime-ipc";
import { createWorkspaceService } from "./workspace-service";
import { RUNTIME_CHANNELS, WORKSPACE_CHANNELS, OLLAMA_CHANNELS } from "./types";
import { handleOllamaTest, handleOllamaChat } from "./ollama-service";

const isProd = app.isPackaged || process.env.NEXUSS_MODE === "prod";
const appRoot = app.getAppPath();
const PRELOAD = path.join(__dirname, "preload.js");

let mainWindow: BrowserWindow | null = null;
let nextProcess: ChildProcess | null = null;

// ---------------------------------------------------------------------------
// Next.js server lifecycle
// ---------------------------------------------------------------------------

async function startNextServer(): Promise<{ url: string }> {
  const existingUrl = process.env.NEXUSS_URL;
  if (existingUrl) return { url: existingUrl };

  const port = Number(process.env.NEXUSS_PORT ?? 3000);
  const url = `http://127.0.0.1:${port}`;
  const nextBin = require.resolve("next/dist/bin/next");
  const args = isProd
    ? ["start", "-p", String(port)]
    : ["dev", "-p", String(port)];

  nextProcess = spawn(process.execPath, [nextBin, ...args], {
    cwd: appRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  nextProcess.stdout?.on("data", (d) => console.log(`[next] ${String(d).trimEnd()}`));
  nextProcess.stderr?.on("data", (d) => console.error(`[next] ${String(d).trimEnd()}`));

  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (nextProcess.exitCode !== null) {
      throw new Error(
        `Next.js exited before becoming ready (code ${nextProcess.exitCode}).`
      );
    }
    try {
      const res = await fetch(url);
      if (res.ok) return { url };
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Next.js did not become ready in time.");
}

function stopNextServer(): void {
  if (nextProcess && nextProcess.exitCode === null) {
    nextProcess.kill();
  }
  nextProcess = null;
}

// ---------------------------------------------------------------------------
// IPC surface
// ---------------------------------------------------------------------------

function registerIpc(): void {
  const runtime = createNativeRuntime();
  const runtimeHandlers = createRuntimeHandlers(runtime);

  const workspace = createWorkspaceService({
    picker: {
      pick: async () => {
        if (!mainWindow) return { picked: false };
        const result = await dialog.showOpenDialog(mainWindow, {
          title: "Connect a folder",
          properties: ["openDirectory"]
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { picked: false };
        }
        return { picked: true, root: result.filePaths[0] };
      }
    },
    onWorkspaceChange: (root) => runtime.setWorkspace(root)
  });

  ipcMain.handle(RUNTIME_CHANNELS.run, (_e, req) => runtimeHandlers.run(req));
  ipcMain.handle(RUNTIME_CHANNELS.test, (_e, req) => runtimeHandlers.test(req));
  ipcMain.handle(RUNTIME_CHANNELS.capabilities, () => runtimeHandlers.capabilities());
  ipcMain.handle(RUNTIME_CHANNELS.cancel, () => runtimeHandlers.cancel());

  ipcMain.handle(WORKSPACE_CHANNELS.list, () => workspace.list());
  ipcMain.handle(WORKSPACE_CHANNELS.read, (_e, p) => workspace.read(p));
  ipcMain.handle(WORKSPACE_CHANNELS.create, (_e, payload) =>
    workspace.create(payload.path, payload.content)
  );
  ipcMain.handle(WORKSPACE_CHANNELS.write, (_e, payload) =>
    workspace.write(payload.path, payload.content)
  );
  ipcMain.handle(WORKSPACE_CHANNELS.delete, (_e, p) => workspace.delete(p));
  ipcMain.handle(WORKSPACE_CHANNELS.rename, (_e, payload) =>
    workspace.rename(payload.from, payload.to)
  );
  ipcMain.handle(WORKSPACE_CHANNELS.close, () => workspace.close());

  // Ollama local gateway: main-process fetch for http://localhost:11434 (no CORS/mixed-content)
  ipcMain.handle(OLLAMA_CHANNELS.test, (_e, req) => handleOllamaTest(req as { endpoint: string; apiKey?: string }));
  ipcMain.handle(OLLAMA_CHANNELS.chat, (_e, req) => handleOllamaChat(req as { endpoint: string; modelId: string; messages: { role: string; content: string }[]; apiKey?: string }));
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    title: "Nexuss",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  // Never open new windows (no window.open escapes to a Node context).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(url);
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  stopNextServer();
});

app.whenReady().then(async () => {
  registerIpc();
  try {
    const { url } = await startNextServer();
    createWindow(url);
  } catch (e) {
    stopNextServer();
    dialog.showErrorBox(
      "Nexuss failed to start",
      e instanceof Error ? e.message : String(e)
    );
    app.quit();
  }
});