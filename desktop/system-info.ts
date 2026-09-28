import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SystemInfo {
  platform: NodeJS.Platform;
  platformVersion: string;
  architecture: string;

  cpu: {
    model: string;
    cores: number;
    logicalCores: number;
  };

  memory: {
    totalBytes: number;
    freeBytes: number;
    totalGB: number;
    freeGB: number;
  };

  storage: {
    path: string;
    totalBytes?: number;
    freeBytes?: number;
    totalGB?: number;
    freeGB?: number;
  };

  gpu?: string[];
}

function bytesToGB(bytes: number): number {
  return Number((bytes / 1024 ** 3).toFixed(2));
}

async function getWindowsGpuInfo(): Promise<string[] | undefined> {
  if (process.platform !== "win32") {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"
      ],
      {
        timeout: 5000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      }
    );

    const gpus = stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);

    return gpus.length > 0 ? gpus : undefined;
  } catch {
    return undefined;
  }
}

async function getStorageInfo(): Promise<SystemInfo["storage"]> {
  const targetPath = path.parse(process.cwd()).root || process.cwd();

  if (process.platform === "win32") {
    try {
      const drive = targetPath.replace(/\\/g, "");

      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'"; if ($d) { "$($d.Size)|$($d.FreeSpace)" }`
        ],
        {
          timeout: 5000,
          windowsHide: true
        }
      );

      const [total, free] = stdout.trim().split("|").map(Number);

      if (Number.isFinite(total) && Number.isFinite(free)) {
        return {
          path: targetPath,
          totalBytes: total,
          freeBytes: free,
          totalGB: bytesToGB(total),
          freeGB: bytesToGB(free)
        };
      }
    } catch {
      // Return the path even if storage information cannot be read.
    }
  }

  return {
    path: targetPath
  };
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const cpus = os.cpus();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();

  const [storage, gpu] = await Promise.all([
    getStorageInfo(),
    getWindowsGpuInfo()
  ]);

  return {
    platform: process.platform,
    platformVersion: os.release(),
    architecture: process.arch,

    cpu: {
      model: cpus[0]?.model ?? "Unknown CPU",
      cores: cpus.length,
      logicalCores: cpus.length
    },

    memory: {
      totalBytes: totalMemory,
      freeBytes: freeMemory,
      totalGB: bytesToGB(totalMemory),
      freeGB: bytesToGB(freeMemory)
    },

    storage,

    gpu
  };
}