import { describe, expect, it } from "vitest";
import { buildIndex } from "@/workspace/indexer";
import { buildManifest } from "@/workspace/manifest";

describe("buildManifest", () => {
  it("lists files and every ancestor directory, sorted", () => {
    const index = buildIndex("root", [
      { path: "src/auth/login.ts", size: 0, mtime: 1, content: "x" },
      { path: "src/auth/token.ts", size: 0, mtime: 1, content: "x" },
      { path: "src/utils/format.ts", size: 0, mtime: 1, content: "x" },
      { path: "package.json", size: 0, mtime: 1, content: "{}" }
    ]);
    const manifest = buildManifest(index);
    expect(manifest.root).toBe("root");
    expect(manifest.directories).toEqual(["src", "src/auth", "src/utils"]);
    expect(manifest.files).toEqual([
      "package.json",
      "src/auth/login.ts",
      "src/auth/token.ts",
      "src/utils/format.ts"
    ]);
  });

  it("handles a nested directory chain", () => {
    const index = buildIndex("root", [
      { path: "a/b/c/d/file.ts", size: 0, mtime: 1, content: "x" }
    ]);
    const manifest = buildManifest(index);
    expect(manifest.directories).toEqual(["a", "a/b", "a/b/c", "a/b/c/d"]);
  });

  it("returns an empty manifest for a null index", () => {
    expect(buildManifest(null)).toEqual({ root: "", directories: [], files: [] });
  });
});