import { describe, expect, it } from "vitest";
import {
  buildIndex,
  chunkText,
  contentHash,
  extractImports,
  extractSymbols,
  indexFile,
  isIgnoredPath,
  isSupportedFile,
  updateIndex
} from "@/workspace/indexer";

const TS_FILE = {
  path: "src/auth/login.ts",
  size: 0,
  mtime: 100,
  content: [
    "import { validateToken } from \"./token\";",
    "",
    "export interface LoginResult {",
    "  ok: boolean;",
    "  error?: string;",
    "}",
    "",
    "export async function login(username: string, password: string): Promise<LoginResult> {",
    "  if (!username) return { ok: false, error: \"missing\" };",
    "  return { ok: true };",
    "}",
    "",
    "const MAX_ATTEMPTS = 3;"
  ].join("\n")
};

describe("isSupportedFile / isIgnoredPath", () => {
  it("content-indexes supported text types only", () => {
    expect(isSupportedFile("src/auth/login.ts")).toBe(true);
    expect(isSupportedFile("server/api.py")).toBe(true);
    expect(isSupportedFile("README.md")).toBe(true);
    expect(isSupportedFile("logo.png")).toBe(false);
    expect(isSupportedFile("Makefile")).toBe(false);
  });

  it("never traverses ignored directories", () => {
    expect(isIgnoredPath("node_modules/pkg/index.ts")).toBe(true);
    expect(isIgnoredPath("src/.next/app.ts")).toBe(true);
    expect(isIgnoredPath(".git/config")).toBe(true);
    expect(isIgnoredPath("src/auth/login.ts")).toBe(false);
    expect(isIgnoredPath("package-lock.json")).toBe(true);
  });
});

describe("contentHash", () => {
  it("is deterministic and changes with content", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
    expect(contentHash("")).toBe("811c9dc5");
  });
});

describe("symbol and import extraction", () => {
  it("extracts functions, classes, interfaces, and consts from TS", () => {
    const symbols = extractSymbols(TS_FILE.content, ".ts");
    expect(symbols).toContain("login");
    expect(symbols).toContain("LoginResult");
    expect(symbols).toContain("MAX_ATTEMPTS");
  });

  it("extracts imports and requires", () => {
    expect(extractImports(TS_FILE.content, ".ts")).toEqual(["./token"]);
  });

  it("extracts python defs and classes", () => {
    const py = "import os\nfrom typing import List\n\nclass User:\n    pass\n\ndef login(u):\n    return u\n";
    const symbols = extractSymbols(py, ".py");
    expect(symbols).toContain("login");
    expect(symbols).toContain("User");
    const imports = extractImports(py, ".py");
    expect(imports).toContain("os");
    expect(imports).toContain("typing");
  });
});

describe("chunkText", () => {
  it("reproduces the original content when joined", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const content = lines.join("\n");
    expect(chunkText(content).join("\n")).toBe(content);
  });

  it("keeps individual long lines as their own chunk", () => {
    const long = "x".repeat(20000);
    const chunks = chunkText(long);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(long);
  });
});

describe("indexFile", () => {
  it("derives name/ext/language/dir/hash/symbols/chunks", () => {
    const indexed = indexFile(TS_FILE);
    expect(indexed.name).toBe("login.ts");
    expect(indexed.ext).toBe(".ts");
    expect(indexed.language).toBe("typescript");
    expect(indexed.dir).toBe("src/auth");
    expect(indexed.symbols).toContain("login");
    expect(indexed.chunks.length).toBeGreaterThan(0);
    expect(indexed.chunks.join("\n")).toBe(TS_FILE.content);
  });

  it("keeps binary/unsupported files as metadata-only", () => {
    const indexed = indexFile({ path: "assets/logo.png", size: 9000, mtime: 5 });
    expect(indexed.language).toBe("text");
    expect(indexed.chunks).toEqual([]);
    expect(indexed.symbols).toEqual([]);
  });
});

describe("buildIndex / updateIndex", () => {
  it("builds a searchable index", () => {
    const index = buildIndex("root", [
      TS_FILE,
      { path: "README.md", size: 5, mtime: 1, content: "# Hi" }
    ]);
    expect(index.files).toHaveLength(2);
    expect(index.byPath.get("src/auth/login.ts")?.symbols).toContain("login");
    expect(index.scannedCount).toBe(2);
  });

  it("skips unnormalizable paths", () => {
    const index = buildIndex("root", [
      { path: "../escape.ts", size: 1, mtime: 1, content: "x" },
      { path: "ok.ts", size: 1, mtime: 1, content: "export const a = 1;" }
    ]);
    expect(index.files).toHaveLength(1);
  });

  it("is incremental: unchanged files are reused, changes re-indexed", () => {
    const files = [
      { path: "a.ts", size: 10, mtime: 1, content: "export const a = 1;" },
      { path: "b.ts", size: 10, mtime: 2, content: "export const b = 2;" }
    ];
    const index = buildIndex("root", files);

    // Identical listing -> nothing changes.
    const noop = updateIndex(index, files);
    expect(noop.changedCount).toBe(0);
    expect(noop.files).toHaveLength(2);

    // Content change on a.ts -> only a.ts re-indexed.
    const changed = updateIndex(index, [
      { ...files[0], content: "export const a = 99;" },
      files[1]
    ]);
    expect(changed.changedCount).toBe(1);
    expect(changed.byPath.get("a.ts")?.symbols).toEqual(["a"]);
    expect(changed.byPath.get("b.ts")).toBe(index.byPath.get("b.ts"));

    // New file added and a removed file dropped.
    const grown = updateIndex(changed, [
      { ...files[0], content: "export const a = 99;" },
      { path: "c.ts", size: 3, mtime: 3, content: "export const c = 3;" }
    ]);
    expect(grown.byPath.has("b.ts")).toBe(false);
    expect(grown.byPath.has("c.ts")).toBe(true);
    expect(grown.changedCount).toBe(2); // removed b.ts + added c.ts
  });
});