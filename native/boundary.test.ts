// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NativeError } from "./errors";
import {
  assertCwdInsideRoot,
  isStrictlyInside,
  resolveInsideRoot
} from "./boundary";
import { makeFixture } from "./test-helpers";
import path from "node:path";

describe("resolveInsideRoot", () => {
  it("resolves the root itself and nested relative paths", () => {
    const fx = makeFixture();
    try {
      fx.write("a/b/note.txt", "hi");
      expect(resolveInsideRoot(fx.root, ".")).toBe(fx.root);
      expect(resolveInsideRoot(fx.root, "a")).toBe(
        path.join(fx.root, "a")
      );
      expect(resolveInsideRoot(fx.root, "a/b/note.txt")).toBe(
        path.join(fx.root, "a", "b", "note.txt")
      );
    } finally {
      fx.cleanup();
    }
  });

  it("rejects absolute paths and drive letters", () => {
    const fx = makeFixture();
    try {
      for (const bad of [
        "/etc/passwd",
        "C:\\Windows\\evil.exe",
        "C:/Users/x",
        "\\\\server\\share\\x"
      ]) {
        expect(() => resolveInsideRoot(fx.root, bad)).toThrowError(NativeError);
      }
    } finally {
      fx.cleanup();
    }
  });

  it("rejects traversal that escapes the root", () => {
    const fx = makeFixture();
    try {
      for (const bad of ["../x", "a/../../x", ".."]) {
        expect(() => resolveInsideRoot(fx.root, bad)).toThrowError(NativeError);
      }
    } finally {
      fx.cleanup();
    }
  });

  it("rejects paths that do not exist", () => {
    const fx = makeFixture();
    try {
      expect(() => resolveInsideRoot(fx.root, "missing/dir")).toThrowError(
        NativeError
      );
    } finally {
      fx.cleanup();
    }
  });
});

describe("isStrictlyInside", () => {
  it("is true for children and the root itself, false for siblings/parents", () => {
    const fx = makeFixture();
    try {
      expect(isStrictlyInside(fx.root, path.join(fx.root, "a"))).toBe(true);
      expect(isStrictlyInside(fx.root, fx.root)).toBe(true);
      expect(isStrictlyInside(fx.root, path.dirname(fx.root))).toBe(false);
      expect(
        isStrictlyInside(fx.root, path.join(fx.root, "..", "evil"))
      ).toBe(false);
    } finally {
      fx.cleanup();
    }
  });
});

describe("assertCwdInsideRoot", () => {
  it("defaults to the workspace root", () => {
    const fx = makeFixture();
    try {
      expect(assertCwdInsideRoot(fx.root)).toBe(fx.root);
      expect(assertCwdInsideRoot(fx.root, "  ")).toBe(fx.root);
    } finally {
      fx.cleanup();
    }
  });

  it("throws WORKSPACE_NOT_CONNECTED without a root", () => {
    expect(() => assertCwdInsideRoot("", "sub")).toThrowError(NativeError);
  });
});
