// Behavioral security regression suite for the local connector's workspace
// boundary. Spawns the REAL connector (node local-connector/server.js) with
// NEXUSS_WORKSPACE_ROOT pointed at a temporary workspace and exercises the
// boundary against the real filesystem — no mocks of fs or spawn.
//
// Covers the regression list from the security fix:
//   1. command inside the permitted workspace succeeds
//   2. nested directories succeed
//   3. `..` traversal outside the workspace is rejected
//   4. unauthorized absolute Windows paths are rejected (cwd + command args)
//   5. UNC paths are rejected
//   6. junctions cannot bypass the boundary
//   7. a forged client cwd cannot bypass authorization
//   8. unauthorized file reads/writes are rejected without touching disk
//   9. allowed commands still work
//  10. cat works in-workspace, fails on missing files, rejects outside paths
//  11. exact file bytes survive the PowerShell 5.1 write template
//  12. (client-side disconnected-terminal protections live in
//      terminalConnection.test.ts / chatTerminalGate.test.ts — run with the
//      focused suite)

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 11600 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess | null = null;

let tmp: string;
let root: string; // the permitted workspace (connector's trusted root)
let outside: string; // a sibling directory OUTSIDE the workspace
let nested: string; // root/nested/deeper

async function term(command: string, cwd?: string, timeoutMs = 30000) {
  const res = await fetch(`${BASE}/v1/terminal/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ command, cwd, timeoutMs }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { httpStatus: res.status, ...body } as {
    httpStatus: number;
    success?: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    error?: string;
    cwd?: string;
  };
}

async function waitHealthy(timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("connector did not become healthy");
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexuss-sec-"));
  root = path.join(tmp, "workspace");
  outside = path.join(tmp, "outside");
  nested = path.join(root, "nested", "deeper");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  // A canary file OUTSIDE the workspace — no test may ever modify it.
  fs.writeFileSync(path.join(outside, "canary.txt"), "canary-must-not-change");
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./server.js", import.meta.url))],
    {
      env: {
        ...process.env,
        NEXUSS_CONNECTOR_PORT: String(PORT),
        NEXUSS_WORKSPACE_ROOT: root,
      },
      stdio: "ignore",
    }
  );
  await waitHealthy();
}, 20_000);

afterAll(() => {
  child?.kill();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of temp dirs we created.
  }
});

describe("workspace boundary — allowed operations", () => {
  it("1. runs an allowed command with cwd inside the workspace", async () => {
    const r = await term("node --version", root);
    expect(r.httpStatus).toBe(200);
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect((r.stdout || "").trim()).toMatch(/^v\d+/);
  });

  it("2. accepts a valid nested directory as cwd", async () => {
    const r = await term("pwd", nested);
    expect(r.httpStatus).toBe(200);
    expect(r.success).toBe(true);
    expect((r.stdout || "").toLowerCase()).toContain(path.basename(nested).toLowerCase());
  });

  it("2b. accepts a relative cwd inside the workspace", async () => {
    const r = await term("pwd", "nested/deeper");
    expect(r.httpStatus).toBe(200);
    expect(r.success).toBe(true);
  });

  it("9. still allows echo/pwd/node after the security fix", async () => {
    const echo = await term("echo hello world", root);
    expect(echo.success).toBe(true);
    expect(echo.stdout).toContain("hello world");
    const pwd = await term("pwd", root);
    expect(pwd.success).toBe(true);
  });
});

describe("workspace boundary — rejections", () => {
  it("3. rejects `..` traversal in cwd", async () => {
    const r = await term("node --version", path.join(root, "..", "outside"));
    expect(r.httpStatus).toBe(400);
    expect(r.error).toBe("Working directory is outside the permitted workspace.");
    expect(r.success).toBeUndefined();
  });

  it("3b. rejects `..` traversal in a cat path", async () => {
    const r = await term(`cat ${path.join("..", "..", "outside", "canary.txt")}`, root);
    expect(r.httpStatus).toBe(400);
    expect(r.error).toBe("Path is outside the permitted workspace.");
  });

  it("4. rejects an unauthorized absolute path as cwd", async () => {
    const r = await term("node --version", outside);
    expect(r.httpStatus).toBe(400);
    expect(r.error).toBe("Working directory is outside the permitted workspace.");
    // And nothing ran.
    expect(r.success).toBeUndefined();
  });

  it("4b. rejects an unauthorized absolute path embedded in a command", async () => {
    const canary = path.join(outside, "canary.txt");
    const r = await term(`powershell -NoProfile -Command "Get-Content -LiteralPath '${canary}' | Out-String"`, root);
    expect(r.httpStatus).toBe(400);
    expect(r.error).toBe("Path is outside the permitted workspace.");
    // Canary untouched.
    expect(fs.readFileSync(path.join(outside, "canary.txt"), "utf8")).toBe("canary-must-not-change");
  });

  it("4c. rejects an unauthorized write target inside a command", async () => {
    const target = path.join(outside, "pwned.txt");
    const b64 = Buffer.from("pwned", "utf8").toString("base64");
    const r = await term(
      `powershell -NoProfile -Command "[Convert]::FromBase64String('${b64}') | Set-Content -LiteralPath ${target} -Encoding Byte"`,
      root
    );
    expect(r.httpStatus).toBe(400);
    expect(r.error).toBe("Path is outside the permitted workspace.");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("5. rejects a UNC path as cwd", async () => {
    const r = await term("node --version", "\\\\evil.example\\share\\proj");
    expect(r.httpStatus).toBe(400);
    expect(r.error).toBe("UNC paths are not allowed.");
  });

  it("5b. rejects a UNC path embedded in a command", async () => {
    const r = await term(`cat \\\\evil.example\\share\\secrets.txt`, root);
    expect(r.httpStatus).toBe(400);
    expect(r.error).toBe("UNC paths are not allowed.");
  });

  it("7. a forged client cwd cannot authorize an outside command", async () => {
    // Command is clean, cwd points outside — must be rejected before spawn.
    const r = await term("node --version", outside);
    expect(r.httpStatus).toBe(400);
    expect(r.error).toBe("Working directory is outside the permitted workspace.");
  });

  it("7b. an inside cwd does not authorize an outside command path", async () => {
    // cwd is legitimate, but the command targets the canary outside.
    const r = await term(`cat ${path.join(outside, "canary.txt")}`, root);
    expect(r.httpStatus).toBe(400);
    expect(r.error).toBe("Path is outside the permitted workspace.");
    expect(fs.readFileSync(path.join(outside, "canary.txt"), "utf8")).toBe("canary-must-not-change");
  });
});

describe("workspace boundary — symlink/junction escapes", () => {
  it("6. a junction inside the workspace cannot be used as cwd", async () => {
    const junction = path.join(root, "escape-junction");
    try {
      fs.symlinkSync(outside, junction, "junction");
    } catch {
      return; // junction creation not permitted on this volume — skip honestly
    }
    const r = await term("pwd", junction);
    expect(r.httpStatus).toBe(400);
    expect(r.error).toBe("Working directory is outside the permitted workspace.");
  });

  it("6b. a junction inside the workspace cannot be used to read outside", async () => {
    const junction = path.join(root, "escape-junction");
    if (!fs.existsSync(junction)) {
      try {
        fs.symlinkSync(outside, junction, "junction");
      } catch {
        return;
      }
    }
    const r = await term(`cat ${path.join(junction, "canary.txt")}`, root);
    expect(r.httpStatus).toBe(400);
    expect(r.error).toBe("Path is outside the permitted workspace.");
  });
});

describe("cat command behavior", () => {
  it("10. reads a file inside the workspace", async () => {
    const file = path.join(root, "hello.txt");
    fs.writeFileSync(file, "hello from cat");
    const r = await term(`cat ${file}`, root);
    expect(r.httpStatus).toBe(200);
    expect(r.success).toBe(true);
    expect(r.stdout).toBe("hello from cat");
  });

  it("10b. reports a missing file without crashing the connector", async () => {
    const r = await term(`cat ${path.join(root, "definitely-missing.txt")}`, root);
    expect(r.httpStatus).toBe(200);
    expect(r.success).toBe(false);
    expect(r.stderr).toBe("File not found.");
    // Connector still healthy after the failure.
    expect((await fetch(`${BASE}/health`)).ok).toBe(true);
  });

  it("10c. rejects reading a file outside the workspace", async () => {
    const r = await term(`cat ${path.join(outside, "canary.txt")}`, root);
    expect(r.httpStatus).toBe(400);
    expect(r.error).toBe("Path is outside the permitted workspace.");
  });
});

describe("PowerShell 5.1 byte-write template (exact bytes)", () => {
  it("11. writes exact bytes via the planner's base64 Set-Content template", async () => {
    const file = path.join(root, "exact.txt");
    const content = "Nexuss terminal test passed"; // no trailing newline
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const r = await term(
      `powershell -NoProfile -Command "[Convert]::FromBase64String('${b64}') | Set-Content -LiteralPath ${file} -Encoding Byte"`,
      root
    );
    expect(r.httpStatus).toBe(200);
    expect(r.success, JSON.stringify(r)).toBe(true);
    const raw = fs.readFileSync(file);
    expect(raw.toString("base64")).toBe(b64);
    expect(raw.toString("utf8")).toBe(content);
  });

  it("11b. python executes inside the workspace and returns real output", async () => {
    const py = path.join(root, "calc.py");
    fs.writeFileSync(py, "print(25 + 17)\n");
    const r = await term(`python '${py}'`, root);
    expect(r.httpStatus).toBe(200);
    expect(r.success).toBe(true);
    expect((r.stdout || "").trim()).toBe("42");
  });
});

describe("default-root connector (home boundary) smoke of the boundary", () => {
  // The long-running dev connector on 11435 (if present) uses the home root.
  // When reachable, an outside-home absolute path must be rejected too.
  it("rejects a clearly unauthorized absolute cwd when the home-root connector is up", async () => {
    let reachable = false;
    try {
      const h = await fetch("http://127.0.0.1:11435/health", undefined);
      reachable = h.ok;
    } catch {
      reachable = false;
    }
    if (!reachable) return; // no live connector in this environment — honest skip
    const res = await fetch("http://127.0.0.1:11435/v1/terminal/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "node --version", cwd: "C:\\ProgramData" }),
    });
    // ProgramData is outside the user home root — must not execute.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Working directory is outside the permitted workspace.");
  });
});
