import { describe, expect, it } from "vitest";
import { createUnifiedDiff, diffLines, splitLines } from "@/workspace/agent/diff";

describe("splitLines", () => {
  it("returns [] for an empty string", () => {
    expect(splitLines("")).toEqual([]);
  });

  it("normalizes CRLF", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });
});

describe("diffLines", () => {
  it("returns an empty op list for identical input", () => {
    expect(diffLines(["a", "b"], ["a", "b"])).toEqual([
      { type: "eq", text: "a" },
      { type: "eq", text: "b" }
    ]);
  });

  it("produces del/add ops for a line change", () => {
    expect(diffLines(["a", "b"], ["a", "c"])).toEqual([
      { type: "eq", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "c" }
    ]);
  });

  it("produces only adds when creating a file", () => {
    const ops = diffLines([], ["x", "y"]);
    expect(ops.every((o) => o.type === "add")).toBe(true);
    expect(ops).toHaveLength(2);
  });
});

describe("createUnifiedDiff", () => {
  it("returns an empty string when nothing changes", () => {
    expect(createUnifiedDiff("a.ts", "same", "same")).toBe("");
  });

  it("renders a standard unified diff with correct hunk header", () => {
    const diff = createUnifiedDiff("src/api.py", "app = FastAPI()\n", "app = FastAPI(title=\"x\")\n");
    expect(diff).toContain("--- a/src/api.py");
    expect(diff).toContain("+++ b/src/api.py");
    expect(diff).toContain("@@ -1,1 +1,1 @@");
    expect(diff).toContain("-app = FastAPI()");
    expect(diff).toContain('+app = FastAPI(title="x")');
  });

  it("shows a create as a fully-added diff", () => {
    const diff = createUnifiedDiff("new.ts", "", "export const a = 1;\n");
    expect(diff).toContain("@@ -1,0 +1,1 @@");
    expect(diff).toContain("+export const a = 1;");
    expect(diff).not.toContain("-export");
  });

  it("shows a delete as a fully-removed diff", () => {
    const diff = createUnifiedDiff("gone.ts", "bye\n", "");
    expect(diff).toContain("@@ -1,1 +1,0 @@");
    expect(diff).toContain("-bye");
  });

  it("handles a multi-hunk edit with line numbers", () => {
    const before = ["1", "2", "3", "4", "5"].join("\n");
    const after = ["1", "X", "3", "4", "Y"].join("\n");
    const diff = createUnifiedDiff("f.ts", before, after);
    expect(diff).toContain("@@ -2,1 +2,1 @@");
    expect(diff).toContain("-2");
    expect(diff).toContain("+X");
    expect(diff).toContain("-5");
    expect(diff).toContain("+Y");
  });

  it("degrades to a whole-replace diff for oversized inputs", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const diff = createUnifiedDiff("big.txt", big, big + "\nmore");
    expect(diff).toContain("--- a/big.txt");
    expect(diff).toContain("+more");
  });
});