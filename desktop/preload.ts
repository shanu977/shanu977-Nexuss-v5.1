// Electron preload: the ONLY code that crosses the renderer/host boundary.
//
// The renderer gets exactly one object — window.nexussDesktop — containing the
// workspace bridge and the runtime bridge. Each method maps to a specific,
// whitelisted IPC channel. No Node.js objects (require/process/fs/child_process)
// and no ipcRenderer are ever exposed to the page. contextIsolation + sandbox
// are enforced in main.ts.

import { contextBridge, ipcRenderer } from "electron";
import { createDesktopApi } from "./ipc-bridge";

const api = createDesktopApi((channel, payload) =>
  ipcRenderer.invoke(channel, payload)
);

contextBridge.exposeInMainWorld("nexussDesktop", api);