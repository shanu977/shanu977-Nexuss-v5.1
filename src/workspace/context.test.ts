import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_BUDGET,
  WORKSPACE_CONTEXT_HEADER,
  WORKSPACE_MANIFEST_HEADER,
  WORKSPACE_STATUS_HEADER,
  buildAmbiguityContext,
  buildContextText,
  buildDisconnectedContext,
  buildFileContext,
  buildManifestContext,
  buildStatusContext,
  estimateTokens
} from "@/workspace/context";
import { buildIndex } from "@/workspace/indexer";
import { buildManifest } from "@/workspace/manifest";
import type { WorkspaceIndex } from "@/workspace/types";

function makeIndex(): WorkspaceIndex {
  return buildIndex("root", [
    {
      path: "src/auth/login.ts",
      size: 0,
      mtime: 1,
      content: [
        "import { validateToken } from \"./token\";",
        "",
        "export async function login(username: string, password: string) {",
        "  if (!username) throw new Error(\"missing username\");",
        "  return validateToken(username, password);",
        "}"
      ].join("\n")
    },
    {
      path: "src/auth/token.ts",
      size: 0,
      mtime: 1,
      content:
        "export async function validateToken(username: string, password: string): Promise<string | null> {\n  return password.length >= 8 ? \"ok\" : null;\n}\n"
    },
    {
      path: "src/utils/format.ts",
      size: 0,
      mtime: 1,
      content:
        "export function formatDate(ts: number): string {\n  return new Date(ts).toLocaleDateString();\n}\n"
    }
  ]);
}

describe("estimateTokens", () => {
  it("matches the backend's CJK-aware estimate", () => {
    expect(estimateTokens("hello world")).toBe(3);
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("")).toBe(0);
    // CJK ~1 token/char, Latin ~4 chars/token, consistent with the backend.
    expect(estimateTokens("hello 世界")).toBe(4);
  });
});

describe("buildContextText", () => {
  it("produces a header plus the mentioned file", () => {
    const result = buildContextText(makeIndex(), "why does login.ts fail", {
      maxTokens: 5000,
      maxFiles: 20
    });
    expect(result.contextText.startsWith(WORKSPACE_CONTEXT_HEADER)).toBe(true);
    expect(result.contextText).toContain("### src/auth/login.ts");
    expect(result.includedFiles).toContain("src/auth/login.ts");
    expect(result.estimatedTokens).toBeLessThan(5000);
  });

  it("includes multiple relevant files when they fit", () => {
    const result = buildContextText(makeIndex(), "validateToken login", {
      maxTokens: 5000,
      maxFiles: 20
    });
    expect(result.includedFiles).toContain("src/auth/token.ts");
    expect(result.includedFiles).toContain("src/auth/login.ts");
  });

  it("never exceeds the token budget", () => {
    const index = buildIndex("root", [
      { path: "big.ts", size: 0, mtime: 1, content: "export const big = '" + "x".repeat(5000) + "';" }
    ]);
    const result = buildContextText(index, "big", { maxTokens: 200, maxFiles: 20 });
    expect(result.estimatedTokens).toBeLessThanOrEqual(200);
    expect(result.truncated).toBe(true);
  });

  it("returns empty context when nothing matches", () => {
    const result = buildContextText(makeIndex(), "zzzznomatch", {
      maxTokens: 5000,
      maxFiles: 20
    });
    expect(result.contextText).toBe("");
    expect(result.includedFiles).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("calls out truncation when the budget cuts the selection", () => {
    const index = buildIndex("root", [
      {
        path: "alpha.ts",
        size: 0,
        mtime: 1,
        content: "export const alpha = '" + "x".repeat(2000) + "';"
      },
      {
        path: "beta.ts",
        size: 0,
        mtime: 1,
        content: "export const beta = '" + "y".repeat(2000) + "';"
      }
    ]);
    const result = buildContextText(index, "alpha beta", { maxTokens: 100, maxFiles: 20 });
    expect(result.truncated).toBe(true);
    expect(result.includedFiles.length).toBeLessThanOrEqual(2);
    expect(result.estimatedTokens).toBeLessThanOrEqual(100);
  });

  it("uses the default budget when none is given", () => {
    const result = buildContextText(makeIndex(), "login");
    expect(result.estimatedTokens).toBeLessThanOrEqual(
      DEFAULT_CONTEXT_BUDGET.maxTokens
    );
  });
});

describe("buildStatusContext", () => {
  it("reports the connected workspace and indexed count", () => {
    const result = buildStatusContext(
      { name: "myapp", root: "myapp", kind: "in-memory" },
      makeIndex()
    );
    expect(result.contextText.startsWith(WORKSPACE_STATUS_HEADER)).toBe(true);
    expect(result.contextText).toContain('workspace "myapp" is connected');
    expect(result.contextText).toContain("3 files are indexed");
    expect(result.includedFiles).toEqual([]);
  });

  it("handles an empty index without inventing a count", () => {
    const result = buildStatusContext(
      { name: "empty", root: "empty", kind: "in-memory" },
      null
    );
    expect(result.contextText).toContain("no files could be indexed");
  });
});

describe("buildManifestContext", () => {
  const workspace = { name: "myapp", root: "myapp", kind: "in-memory" as const };

  it("lists directories and files under the manifest header", () => {
    const index = makeIndex();
    const manifest = buildManifest(index);
    const result = buildManifestContext(workspace, manifest);
    expect(result.contextText.startsWith(WORKSPACE_MANIFEST_HEADER)).toBe(true);
    expect(result.contextText).toContain("Total files: 3");
    expect(result.contextText).toContain("src/auth");
    expect(result.contextText).toContain("src/utils");
    expect(result.contextText).toContain("src/auth/login.ts");
    expect(result.includedFiles).toEqual(manifest.files);
  });

  it("caps the file list to the token budget", () => {
    const files: Record<string, string> = {};
    const paths: string[] = [];
    for (let i = 0; i < 200; i++) {
      const p = `src/mod${i}/file${i}.ts`;
      paths.push(p);
      files[p] = "export const a = 1;\n";
    }
    const manifest = buildManifest(buildIndex("root", Object.entries(files).map(([path, content]) => ({ path, size: 0, mtime: 1, content }))));
    const result = buildManifestContext(workspace, manifest, { maxTokens: 300, maxFiles: 20 });
    expect(result.estimatedTokens).toBeLessThanOrEqual(300);
    expect(result.truncated).toBe(true);
    expect(result.contextText).toContain("more files not listed");
  });
});

describe("buildFileContext", () => {
  it("returns the referenced file whole when it fits the budget", () => {
    const index = makeIndex();
    const result = buildFileContext(index, "src/auth/login.ts", "What does it do?");
    expect(result).not.toBeNull();
    expect(result!.includedFiles).toEqual(["src/auth/login.ts"]);
    expect(result!.contextText).toContain("### src/auth/login.ts");
    expect(result!.contextText).toContain("export async function login");
    expect(result!.estimatedTokens).toBeLessThanOrEqual(
      DEFAULT_CONTEXT_BUDGET.maxTokens
    );
  });

  it("returns null for an unknown file", () => {
    const result = buildFileContext(makeIndex(), "nope.ts", "question");
    expect(result).toBeNull();
  });

  it("stays within the token budget for a large file", () => {
    const index = buildIndex("root", [
      {
        path: "big.ts",
        size: 0,
        mtime: 1,
        content: "export const big = '" + "x".repeat(5000) + "';"
      }
    ]);
    const result = buildFileContext(index, "big.ts", "big", {
      maxTokens: 200,
      maxFiles: 20
    });
    expect(result).not.toBeNull();
    expect(result!.estimatedTokens).toBeLessThanOrEqual(200);
    expect(result!.truncated).toBe(true);
  });
});

describe("buildAmbiguityContext", () => {
  it("instructs the model to ask which file and lists candidates", () => {
    const result = buildAmbiguityContext(
      { name: "myapp", root: "myapp", kind: "in-memory" },
      ["a.ts", "b.ts"]
    );
    expect(result.contextText).toMatch(/which file/i);
    expect(result.contextText).toContain("a.ts");
    expect(result.contextText).toContain("b.ts");
    expect(result.includedFiles).toEqual(["a.ts", "b.ts"]);
  });
});

describe("buildDisconnectedContext", () => {
  it("reports that no folder is connected", () => {
    const result = buildDisconnectedContext();
    expect(result.contextText).toMatch(/no folder/i);
    expect(result.includedFiles).toEqual([]);
  });
});