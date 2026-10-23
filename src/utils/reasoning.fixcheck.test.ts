import { describe, expect, it } from "vitest";
import { filterReasoning, ReasoningFilter } from "./reasoning";

const cases: [string, string, string][] = [
  [
    "numbered answer list with Result heading",
    "Here is the fix:\n\n1. Stop the service.\n2. Run the migration.\n3. Restart.\n\nSummary: applied the fix in 3 steps.",
    "Here is the fix:\n\n1. Stop the service.\n2. Run the migration.\n3. Restart.\n\nSummary: applied the fix in 3 steps.",
  ],
  [
    "Plan heading does not swallow answer",
    "Plan:\n- update config\n- restart server\n\nResult: the server is healthy again.",
    "Plan:\n- update config\n- restart server\n\nResult: the server is healthy again.",
  ],
  [
    "internal CoT heading still stripped",
    "Strategy: pick a friendly greeting\nDraft: say hello\nFinal Output Generation -> \"Hello! How can I help you today?\"",
    "Hello! How can I help you today?",
  ],
  [
    "reasoning block markers still stripped",
    " thinking\ninternal analysis\n response\nThe exit code is 1.",
    "The exit code is 1.",
  ],
  [
    "decision heading with answer kept",
    "Decision: the bug is in chatStore, not the backend.",
    "Decision: the bug is in chatStore, not the backend.",
  ],
  [
    "multi-line context answer preserved",
    "You asked about the terminal error. Here is what happened:\n\nSummary: the shell exited with code 1 because npm was not found.",
    "You asked about the terminal error. Here is what happened:\n\nSummary: the shell exited with code 1 because npm was not found.",
  ],
];

describe("reasoning filter keeps real answers (regression)", () => {
  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(filterReasoning(input)).toBe(expected);
    });
  }

  it("chunked push matches batch result", () => {
    const input =
      "Strategy: plan\nDraft: write\nFinal Output Generation -> \"Hi! What are we building today?\"";
    const f = new ReasoningFilter();
    let out = "";
    for (const ch of input.match(/[\s\S]{1,7}/g) ?? []) out += f.push(ch);
    out += f.flush();
    expect(out).toBe("Hi! What are we building today?");
  });

  it("streaming never freezes after a planning heading", () => {
    const f = new ReasoningFilter();
    let out = "";
    out += f.push("Strategy: think first.\n");
    out += f.push("Now the real answer.\n");
    out += f.flush();
    expect(out).toContain("Now the real answer.");
  });

  it("does not extract greeting when no deliberation leaked", () => {
    expect(filterReasoning("Hello! How can I help you with your code today?")).toBe(
      "Hello! How can I help you with your code today?"
    );
  });

  it("keeps long context-rich reply intact", () => {
    const reply = [
      "The Nexus connector failed because the token expired at 14:02 UTC.",
      "",
      "Next steps:",
      "1. Open the connector settings.",
      "2. Paste a fresh token.",
      "3. Reconnect and check the status light.",
      "",
      "Result: reconnection should succeed immediately after saving the token.",
    ].join("\n");
    expect(filterReasoning(reply)).toBe(reply);
  });
});
