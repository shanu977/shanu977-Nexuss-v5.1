import { describe, expect, it } from "vitest";
import { buildIndex } from "@/workspace/indexer";
import {
  findMentionedFiles,
  searchIndex,
  tokenize
} from "@/workspace/search";
import type { WorkspaceIndex } from "@/workspace/types";

function makeIndex(): WorkspaceIndex {
  return buildIndex("root", [
    {
      path: "src/auth/login.ts",
      size: 0,
      mtime: 100,
      content:
        "import { validateToken } from \"./token\";\nexport async function login(username: string, password: string) {\n  return validateToken(username, password);\n}\n"
    },
    {
      path: "src/auth/token.ts",
      size: 0,
      mtime: 200,
      content:
        "export async function validateToken(username: string, password: string): Promise<string | null> {\n  return password.length >= 8 ? \"ok\" : null;\n}\n"
    },
    {
      path: "src/utils/format.ts",
      size: 0,
      mtime: 300,
      content:
        "export function formatDate(ts: number): string {\n  return new Date(ts).toLocaleDateString();\n}\n"
    },
    {
      path: "server/api.py",
      size: 0,
      mtime: 400,
      content: "def login(payload):\n    return payload\n"
    }
  ]);
}

describe("tokenize", () => {
  it("splits on non-alphanumerics and drops single chars", () => {
    expect(tokenize("fix the login flow")).toEqual(["fix", "the", "login", "flow"]);
    expect(tokenize("GET /health")).toEqual(["get", "health"]);
  });
});

describe("findMentionedFiles", () => {
  it("finds files whose filename appears in the query", () => {
    const index = makeIndex();
    const mentioned = findMentionedFiles(index, "why does login.ts fail");
    expect(mentioned.map((f) => f.path)).toEqual(["src/auth/login.ts"]);
  });
});

describe("searchIndex", () => {
  it("returns nothing for an empty query", () => {
    expect(searchIndex(makeIndex(), "")).toEqual([]);
    expect(searchIndex(makeIndex(), "   ")).toEqual([]);
  });

  it("matches filenames and ranks them above path-only matches", () => {
    const index = makeIndex();
    const hits = searchIndex(index, "login");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].file.path).toBe("src/auth/login.ts");
    expect(hits[0].reasons).toContain("filename match");
  });

  it("matches symbols in the file", () => {
    const index = makeIndex();
    const hits = searchIndex(index, "validateToken");
    expect(hits.some((h) => h.file.path === "src/auth/token.ts")).toBe(true);
    expect(hits.find((h) => h.file.path === "src/auth/token.ts")?.reasons).toContain(
      "symbol match"
    );
  });

  it("matches content substrings", () => {
    const index = makeIndex();
    const hits = searchIndex(index, "toLocaleDateString");
    expect(hits[0].file.path).toBe("src/utils/format.ts");
    expect(hits[0].reasons).toContain("exact content match");
  });

  it("boosts explicitly mentioned files above content matches", () => {
    const index = makeIndex();
    const hits = searchIndex(index, "login");
    // The server/api.py login also matches by symbol; the file literally named
    // login.ts must rank first anyway.
    expect(hits[0].file.path).toBe("src/auth/login.ts");
  });

  it("boosts error-text matches", () => {
    const index = makeIndex();
    const hits = searchIndex(index, "some error", { errorText: "toLocaleDateString" });
    expect(hits[0].file.path).toBe("src/utils/format.ts");
    expect(hits[0].reasons).toContain("error text found");
  });

  it("supports explicit file and symbol overrides", () => {
    const index = makeIndex();
    const hits = searchIndex(index, "x", {
      explicitFiles: ["server/api.py"]
    });
    expect(hits[0].file.path).toBe("server/api.py");
    expect(hits[0].reasons).toContain("explicitly mentioned");
  });

  it("respects the result limit", () => {
    const index = makeIndex();
    expect(searchIndex(index, "the", { limit: 1 }).length).toBeLessThanOrEqual(1);
  });
});