import { describe, expect, it } from "vitest";
import {
  WorkspacePathError,
  assertInsideRoot,
  baseName,
  dirName,
  extName,
  isPathInside,
  joinRelative,
  normalizeRelativePath
} from "@/workspace/path";

describe("normalizeRelativePath", () => {
  it("normalizes backslash separators to forward slashes", () => {
    expect(normalizeRelativePath("src\\auth\\login.ts")).toBe("src/auth/login.ts");
  });

  it("resolves '.' and '..' inside the root", () => {
    expect(normalizeRelativePath("src/./auth/../auth/login.ts")).toBe(
      "src/auth/login.ts"
    );
  });

  it("returns an empty string for the root itself", () => {
    expect(normalizeRelativePath(".")).toBe("");
    expect(normalizeRelativePath("")).toBe("");
    expect(normalizeRelativePath("   ")).toBe("");
  });

  it("rejects absolute paths", () => {
    expect(() => normalizeRelativePath("C:\\Users\\me\\secret.txt")).toThrow(
      WorkspacePathError
    );
    expect(() => normalizeRelativePath("C:/Users/me/secret.txt")).toThrow(
      WorkspacePathError
    );
    expect(() => normalizeRelativePath("/etc/passwd")).toThrow(WorkspacePathError);
    expect(() => normalizeRelativePath("\\\\server\\share")).toThrow(
      WorkspacePathError
    );
  });

  it("rejects paths that escape the workspace root", () => {
    expect(() => normalizeRelativePath("../outside.txt")).toThrow(WorkspacePathError);
    expect(() => normalizeRelativePath("a/../../outside.txt")).toThrow(
      WorkspacePathError
    );
    expect(() => normalizeRelativePath("..\\outside.txt")).toThrow(
      WorkspacePathError
    );
  });

  it("rejects null bytes and traversal fragments", () => {
    expect(() => normalizeRelativePath("src\\..\\..\\etc\\passwd")).toThrow(
      WorkspacePathError
    );
  });
});

describe("isPathInside", () => {
  it("accepts paths at or beneath the root", () => {
    expect(isPathInside("", "src/auth/login.ts")).toBe(true);
    expect(isPathInside("src", "src/auth/login.ts")).toBe(true);
    expect(isPathInside("src", "src")).toBe(true);
  });

  it("rejects siblings and escapes", () => {
    expect(isPathInside("src", "other/file.ts")).toBe(false);
    expect(isPathInside("src", "srcx/file.ts")).toBe(false);
    expect(isPathInside("src", "../outside")).toBe(false);
    expect(isPathInside("src", "C:\\outside")).toBe(false);
  });
});

describe("assertInsideRoot", () => {
  it("passes for valid relative paths", () => {
    expect(() => assertInsideRoot("", "src/auth/login.ts")).not.toThrow();
  });

  it("rejects empty, absolute, and escaping paths", () => {
    expect(() => assertInsideRoot("", "")).toThrow(WorkspacePathError);
    expect(() => assertInsideRoot("", "../x")).toThrow(WorkspacePathError);
    expect(() => assertInsideRoot("", "C:\\x")).toThrow(WorkspacePathError);
    expect(() => assertInsideRoot("", "/x")).toThrow(WorkspacePathError);
  });
});

describe("joinRelative", () => {
  it("joins and normalizes parts", () => {
    expect(joinRelative("src", "auth", "..", "utils", "format.ts")).toBe(
      "src/utils/format.ts"
    );
  });
});

describe("name helpers", () => {
  it("splits dir/base/ext correctly", () => {
    expect(dirName("src/auth/login.ts")).toBe("src/auth");
    expect(baseName("src/auth/login.ts")).toBe("login.ts");
    expect(extName("src/auth/login.ts")).toBe(".ts");
    expect(extName("README.md")).toBe(".md");
    expect(extName("Makefile")).toBe("");
    expect(extName(".env")).toBe("");
    expect(baseName("src/auth/")).toBe("auth");
  });
});