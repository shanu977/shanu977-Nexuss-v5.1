// Native process execution (STEP 4/10/11/12/14).
//
// Real `child_process.spawn`-based execution. No `exec` with unrestricted
// shells: commands are tokenized and validated by the policy, then spawned
// without a shell where possible (a cmd.exe wrapper is used on Windows ONLY
// for package-manager `.cmd` shims like npm.cmd). Every run gets a timeout
// with graceful-then-forced termination, per-stream output caps, env scrubbing
// and output redaction.

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { NativeError } from "./errors";
import { validateCommand } from "./policy";
import type { NativeCommandResult, RunRequest } from "./types";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  KILL_GRACE_MS,
  MAX_TIMEOUT_MS
} from "./types";
import { buildScrubbedEnv, collectSensitiveEnvValues, redactOutput } from "./redact";

/** A live handle the runtime can use to cancel a running command (STEP 31). */
export interface RunningCommand {
  pid: number | undefined;
  terminate: () => void;
}

interface RunOptions {
  /** Canonical absolute cwd (already validated inside the workspace root). */
  cwd: string;
  /** Canonical workspace root for policy checks. */
  workspaceRoot: string;
  /** Exact trusted commands (e.g. discovered plans) that always pass policy. */
  allowedExact?: string[];
  /** Hook used by the runtime to track/kill the active child (cancellation). */
  onStart?: (handle: RunningCommand) => void;
  /** Streaming callback per data chunk (for incremental UI). */
  onChunk?: (stream: "stdout" | "stderr", text: string) => void;
}

function clampTimeout(ms: number | undefined): number {
  if (ms === undefined) return DEFAULT_COMMAND_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(ms)));
}

function clampOutput(bytes: number | undefined): number {
  if (bytes === undefined) return DEFAULT_MAX_OUTPUT_BYTES;
  return Math.min(4 * 1024 * 1024, Math.max(1024, Math.floor(bytes)));
}

interface OutputBuffer {
  text: string;
  bytes: number;
  truncated: boolean;
}

function appendCapped(buf: OutputBuffer, chunk: string, maxBytes: number): void {
  if (buf.truncated) return;
  const encoded = Buffer.byteLength(chunk, "utf8");
  if (buf.bytes + encoded <= maxBytes) {
    buf.text += chunk;
    buf.bytes += encoded;
    return;
  }
  const remaining = maxBytes - buf.bytes;
  if (remaining > 0) {
    buf.text += chunk.slice(0, Math.max(0, remaining));
  }
  buf.truncated = true;
}

/**
 * Terminate a spawned process and its descendants. On Windows the process
 * tree is killed via taskkill; elsewhere the (always detached) process group
 * is signalled.
 */
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
    } catch {
      // The process group may already be gone.
    }
  }
}

function spawnValidated(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  command: string
): Promise<ChildProcessWithoutNullStreams> {
  const common = {
    cwd,
    env,
    windowsHide: true,
    shell: false,
    detached: process.platform !== "win32"
  } as const;
  const first = spawn(argv[0], argv.slice(1), common);
  return new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
    let done = false;
    first.once("spawn", () => {
      done = true;
      resolve(first);
    });
    first.once("error", (err) => {
      if (done) return;
      const e = err as NodeJS.ErrnoException;
      if (process.platform === "win32" && (e.code === "ENOENT" || e.code === "EACCES")) {
        // Package-manager shims (npm.cmd / pnpm.cmd / ...) are not directly
        // spawnable via CreateProcess. The validated command is run through
        // cmd.exe; it has already passed the policy (no shell metacharacters),
        // so this is a controlled wrapper, not arbitrary shell evaluation.
        const wrapped = spawn(
          process.env.ComSpec || "cmd.exe",
          ["/d", "/s", "/c", command],
          common
        );
        wrapped.once("spawn", () => {
          done = true;
          resolve(wrapped);
        });
        wrapped.once("error", (werr) => {
          if (!done) {
            done = true;
            reject(werr);
          }
        });
      } else {
        reject(err);
      }
    });
  });
}

export async function runCommand(
  req: RunRequest,
  opts: RunOptions
): Promise<NativeCommandResult> {
  const command = req.command.trim();
  if (!command) throw new NativeError("COMMAND_NOT_ALLOWED", "Command is empty.");

  const validated = validateCommand(command, {
    cwd: opts.cwd,
    workspaceRoot: opts.workspaceRoot,
    allowedExact: opts.allowedExact
  });

  const timeoutMs = clampTimeout(req.timeoutMs);
  const maxStdout = clampOutput(req.maxStdoutBytes);
  const maxStderr = clampOutput(req.maxStderrBytes);
  const env = buildScrubbedEnv(process.env) as NodeJS.ProcessEnv;
  const sensitive = collectSensitiveEnvValues(process.env);

  const started = Date.now();
  const stdout: OutputBuffer = { text: "", bytes: 0, truncated: false };
  const stderr: OutputBuffer = { text: "", bytes: 0, truncated: false };

  const child = await spawnValidated(validated.argv, validated.cwd, env, validated.command);

  let timedOut = false;
  let killed = false;
  let hardCapExceeded = false;
  let settled = false;
  let totalBytes = 0;

  const finish = (): NativeCommandResult => {
    settled = true;
    if (timer) clearTimeout(timer);
    const stdoutText = redactOutput(stdout.text, sensitive);
    const stderrText = redactOutput(stderr.text, sensitive);
    const redacted = stdoutText !== stdout.text || stderrText !== stderr.text;
    const success =
      !timedOut &&
      !killed &&
      !hardCapExceeded &&
      child.exitCode === 0 &&
      child.signalCode === null;
    return {
      command: validated.command,
      cwd: validated.cwd,
      exitCode: child.exitCode,
      stdout: stdoutText,
      stderr: stderrText,
      durationMs: Date.now() - started,
      timedOut,
      killed,
      signal: child.signalCode,
      success,
      outputTruncated: stdout.truncated || stderr.truncated,
      redacted
    };
  };

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    totalBytes += Buffer.byteLength(text, "utf8");
    appendCapped(stdout, text, maxStdout);
    opts.onChunk?.("stdout", text);
    if (totalBytes > (maxStdout + maxStderr) * 40) {
      hardCapExceeded = true;
      killTree(child, true);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    totalBytes += Buffer.byteLength(text, "utf8");
    appendCapped(stderr, text, maxStderr);
    opts.onChunk?.("stderr", text);
    if (totalBytes > (maxStdout + maxStderr) * 40) {
      hardCapExceeded = true;
      killTree(child, true);
    }
  });

  const terminate = (): void => {
    if (settled) return;
    killed = true;
    killTree(child, false);
    const force = setTimeout(() => killTree(child, true), KILL_GRACE_MS);
    force.unref();
  };

  opts.onStart?.({ pid: child.pid, terminate });

  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  timer.unref();

  return new Promise<NativeCommandResult>((resolve) => {
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      const notFound = code === "ENOENT" || code === "EACCES";
      resolve({
        command: validated.command,
        cwd: validated.cwd,
        exitCode: null,
        stdout: "",
        stderr: notFound
          ? `${validated.argv[0]}: command not found`
          : String(err.message ?? err),
        durationMs: Date.now() - started,
        timedOut: false,
        killed: false,
        signal: null,
        success: false,
        outputTruncated: false,
        redacted: false
      });
    });

    child.on("close", () => {
      if (settled) return;
      resolve(finish());
    });
  });
}
