import { describe, expect, it } from "vitest";
import { buildIndex } from "@/workspace/indexer";
import { resolveReference } from "@/workspace/references";
import type { WorkspaceIndex } from "@/workspace/types";

function makeIndex(): WorkspaceIndex {
  return buildIndex("root", [
    { path: "test.py", size: 0, mtime: 1, content: "def test():\n    pass\n" },
    { path: "src/auth/login.ts", size: 0, mtime: 1, content: "export function login() {}\n" },
    { path: "server/api.py", size: 0, mtime: 1, content: "app = object()\n" }
  ]);
}

const EMPTY = { lastSearchResults: [], lastReferencedFile: null };

describe("resolveReference", () => {
  it("resolves an explicit filename mention", () => {
    expect(resolveReference("open test.py", EMPTY, makeIndex())).toEqual({
      kind: "explicit-file",
      path: "test.py"
    });
  });

  it("returns ambiguous for multiple explicit file mentions", () => {
    expect(resolveReference("show login.ts and api.py", EMPTY, makeIndex())).toEqual({
      kind: "ambiguous",
      candidates: ["src/auth/login.ts", "server/api.py"]
    });
  });

  it("resolves ordinals against the last result list", () => {
    const refs = { lastSearchResults: ["a.ts", "b.ts", "c.ts"], lastReferencedFile: null };
    expect(resolveReference("open the first one", refs, null)).toEqual({
      kind: "ordinal",
      position: 1
    });
    expect(resolveReference("check the second file", refs, null)).toEqual({
      kind: "ordinal",
      position: 2
    });
    expect(resolveReference("open the last one", refs, null)).toEqual({
      kind: "ordinal",
      position: 3
    });
  });

  it("does not resolve ordinals without a result list", () => {
    expect(resolveReference("open the first one", EMPTY, null)).toEqual({ kind: "none" });
  });

  it("does not resolve ordinals out of range", () => {
    const refs = { lastSearchResults: ["a.ts"], lastReferencedFile: null };
    expect(resolveReference("open the second one", refs, null)).toEqual({ kind: "none" });
  });

  it("resolves 'inside it' to the workspace itself", () => {
    expect(resolveReference("What is inside it?", EMPTY, null)).toEqual({
      kind: "workspace-deictic"
    });
    expect(resolveReference("What files are in it?", EMPTY, null)).toEqual({
      kind: "workspace-deictic"
    });
  });

  it("resolves deictic references to the last referenced file", () => {
    const refs = { lastSearchResults: ["a.ts", "b.ts"], lastReferencedFile: "a.ts" };
    expect(resolveReference("What does it do?", refs, null)).toEqual({
      kind: "last-referenced"
    });
    expect(resolveReference("Fix this code", refs, null)).toEqual({
      kind: "last-referenced"
    });
  });

  it("resolves a deictic reference to the single previous result", () => {
    const refs = { lastSearchResults: ["a.ts"], lastReferencedFile: null };
    expect(resolveReference("open that file", refs, null)).toEqual({
      kind: "ordinal",
      position: 1
    });
  });

  it("asks for clarification when a deictic reference is ambiguous", () => {
    const refs = { lastSearchResults: ["a.ts", "b.ts"], lastReferencedFile: null };
    expect(resolveReference("open that file", refs, null)).toEqual({
      kind: "ambiguous",
      candidates: ["a.ts", "b.ts"]
    });
  });

  it("leaves ordinary chat alone", () => {
    expect(resolveReference("What is recursion?", EMPTY, null)).toEqual({ kind: "none" });
    expect(resolveReference("Explain binary search.", EMPTY, null)).toEqual({
      kind: "none"
    });
    expect(resolveReference("Write a poem.", EMPTY, null)).toEqual({ kind: "none" });
    expect(resolveReference("", EMPTY, null)).toEqual({ kind: "none" });
  });
});