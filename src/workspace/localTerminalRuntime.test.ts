// Regression coverage for connector error-body sanitization.
//
// The connector client must never forward an arbitrary HTTP response body or a
// raw transport exception into user-facing text: 500 internal/filesystem
// errors, 403 origin details, 404 endpoint lists and unknown or malformed
// payloads are replaced with generic copy, while the connector's intentional
// HTTP 400 policy denials stay readable. Genuine command output is untouched.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalConnectorRuntime, connectorHttpError } from "@/workspace/localTerminalRuntime";
import { toUserFacingTerminalError } from "@/workspace/terminalConnection";

function respond(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => respond(status, body)));
}

/** Await a rejection and return the thrown error (throws if the call resolves). */
async function rejection(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

const runtime = () => createLocalConnectorRuntime();
const run = () => runtime().run({ command: "node app.js", cwd: "" });
const testRun = () => runtime().test({ cwd: "" });

/** Tokens that must never appear in user-facing text, per status class. */
const FS_ERROR = { error: "ENOENT: no such file or directory, scandir 'C:\\Users\\pilli\\secret-project'" };
const ORIGIN_DETAIL = { error: "Origin https://evil.example.com not allowed." };
const ENDPOINT_LIST = { error: "Not found. Allowed: /v1/models, /v1/chat/completions, /api/tags, /api/pull." };
const UNKNOWN_JSON = { error: "Kernel panic in connector-worker.js line 42" };
const HTML_BODY = "<html><body>502 Bad Gateway from internal-proxy.local</body></html>";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("run(): connector HTTP error sanitization", () => {
  it("1. sanitizes an HTTP 500 internal filesystem error", async () => {
    stubFetch(500, FS_ERROR);
    const err = await rejection(run);

    expect(err.message).not.toContain("ENOENT");
    expect(err.message).not.toContain("scandir");
    expect(err.message).not.toContain("secret-project");
    expect(err.message).not.toContain("C:\\Users");
    expect(err.message).toMatch(/internal error/i);
    // Safe copy must not read as a technical failure, so a live connector is
    // not wrongly marked unavailable by the connection store.
    expect(toUserFacingTerminalError(err.message)).toBe(err.message);
  });

  it("2. sanitizes an HTTP 403 origin/permission detail", async () => {
    stubFetch(403, ORIGIN_DETAIL);
    const err = await rejection(run);

    expect(err.message).not.toContain("evil.example.com");
    expect(err.message).not.toContain("Origin");
    expect(err.message).not.toContain("not allowed.");
    expect(err.message).toMatch(/refused access/i);
    expect(toUserFacingTerminalError(err.message)).toBe(err.message);
  });

  it("3. sanitizes an HTTP 404 internal endpoint list", async () => {
    stubFetch(404, ENDPOINT_LIST);
    const err = await rejection(run);

    expect(err.message).not.toContain("/v1/models");
    expect(err.message).not.toContain("Allowed:");
    expect(err.message).not.toContain("/api/pull");
    expect(err.message).toMatch(/did not understand/i);
    expect(toUserFacingTerminalError(err.message)).toBe(err.message);
  });

  it("4. sanitizes unknown and malformed error bodies", async () => {
    stubFetch(500, UNKNOWN_JSON);
    const unknownErr = await rejection(run);
    expect(unknownErr.message).not.toContain("Kernel panic");
    expect(unknownErr.message).not.toContain("connector-worker.js");
    expect(unknownErr.message).toMatch(/internal error/i);

    stubFetch(400, HTML_BODY);
    const malformedErr = await rejection(run);
    expect(malformedErr.message).not.toContain("Bad Gateway");
    expect(malformedErr.message).not.toContain("internal-proxy.local");
    expect(malformedErr.message).not.toContain("html");

    stubFetch(502, HTML_BODY);
    const gatewayErr = await rejection(run);
    expect(gatewayErr.message).not.toContain("internal-proxy.local");
    expect(toUserFacingTerminalError(gatewayErr.message)).toBe(gatewayErr.message);
  });

  it("5. keeps approved HTTP 400 policy denials understandable", async () => {
    stubFetch(400, { error: "Shell metacharacters are not allowed." });
    expect((await rejection(run)).message).toBe("Shell metacharacters are not allowed.");

    stubFetch(400, { error: "Shell chaining && and || is not allowed." });
    expect((await rejection(run)).message).toBe("Shell chaining && and || is not allowed.");

    stubFetch(400, { error: `"definitely-not-an-allowed-bin" is not an allowed command.` });
    const binErr = await rejection(run);
    expect(binErr.message).toBe(`"definitely-not-an-allowed-bin" is not an allowed command.`);

    // Policy denials are safe and actionable: they pass the downstream
    // sanitizer untouched and do not mark the connector unavailable.
    expect(toUserFacingTerminalError(binErr.message)).toBe(binErr.message);
  });

  it("6. returns genuine command output unchanged", async () => {
    stubFetch(200, {
      command: "node app.js",
      cwd: "C:\\work",
      exitCode: 3,
      stdout: "listening on localhost:3000\n",
      stderr: "Warning: ECONNREFUSED retrying 127.0.0.1:9229\n",
      durationMs: 42,
      timedOut: false,
      killed: false,
      signal: null,
      success: false,
      outputTruncated: false,
      redacted: false
    });

    const res = await run();
    expect(res.exitCode).toBe(3);
    expect(res.success).toBe(false);
    expect(res.durationMs).toBe(42);
    // Successful/failed command results are NOT passed through the sanitizer,
    // even when the tool output happens to look technical.
    expect(res.stdout).toBe("listening on localhost:3000\n");
    expect(res.stderr).toBe("Warning: ECONNREFUSED retrying 127.0.0.1:9229\n");
  });
});

describe("test(): connector HTTP error sanitization", () => {
  it("1. sanitizes an HTTP 500 internal filesystem error", async () => {
    stubFetch(500, FS_ERROR);
    const err = await rejection(testRun);

    expect(err.message).not.toContain("ENOENT");
    expect(err.message).not.toContain("secret-project");
    expect(err.message).not.toContain("C:\\Users");
    expect(err.message).toMatch(/internal error/i);
    expect(toUserFacingTerminalError(err.message)).toBe(err.message);
  });

  it("2. sanitizes an HTTP 403 origin/permission detail", async () => {
    stubFetch(403, ORIGIN_DETAIL);
    const err = await rejection(testRun);

    expect(err.message).not.toContain("evil.example.com");
    expect(err.message).not.toContain("Origin");
    expect(err.message).toMatch(/refused access/i);
  });

  it("3. sanitizes an HTTP 404 internal endpoint list", async () => {
    stubFetch(404, ENDPOINT_LIST);
    const err = await rejection(testRun);

    expect(err.message).not.toContain("/v1/models");
    expect(err.message).not.toContain("Allowed:");
    expect(err.message).toMatch(/did not understand/i);
  });

  it("4. sanitizes unknown and malformed error bodies", async () => {
    stubFetch(500, UNKNOWN_JSON);
    const unknownErr = await rejection(testRun);
    expect(unknownErr.message).not.toContain("Kernel panic");
    expect(unknownErr.message).not.toContain("connector-worker.js");

    stubFetch(400, HTML_BODY);
    const malformedErr = await rejection(testRun);
    expect(malformedErr.message).not.toContain("internal-proxy.local");
    expect(malformedErr.message).not.toContain("Bad Gateway");
  });

  it("5. keeps approved HTTP 400 policy denials understandable", async () => {
    stubFetch(400, { error: "Shell metacharacters are not allowed." });
    expect((await rejection(testRun)).message).toBe("Shell metacharacters are not allowed.");

    stubFetch(400, { error: `"badbin" is not an allowed command.` });
    expect((await rejection(testRun)).message).toBe(`"badbin" is not an allowed command.`);
  });

  it("6. returns genuine test output unchanged", async () => {
    stubFetch(200, {
      command: "npm test",
      cwd: "C:\\work",
      exitCode: 0,
      stdout: "  12 passed  on localhost:5173\n",
      stderr: "",
      durationMs: 9,
      timedOut: false,
      killed: false,
      signal: null,
      success: true,
      outputTruncated: false,
      redacted: false
    });

    const res = await testRun();
    expect(res.exitCode).toBe(0);
    expect(res.success).toBe(true);
    expect(res.stdout).toBe("  12 passed  on localhost:5173\n");
    expect(res.stderr).toBe("");
    expect(res.plan?.command).toBe("npm test");
  });
});

describe("raw connector exceptions (transport + unreadable body)", () => {
  it("does not leak endpoints, ports or setup instructions from a transport failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:11435 (CORS, chrome://flags#block-insecure)");
      })
    );

    const err = await rejection(run);
    expect(err.message).toContain("NETWORK_ERROR");
    expect(err.message).not.toContain("ECONNREFUSED");
    expect(err.message).not.toContain("127.0.0.1");
    expect(err.message).not.toContain("chrome://flags");
    expect(err.message).not.toContain("node local-connector");
    expect(err.message).not.toContain("CORS");
    // Classification must survive so the store can still mark the connection lost.
    expect(toUserFacingTerminalError(err.message)).not.toBe(err.message);
  });

  it("does not leak setup instructions from a transport timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      })
    );

    const err = await rejection(run);
    expect(err.message).toContain("TIMEOUT: Local terminal");
    expect(err.message).not.toContain("node local-connector");
    expect(err.message).not.toContain("chrome://flags");
    expect(err.message).not.toContain("127.0.0.1");
    expect(toUserFacingTerminalError(err.message)).not.toBe(err.message);
  });

  it("sanitizes an unreadable successful response body", async () => {
    stubFetch(200, "this is not json {{{");

    const err = await rejection(run);
    expect(err.message).not.toContain("this is not json");
    expect(err.message).toMatch(/unreadable response/i);
    expect(toUserFacingTerminalError(err.message)).toBe(err.message);
  });

  it("applies the same protection to test()", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:11435");
      })
    );

    const err = await rejection(testRun);
    expect(err.message).toContain("NETWORK_ERROR");
    expect(err.message).not.toContain("ECONNREFUSED");
    expect(err.message).not.toContain("127.0.0.1");

    stubFetch(200, "not json");
    const bodyErr = await rejection(testRun);
    expect(bodyErr.message).not.toContain("not json");
    expect(bodyErr.message).toMatch(/unreadable response/i);
  });
});

describe("connectorHttpError()", () => {
  it("only forwards allow-listed HTTP 400 policy denials verbatim", () => {
    expect(connectorHttpError(400, JSON.stringify({ error: "Shell metacharacters are not allowed." })).message).toBe(
      "Shell metacharacters are not allowed."
    );
    expect(connectorHttpError(400, JSON.stringify({ error: FS_ERROR.error })).message).not.toContain("ENOENT");
    expect(connectorHttpError(500, JSON.stringify(FS_ERROR)).message).not.toContain("ENOENT");
    expect(connectorHttpError(403, JSON.stringify(ORIGIN_DETAIL)).message).not.toContain("evil.example.com");
    expect(connectorHttpError(404, JSON.stringify(ENDPOINT_LIST)).message).not.toContain("/v1/models");
  });
});
