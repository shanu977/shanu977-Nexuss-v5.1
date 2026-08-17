import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryBridge } from "@/workspace/bridge";
import { buildIndex } from "@/workspace/indexer";
import { ToolError } from "@/workspace/agent/errors";
import {
  assertValidPath,
  toolProposeCreate,
  toolProposeDelete,
  toolProposeMove,
  toolProposeUpsert,
  toolProposeWrite,
  toolRead,
  toolRun,
  toolSearch,
  toolTest
} from "@/workspace/agent/tools";
import type {
  NativeCapabilities,
  NativeCommandResult,
  NativeRuntimeBridge,
  NativeTestResult,
  ToolContext
} from "@/workspace/agent/types";

const DEFAULT_CAPS: NativeCapabilities = {
  read: true,
  search: true,
  write: true,
  create: true,
  rename: true,
  move: true,
  delete: true,
  run: true,
  test: true
};

const FILES: Record<string, string> = {
  "README.md": "# Demo\n",
  "src/auth/login.ts":
    "export function login(username: string, password: string) { return true; }\n",
  "src/utils/format.ts":
    "export function formatDate(ts: number) { return String(ts); }\n",
  "server/api.py": "from fastapi import FastAPI\napp = FastAPI()\n"
};

let bridge: InMemoryBridge;
let ctx: ToolContext;

beforeEach(async () => {
  bridge = new InMemoryBridge("demo", FILES);
  const files = (await bridge.list()).map((s) => ({
    path: s.path,
    size: s.size,
    mtime: s.mtime,
    content: s.content
  }));
  ctx = { connected: true, bridge, index: buildIndex("demo", files), runtime: null };
});

function expectToolError(
  fn: () => Promise<unknown> | unknown,
  code: string
): Promise<void> {
  return expect(fn()).rejects.toMatchObject({ code });
}

describe("assertValidPath", () => {
  it("normalizes backslashes and dot segments", () => {
    expect(assertValidPath("src\\auth\\login.ts")).toBe("src/auth/login.ts");
    expect(assertValidPath("./src/./utils/format.ts")).toBe("src/utils/format.ts");
  });

  it("rejects absolute paths", () => {
    expect(() => assertValidPath("C:\\Windows\\evil.ts")).toThrow(ToolError);
    expect(() => assertValidPath("/etc/passwd")).toThrow(ToolError);
  });

  it("rejects traversal escaping the root", () => {
    expect(() => assertValidPath("../secret.ts")).toThrow(ToolError);
    expect(() => assertValidPath("a/../../secret.ts")).toThrow(ToolError);
  });

  it("rejects empty paths", () => {
    expect(() => assertValidPath("")).toThrow(ToolError);
  });
});

describe("toolRead", () => {
  it("reads a file through the bridge and reports its hash", async () => {
    const res = await toolRead(ctx, "src/auth/login.ts");
    expect(res.content).toBe(FILES["src/auth/login.ts"]);
    expect(res.size).toBe(FILES["src/auth/login.ts"].length);
    expect(res.hash).toHaveLength(8);
    // Hash is stable for the same content.
    expect((await toolRead(ctx, "src/auth/login.ts")).hash).toBe(res.hash);
  });

  it("throws FILE_NOT_FOUND for a missing file", async () => {
    await expectToolError(() => toolRead(ctx, "nope.ts"), "FILE_NOT_FOUND");
  });

  it("throws WORKSPACE_NOT_CONNECTED without a workspace", async () => {
    await expectToolError(
      () => toolRead({ connected: false, bridge: null, index: null, runtime: null }, "a.ts"),
      "WORKSPACE_NOT_CONNECTED"
    );
  });
});

describe("toolSearch", () => {
  it("finds files by name/symbol and caps results", () => {
    const refs = toolSearch(ctx, "login", { maxResults: 5 });
    expect(refs.some((r) => r.path === "src/auth/login.ts")).toBe(true);
    expect(refs.length).toBeLessThanOrEqual(5);
  });

  it("filters by directory path", () => {
    const refs = toolSearch(ctx, "function", { path: "src/utils" });
    expect(refs.some((r) => r.path === "src/utils/format.ts")).toBe(true);
    expect(refs.some((r) => r.path === "src/auth/login.ts")).toBe(false);
  });

  it("returns an empty list for no workspace index", () => {
    expect(toolSearch({ connected: true, bridge, index: null, runtime: null }, "login")).toEqual([]);
  });

  it("throws when the workspace is not connected", () => {
    expect(() =>
      toolSearch({ connected: false, bridge: null, index: null, runtime: null }, "login")
    ).toThrow(ToolError);
  });
});

describe("toolProposeWrite", () => {
  it("stages a diff without touching the file", async () => {
    const proposal = await toolProposeWrite(ctx, "README.md", "# Updated\n");
    expect(proposal.kind).toBe("write");
    expect(proposal.after).toBe("# Updated\n");
    expect(proposal.before).toBe(FILES["README.md"]);
    expect(proposal.diff).toContain("-"+FILES["README.md"].trim());
    expect(proposal.diff).toContain("+# Updated");
    // Nothing was written: the bridge still holds the original content.
    expect(await bridge.read("README.md")).toBe(FILES["README.md"]);
  });

  it("throws FILE_NOT_FOUND when the file does not exist", async () => {
    await expectToolError(() => toolProposeWrite(ctx, "missing.ts", "x"), "FILE_NOT_FOUND");
  });

  it("throws UNSUPPORTED_FILE for a non-text file", async () => {
    await expectToolError(() => toolProposeWrite(ctx, "logo.png", "x"), "UNSUPPORTED_FILE");
  });

  it("throws PATH_OUTSIDE_WORKSPACE for traversal", async () => {
    await expectToolError(
      () => toolProposeWrite(ctx, "../outside.ts", "x"),
      "PATH_OUTSIDE_WORKSPACE"
    );
  });
});

describe("toolProposeCreate", () => {
  it("stages a create with an empty before", async () => {
    const proposal = await toolProposeCreate(ctx, "src/new.ts", "export const x = 1;\n");
    expect(proposal.kind).toBe("create");
    expect(proposal.before).toBe("");
    expect(proposal.after).toBe("export const x = 1;\n");
    expect(proposal.diff).toContain("+export const x = 1;");
    // Nothing created until approval.
    await expectToolError(() => toolRead(ctx, "src/new.ts"), "FILE_NOT_FOUND");
  });

  it("throws FILE_EXISTS when the path already exists", async () => {
    await expectToolError(
      () => toolProposeCreate(ctx, "README.md", "x"),
      "FILE_EXISTS"
    );
  });
});

describe("toolProposeUpsert", () => {
  it("stages a write when the file exists", async () => {
    const proposal = await toolProposeUpsert(ctx, "README.md", "# Upserted\n");
    expect(proposal.kind).toBe("write");
  });

  it("stages a create when the file is missing", async () => {
    const proposal = await toolProposeUpsert(ctx, "src/added.ts", "let a = 1;\n");
    expect(proposal.kind).toBe("create");
  });
});

describe("toolProposeDelete", () => {
  it("stages a delete with the full content as before", async () => {
    const proposal = await toolProposeDelete(ctx, "README.md");
    expect(proposal.kind).toBe("delete");
    expect(proposal.after).toBe("");
    expect(proposal.before).toBe(FILES["README.md"]);
    expect(await bridge.read("README.md")).toBe(FILES["README.md"]);
  });

  it("throws FILE_NOT_FOUND for a missing file", async () => {
    await expectToolError(() => toolProposeDelete(ctx, "missing.ts"), "FILE_NOT_FOUND");
  });
});

describe("toolProposeMove", () => {
  it("stages a move and checks the target is free", async () => {
    const proposal = await toolProposeMove(ctx, "src/auth/login.ts", "src/auth/login2.ts");
    expect(proposal.kind).toBe("move");
    expect(proposal.toPath).toBe("src/auth/login2.ts");
  });

  it("throws FILE_EXISTS when the target exists", async () => {
    await expectToolError(
      () => toolProposeMove(ctx, "src/auth/login.ts", "src/utils/format.ts"),
      "FILE_EXISTS"
    );
  });

  it("throws PATH_OUTSIDE_WORKSPACE for an escaping target", async () => {
    await expectToolError(
      () => toolProposeMove(ctx, "src/auth/login.ts", "../out.ts"),
      "PATH_OUTSIDE_WORKSPACE"
    );
  });
});

describe("toolRun / toolTest", () => {
  it("report NATIVE_BRIDGE_UNAVAILABLE without a native runtime", async () => {
    await expectToolError(() => toolRun(ctx, "npm test"), "NATIVE_BRIDGE_UNAVAILABLE");
    await expectToolError(() => toolTest(ctx), "NATIVE_BRIDGE_UNAVAILABLE");
  });

  function runtimeWith(caps: Partial<NativeCapabilities>): NativeRuntimeBridge {
    return {
      run: vi.fn(async (): Promise<NativeCommandResult> => ({
        command: "npm test",
        cwd: "",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 12,
        timedOut: false,
        killed: false,
        signal: null,
        success: true,
        outputTruncated: false,
        redacted: false
      })),
      test: vi.fn(async (): Promise<NativeTestResult> => ({
        command: "npm test",
        cwd: "",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 12,
        timedOut: false,
        killed: false,
        signal: null,
        success: true,
        outputTruncated: false,
        redacted: false,
        plan: { command: "npm test", source: "package.json", confidence: "high" as const }
      })),
      capabilities: () => ({ ...DEFAULT_CAPS, ...caps })
    };
  }

  it("throws NOT_SUPPORTED when the runtime reports run unavailable", async () => {
    const runtime = runtimeWith({ run: false });
    await expectToolError(
      () => toolRun({ connected: true, bridge, index: null, runtime }, "npm test"),
      "NOT_SUPPORTED"
    );
  });

  it("throws NOT_SUPPORTED when the runtime reports test unavailable", async () => {
    const runtime = runtimeWith({ test: false });
    await expectToolError(
      () => toolTest({ connected: true, bridge, index: null, runtime }),
      "NOT_SUPPORTED"
    );
  });

  it("routes a validated run to the native runtime", async () => {
    const runtime = runtimeWith({});
    const res = await toolRun(
      { connected: true, bridge, index: null, runtime },
      "npm test"
    );
    expect(runtime.run).toHaveBeenCalledWith({ command: "npm test", cwd: "" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("ok");
  });

  it("routes a test run to the native runtime and returns its plan", async () => {
    const runtime = runtimeWith({});
    const res = await toolTest({ connected: true, bridge, index: null, runtime });
    expect(runtime.test).toHaveBeenCalledWith({ cwd: "" });
    expect(res.plan?.source).toBe("package.json");
  });

  it("rejects a run whose cwd escapes the workspace before touching the runtime", async () => {
    const runtime = runtimeWith({});
    await expectToolError(
      () => toolRun({ connected: true, bridge, index: null, runtime }, "npm test", { cwd: "../out" }),
      "PATH_OUTSIDE_WORKSPACE"
    );
    expect(runtime.run).not.toHaveBeenCalled();
  });
});