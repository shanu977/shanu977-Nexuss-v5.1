// Long-running process manager for the Nexuss native runtime.
//
// Provides the `process.start / status / output / stop / list` surface
// required for dev servers (npm run dev, uvicorn, etc.) that must remain
// alive, stream output, and be stopped/restarted by the agent or user.
//
// Unlike `runCommand` (one-shot, buffered until close), a managed process:
//   - lives until explicitly stopped or it exits on its own
//   - emits stdout/stderr incrementally via an onChunk callback (for IPC streaming)
//   - keeps ring buffers so UI can poll output after the fact
//   - is tracked in a registry so multiple processes can coexist.

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { NativeError } from "./errors";
import { validateCommand, tokenizeCommand } from "./policy";
import { assertCwdInsideRoot } from "./boundary";
import { buildScrubbedEnv, collectSensitiveEnvValues, redactOutput } from "./redact";
import { DEFAULT_MAX_OUTPUT_BYTES, KILL_GRACE_MS } from "./types";

export interface ProcessStartRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number | null; // null = no timeout (long-running)
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface ProcessInfo {
  id: string;
  command: string;
  cwd: string;
  pid?: number;
  startedAt: number;
  status: "running" | "exited" | "killed" | "timedout";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  outputTruncated: boolean;
}

export interface ProcessOutputChunk {
  stream: "stdout" | "stderr";
  text: string;
  truncated: boolean;
}

function newProcessId(): string {
  return `proc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function clampOutput(bytes: number | undefined): number {
  if (bytes === undefined) return DEFAULT_MAX_OUTPUT_BYTES;
  return Math.min(4 * 1024 * 1024, Math.max(1024, Math.floor(bytes)));
}

function killTree(child: ChildProcessWithoutNullStreams, force: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const args = force ? ["/pid", String(pid), "/t", "/f"] : ["/pid", String(pid), "/t"];
    const killer = spawn("taskkill", args, { windowsHide: true, stdio: "ignore" });
    killer.unref();
  } else {
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    } catch {}
  }
}

interface ManagedProcess {
  id: string;
  command: string;
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  status: ProcessInfo["status"];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  sensitive: string[];
  onChunk?: (chunk: ProcessOutputChunk) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function createProcessManager(opts: {
  onChunk?: (id: string, chunk: ProcessOutputChunk) => void;
} = {}) {
  const procs = new Map<string, ManagedProcess>();

  function list(): ProcessInfo[] {
    return [...procs.values()].map(toInfo);
  }

  function toInfo(p: ManagedProcess): ProcessInfo {
    return {
      id: p.id,
      command: p.command,
      cwd: p.cwd,
      pid: p.child.pid,
      startedAt: p.startedAt,
      status: p.status,
      exitCode: p.exitCode,
      signal: p.signal,
      durationMs: Date.now() - p.startedAt,
      outputTruncated: p.stdoutTruncated || p.stderrTruncated
    };
  }

  async function start(
    req: ProcessStartRequest,
    execOpts: { cwd: string; workspaceRoot: string; allowedExact?: string[] }
  ): Promise<ProcessInfo> {
    const command = req.command.trim();
    if (!command) throw new NativeError("COMMAND_NOT_ALLOWED", "Command is empty.");
    const validated = validateCommand(command, {
      cwd: execOpts.cwd,
      workspaceRoot: execOpts.workspaceRoot,
      allowedExact: execOpts.allowedExact
    });
    const maxStdout = clampOutput(req.maxStdoutBytes);
    const maxStderr = clampOutput(req.maxStderrBytes);
    const env = buildScrubbedEnv(process.env) as NodeJS.ProcessEnv;
    const sensitive = collectSensitiveEnvValues(process.env);

    const common = {
      cwd: execOpts.cwd,
      env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32"
    } as const;

    let child: ChildProcessWithoutNullStreams;
    try {
      const first = spawn(validated.argv[0], validated.argv.slice(1), common);
      await new Promise<void>((resolve, reject) => {
        let done = false;
        first.once("spawn", () => { done = true; resolve(); });
        first.once("error", (err) => {
          if (done) return;
          const e = err as NodeJS.ErrnoException;
          if (process.platform === "win32" && (e.code === "ENOENT" || e.code === "EACCES")) {
            const wrapped = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", validated.command], common);
            wrapped.once("spawn", () => { done = true; child = wrapped; resolve(); });
            wrapped.once("error", (werr) => { if (!done) { done = true; reject(werr); } });
            // Replace first with wrapped for further handling
            (first as unknown as { pid?: number }).pid = wrapped.pid;
          } else reject(err);
        });
        if (!child) child = first;
      });
      child = (child! as ChildProcessWithoutNullStreams);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const msg = code === "ENOENT" || code === "EACCES" ? `${validated.argv[0]}: command not found` : String((e as Error).message ?? e);
      throw new NativeError("COMMAND_NOT_FOUND", msg);
    }

    const id = newProcessId();
    const proc: ManagedProcess = {
      id,
      command: validated.command,
      cwd: validated.cwd,
      child: child!,
      startedAt: Date.now(),
      status: "running",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      sensitive
    };
    procs.set(id, proc);

    const append = (stream: "stdout" | "stderr", text: string) => {
      const max = stream === "stdout" ? maxStdout : maxStderr;
      const isStdout = stream === "stdout";
      if (isStdout) {
        if (proc.stdoutTruncated) return;
        const enc = Buffer.byteLength(text, "utf8");
        if (proc.stdoutBytes + enc <= max) {
          proc.stdout += text;
          proc.stdoutBytes += enc;
        } else {
          const remaining = max - proc.stdoutBytes;
          if (remaining > 0) proc.stdout += text.slice(0, Math.max(0, remaining));
          proc.stdoutTruncated = true;
        }
      } else {
        if (proc.stderrTruncated) return;
        const enc = Buffer.byteLength(text, "utf8");
        if (proc.stderrBytes + enc <= max) {
          proc.stderr += text;
          proc.stderrBytes += enc;
        } else {
          const remaining = max - proc.stderrBytes;
          if (remaining > 0) proc.stderr += text.slice(0, Math.max(0, remaining));
          proc.stderrTruncated = true;
        }
      }
      const chunk: ProcessOutputChunk = { stream, text, truncated: isStdout ? proc.stdoutTruncated : proc.stderrTruncated };
      opts.onChunk?.(id, chunk);
    };

    child!.stdout.on("data", (chunk: Buffer) => append("stdout", chunk.toString("utf8")));
    child!.stderr.on("data", (chunk: Buffer) => append("stderr", chunk.toString("utf8")));

    child!.on("close", (code, signal) => {
      proc.exitCode = code;
      proc.signal = signal;
      if (proc.status === "running") {
        proc.status = signal ? "killed" : "exited";
      }
      if (proc.timer) clearTimeout(proc.timer);
    });
    child!.on("error", () => {
      proc.status = "exited";
      if (proc.timer) clearTimeout(proc.timer);
    });

    if (req.timeoutMs !== null && req.timeoutMs !== undefined) {
      const ms = Math.min(600_000, Math.max(1000, Math.floor(req.timeoutMs)));
      proc.timer = setTimeout(() => {
        proc.status = "timedout";
        killTree(child!, false);
        setTimeout(() => killTree(child!, true), KILL_GRACE_MS).unref();
      }, ms);
      proc.timer.unref();
    }

    return toInfo(proc);
  }

  function status(id: string): ProcessInfo {
    const p = procs.get(id);
    if (!p) throw new NativeError("PROCESS_NOT_FOUND", `Process not found: ${id}`);
    return toInfo(p);
  }

  function output(id: string): { stdout: string; stderr: string; outputTruncated: boolean; redacted: boolean } {
    const p = procs.get(id);
    if (!p) throw new NativeError("PROCESS_NOT_FOUND", `Process not found: ${id}`);
    const stdout = redactOutput(p.stdout, p.sensitive);
    const stderr = redactOutput(p.stderr, p.sensitive);
    return { stdout, stderr, outputTruncated: p.stdoutTruncated || p.stderrTruncated, redacted: stdout !== p.stdout || stderr !== p.stderr };
  }

  function stop(id: string, force = false): ProcessInfo {
    const p = procs.get(id);
    if (!p) throw new NativeError("PROCESS_NOT_FOUND", `Process not found: ${id}`);
    if (p.status !== "running") return toInfo(p);
    p.status = "killed";
    killTree(p.child, force);
    if (!force) setTimeout(() => killTree(p.child, true), KILL_GRACE_MS).unref();
    if (p.timer) clearTimeout(p.timer);
    return toInfo(p);
  }

  function clearFinished(): void {
    for (const [id, p] of procs) {
      if (p.status !== "running") procs.delete(id);
    }
  }

  return { start, status, output, stop, list, clearFinished, _map: procs };
}

export type ProcessManager = ReturnType<typeof createProcessManager>;
