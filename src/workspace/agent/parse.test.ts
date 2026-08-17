import { describe, expect, it } from "vitest";
import {
  extractChangeBlock,
  stripChangeBlock,
  extractCommandBlock,
  stripCommandBlock
} from "@/workspace/agent/parse";

describe("extractChangeBlock", () => {
  it("returns null when there is no workspace-change fence", () => {
    expect(extractChangeBlock("just a normal reply")).toBeNull();
    expect(extractChangeBlock("```json\n{...}\n```")).toBeNull();
  });

  it("parses a valid single-change block", () => {
    const reply = [
      "I can fix that.",
      "```workspace-change",
      '{"changes":[{"path":"src/api.py","content":"new content"}]}',
      "```"
    ].join("\n");
    const block = extractChangeBlock(reply);
    expect(block).not.toBeNull();
    expect(block?.changes).toHaveLength(1);
    expect(block?.changes[0].path).toBe("src/api.py");
    expect(block?.changes[0].content).toBe("new content");
  });

  it("is case-insensitive for the fence tag", () => {
    const reply =
      "```Workspace-Change\n{\"changes\":[{\"path\":\"a.ts\",\"content\":\"x\"}]}\n```";
    expect(extractChangeBlock(reply)).not.toBeNull();
  });

  it("ignores malformed JSON inside the fence", () => {
    expect(extractChangeBlock("```workspace-change\nnot json\n```")).toBeNull();
  });

  it("ignores a block without a changes array", () => {
    expect(
      extractChangeBlock("```workspace-change\n{\"foo\":1}\n```")
    ).toBeNull();
    expect(
      extractChangeBlock("```workspace-change\n{\"changes\":[]}\n```")
    ).toBeNull();
  });

  it("drops changes with invalid or escaping paths", () => {
    const reply = [
      "```workspace-change",
      JSON.stringify({
        changes: [
          { path: "../escape.ts", content: "x" },
          { path: "/absolute.ts", content: "x" },
          { path: "C:\\Windows\\evil.ts", content: "x" },
          { path: "src/ok.ts", content: "y" }
        ]
      }),
      "```"
    ].join("\n");
    const block = extractChangeBlock(reply);
    expect(block?.changes).toHaveLength(1);
    expect(block?.changes[0].path).toBe("src/ok.ts");
  });

  it("drops changes to ignored or unsupported files", () => {
    const reply = [
      "```workspace-change",
      JSON.stringify({
        changes: [
          { path: "node_modules/x.js", content: "x" },
          { path: "secret.env", content: "x" },
          { path: "src/ok.ts", content: "y" }
        ]
      }),
      "```"
    ].join("\n");
    const block = extractChangeBlock(reply);
    expect(block?.changes).toHaveLength(1);
    expect(block?.changes[0].path).toBe("src/ok.ts");
  });

  it("rejects content larger than 1MB", () => {
    const reply =
      "```workspace-change\n{\"changes\":[{\"path\":\"a.ts\",\"content\":\"" +
      "x".repeat(1024 * 1024 + 1) +
      "\"}]}\n```";
    expect(extractChangeBlock(reply)).toBeNull();
  });
});

describe("stripChangeBlock", () => {
  it("removes the fence and leaves the surrounding reply", () => {
    const reply = [
      "I can fix that.",
      "```workspace-change",
      "{\"changes\":[]}",
      "```",
      "See the panel."
    ].join("\n");
    const stripped = stripChangeBlock(reply);
    expect(stripped).toContain("I can fix that.");
    expect(stripped).toContain("See the panel.");
    expect(stripped).not.toContain("workspace-change");
    expect(stripped).not.toContain("changes");
  });

  it("returns an empty string when the whole reply was the block", () => {
    expect(
      stripChangeBlock("```workspace-change\n{\"changes\":[]}\n```")
    ).toBe("");
  });

  it("does not strip normal code fences", () => {
    const reply = "Here:\n```ts\nconst a = 1;\n```";
    expect(stripChangeBlock(reply)).toBe(reply);
  });
});

describe("extractCommandBlock", () => {
  it("returns null without a workspace-command fence", () => {
    expect(extractCommandBlock("plain reply")).toBeNull();
    expect(extractCommandBlock("```json\n{\"run\":{}}\n```")).toBeNull();
  });

  it("parses a run request", () => {
    const reply = [
      "Run this:",
      "```workspace-command",
      '{"run":{"command":"npm test","cwd":"src/server"}}',
      "```"
    ].join("\n");
    const block = extractCommandBlock(reply);
    expect(block?.run?.command).toBe("npm test");
    expect(block?.run?.cwd).toBe("src/server");
    expect(block?.test).toBeUndefined();
  });

  it("parses a test request as boolean or object", () => {
    const reply = "```workspace-command\n{\"test\":true}\n```";
    expect(extractCommandBlock(reply)?.test).toEqual({});
    const reply2 = "```workspace-command\n{\"test\":{\"cwd\":\"sub\"}}\n```";
    expect(extractCommandBlock(reply2)?.test?.cwd).toBe("sub");
  });

  it("normalizes cwd and drops escaping cwd", () => {
    const block = extractCommandBlock(
      "```workspace-command\n{\"run\":{\"command\":\"go test ./...\",\"cwd\":\"..\"}}\n```"
    );
    expect(block?.run).toBeUndefined();
  });

  it("rejects malformed or empty blocks", () => {
    expect(extractCommandBlock("```workspace-command\nnot json\n```")).toBeNull();
    expect(extractCommandBlock("```workspace-command\n{}\n```")).toBeNull();
    expect(extractCommandBlock("```workspace-command\n{\"run\":{\"command\":\"\"}}\n```")).toBeNull();
    expect(extractCommandBlock("```workspace-command\n{\"foo\":1}\n```")).toBeNull();
  });

  it("is case-insensitive for the fence tag", () => {
    expect(
      extractCommandBlock("```Workspace-Command\n{\"run\":{\"command\":\"npm test\"}}\n```")?.run
        ?.command
    ).toBe("npm test");
  });
});

describe("stripCommandBlock", () => {
  it("removes the block from a reply", () => {
    const reply = [
      "Check tests:",
      "```workspace-command",
      '{"test":true}',
      "```"
    ].join("\n");
    const stripped = stripCommandBlock(reply);
    expect(stripped).toBe("Check tests:");
    expect(stripped).not.toContain("workspace-command");
  });

  it("returns an empty string when the whole reply was the block", () => {
    expect(stripCommandBlock("```workspace-command\n{\"test\":true}\n```")).toBe("");
  });
});