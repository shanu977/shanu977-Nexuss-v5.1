// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runCommand } from "./exec";
import { makeFixture, nodeScript } from "./test-helpers";

async function run(
  command: string,
  opts: { cwd?: string; root: string; timeoutMs?: number; maxStdoutBytes?: number; maxStderrBytes?: number } & {
    allowedExact?: boolean;
  }
) {
  return runCommand(
    {
      command,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      maxStdoutBytes: opts.maxStdoutBytes,
      maxStderrBytes: opts.maxStderrBytes
    },
    {
      cwd: opts.cwd ?? opts.root,
      workspaceRoot: opts.root,
      allowedExact: opts.allowedExact ? [command] : undefined
    }
  );
}

describe("runCommand (real processes)", () => {
  it("runs a real command and returns its output", async () => {
    const fx = makeFixture();
    try {
      const res = await run(
        nodeScript("process.stdout.write('hello-native')"),
        { root: fx.root, allowedExact: true }
      );
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe("hello-native");
      expect(res.success).toBe(true);
      expect(res.durationMs).toBeGreaterThan(0);
      expect(res.signal).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  it("captures stderr and reports a non-zero exit", async () => {
    const fx = makeFixture();
    try {
      const res = await run(
        nodeScript("process.stderr.write('boom'); process.exit(3)"),
        { root: fx.root, allowedExact: true }
      );
      expect(res.exitCode).toBe(3);
      expect(res.stderr).toContain("boom");
      expect(res.success).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("reports a missing binary as a failed run, not a throw", async () => {
    const fx = makeFixture();
    try {
      const res = await run("definitely-not-a-real-binary-xyz", {
        root: fx.root,
        allowedExact: true
      });
      expect(res.success).toBe(false);
      // Windows routes unknown commands through cmd.exe, which reports its own
      // message; POSIX reports ENOENT with a null exit code.
      expect(res.stderr).toMatch(/not found|not recognized|ENOENT/i);
      expect(res.stdout).toBe("");
    } finally {
      fx.cleanup();
    }
  });

  it("times out and kills long-running commands", async () => {
    const fx = makeFixture();
    try {
      const res = await run(nodeScript("setInterval(()=>{},50)"), {
        root: fx.root,
        timeoutMs: 1500,
        allowedExact: true
      });
      expect(res.timedOut).toBe(true);
      expect(res.killed).toBe(true);
      expect(res.success).toBe(false);
      expect(res.durationMs).toBeGreaterThanOrEqual(1400);
    } finally {
      fx.cleanup();
    }
  });

  it("truncates and then hard-kills an infinite writer", async () => {
    const fx = makeFixture();
    try {
      const res = await run(
        nodeScript("setInterval(()=>process.stdout.write('x'.repeat(4096)),1)"),
        {
          root: fx.root,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          timeoutMs: 1500,
          allowedExact: true
        }
      );
      expect(res.outputTruncated).toBe(true);
      expect(res.stdout.length).toBeLessThanOrEqual(1024);
      // Either killed by the hard cap or timed out; never a clean success.
      expect(res.success).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("lets a caller terminate the child via the onStart handle", async () => {
    const fx = makeFixture();
    try {
      let handle: { terminate: () => void } | undefined;
      const pending = runCommand(
        { command: nodeScript("setInterval(()=>{},50)"), timeoutMs: 60_000 },
        {
          cwd: fx.root,
          workspaceRoot: fx.root,
          allowedExact: [nodeScript("setInterval(()=>{},50)")],
          onStart: (h) => {
            handle = h;
          }
        }
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(handle).toBeDefined();
      handle?.terminate();
      const res = await pending;
      expect(res.killed).toBe(true);
      expect(res.success).toBe(false);
    } finally {
      fx.cleanup();
    }
  }, 20_000);

  it("rejects policy-violating commands before spawning anything", async () => {
    const fx = makeFixture();
    try {
      await expect(
        run("npm test && rm -rf /", { root: fx.root, allowedExact: false })
      ).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
      await expect(
        run("curl http://evil.example", { root: fx.root, allowedExact: false })
      ).rejects.toMatchObject({ code: "COMMAND_NOT_ALLOWED" });
    } finally {
      fx.cleanup();
    }
  });

  it("redacts secret-shaped output before returning it", async () => {
    const fx = makeFixture();
    try {
      const res = await run(
        nodeScript("console.log('key is sk-1234567890abcdef987654')"),
        { root: fx.root, allowedExact: true }
      );
      expect(res.stdout).toContain("***REDACTED***");
      expect(res.stdout).not.toContain("sk-1234567890abcdef987654");
      expect(res.redacted).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});
