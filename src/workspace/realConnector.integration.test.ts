// Real local-connector integration test — NOT run in the normal suite.
//
// Requires a live connector (`node local-connector/server.js`) and is gated
// behind NEXUSS_REAL_CONNECTOR=1 so CI/unit runs never depend on it:
//
//   NEXUSS_REAL_CONNECTOR=1 npx vitest run src/workspace/realConnector.integration.test.ts
//
// Verifies, against the real connector process: health contract, CORS/PNA
// headers, real command execution (create `shanu` folder + hello source file,
// then run it), and filesystem truth of the results. Uses a temporary
// workspace (with a space in the path) and cleans up after itself.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { probeLocalConnector, createLocalConnectorRuntime } from "@/workspace/localTerminalRuntime";

const RUN = process.env.NEXUSS_REAL_CONNECTOR === "1";
const CONNECTOR_URL = "http://127.0.0.1:11435";

describe.skipIf(!RUN)("real local-connector integration", () => {
  let testRoot: string;
  let shanuDir: string;
  let helloFile: string;

  beforeAll(async () => {
    // Space in the path exercises the connector's quoting handling.
    testRoot = path.join(os.tmpdir(), `nexuss int test ${Date.now()}`);
    shanuDir = path.join(testRoot, "shanu");
    helloFile = path.join(shanuDir, "hello.js");
    // The connector spawns with cwd=testRoot, so it must exist first.
    await fs.mkdir(testRoot, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("passes the real health check with CORS and private-network headers", async () => {
    const probe = await probeLocalConnector({ force: true });
    expect(probe.ok).toBe(true);

    const res = await fetch(`${CONNECTOR_URL}/health`, {
      headers: { Origin: "https://www.nexuss.in" }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.connector).toBe("nexuss-local");
    expect(body.terminal).toBe("enabled");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://www.nexuss.in");
    expect(res.headers.get("access-control-allow-private-network")).toBe("true");

    // PNA preflight the browser sends for public -> private requests.
    const pre = await fetch(`${CONNECTOR_URL}/v1/terminal/run`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://www.nexuss.in",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Private-Network": "true"
      }
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("executes real commands: create shanu folder, hello file, and run it", async () => {
    const runtime = createLocalConnectorRuntime();

    // 1. Create the workspace root and the `shanu` folder (space in path).
    const mk = await runtime.run({
      command: `powershell -NoProfile -Command New-Item -ItemType Directory -Force -Path '${shanuDir}' | Out-Null`,
      cwd: testRoot
    });
    expect(mk.success, `mkdir failed: ${mk.stderr}`).toBe(true);
    const stat = await fs.stat(shanuDir);
    expect(stat.isDirectory()).toBe(true);

    // 2. Write a small source file that prints "hello shanu".
    //    PS single-quoted string: '' escapes a literal single quote.
    const write = await runtime.run({
      command: `powershell -NoProfile -Command Set-Content -LiteralPath '${helloFile}' -Value 'console.log(''hello shanu'')'`,
      cwd: testRoot
    });
    expect(write.success, `write failed: ${write.stderr}`).toBe(true);
    const content = await fs.readFile(helloFile, "utf8");
    expect(content).toContain("hello shanu");

    // 3. Run it through the same execution path and verify real output.
    const run = await runtime.run({ command: `node '${helloFile}'`, cwd: shanuDir });
    expect(run.success, `run failed: ${run.stderr}`).toBe(true);
    expect(run.stdout).toContain("hello shanu");
  });

  it("rejects a disallowed command without executing anything", async () => {
    const runtime = createLocalConnectorRuntime();
    await expect(
      runtime.run({ command: "definitely-not-an-allowed-bin", cwd: testRoot })
    ).rejects.toThrow(/not an allowed command/i);
  });

  it("survives a spawn failure (missing cwd) and keeps serving", async () => {
    const runtime = createLocalConnectorRuntime();
    const res = await runtime.run({
      command: "node --version",
      cwd: path.join(testRoot, "does-not-exist")
    });
    expect(res.success).toBe(false);
    // The connector process must not crash from the failed spawn.
    expect((await probeLocalConnector({ force: true })).ok).toBe(true);
  });
});
