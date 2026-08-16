import { describe, expect, it } from "vitest";
import { filterReasoning, ReasoningFilter } from "@/utils/reasoning";

function streamChunks(chunks: string[]): string {
  const filter = new ReasoningFilter();
  let out = "";
  for (const chunk of chunks) {
    out += filter.push(chunk);
  }
  out += filter.flush();
  return out;
}

describe("filterReasoning", () => {
  it("1. leaves a normal response without reasoning unchanged", () => {
    expect(filterReasoning("Hello")).toBe("Hello");
    expect(filterReasoning("The sky is blue.\nThat is the answer.")).toBe(
      "The sky is blue.\nThat is the answer."
    );
  });

  it("2. removes a complete thinking...response reasoning block", () => {
    const raw = [
      " thinking",
      "Here's a thinking process that leads to the suggested answer:",
      "1. Analyze the request.",
      "2. Look at the screenshot.",
      " response",
      "Final answer."
    ].join("\n");
    expect(filterReasoning(raw)).toBe("Final answer.");
  });

  it("handles multiple reasoning blocks, keeping every answer portion", () => {
    const raw = [
      " thinking",
      "reasoning 1",
      " response",
      "Answer 1",
      "",
      " thinking",
      "reasoning 2",
      " response",
      "Answer 2"
    ].join("\n");
    expect(filterReasoning(raw)).toBe("Answer 1\n\nAnswer 2");
  });

  it("keeps answer text that appears before a later reasoning block", () => {
    const raw = [
      "Preamble.",
      "",
      " thinking",
      "internal reasoning",
      " response",
      "Main answer."
    ].join("\n");
    expect(filterReasoning(raw)).toBe("Preamble.\n\nMain answer.");
  });

  it("removes angle-bracket reasoning tags", () => {
    expect(filterReasoning("<thinking>step by step</thinking>Final answer.")).toBe(
      "Final answer."
    );
    expect(filterReasoning("<thinking>reasoning</thinking><response>Answer.</response>")).toBe(
      "Answer."
    );
  });

  it("6. matches uppercase and whitespace tag variants", () => {
    expect(filterReasoning("<THINKING>\nreasoning\n</THINKING>\nAnswer.")).toBe(
      "Answer."
    );
    expect(filterReasoning("< THINK >\nreasoning\n</ THINK >\nAnswer.")).toBe("Answer.");
    expect(filterReasoning("<thinking >\nreasoning\n</thinking >\nAnswer.")).toBe("Answer.");
    expect(filterReasoning("<RESPONSE>The answer.</RESPONSE>")).toBe("The answer.");
  });

  it("11. does not touch normal prose containing the word think/response", () => {
    expect(filterReasoning("I think this solution is correct.")).toBe(
      "I think this solution is correct."
    );
    expect(filterReasoning("Thinking about it, the HTTP response was 200.")).toBe(
      "Thinking about it, the HTTP response was 200."
    );
    expect(filterReasoning("Please think carefully before answering.")).toBe(
      "Please think carefully before answering."
    );
  });

  it("strips a stray reasoning-close boundary without removing the answer", () => {
    expect(filterReasoning("<response>The answer is here.</response>")).toBe(
      "The answer is here."
    );
  });

  it("never exposes reasoning when the stream ends inside the block", () => {
    const raw = [" thinking", "unfinished internal reasoning"].join("\n");
    expect(filterReasoning(raw)).toBe("");
  });

  it("drops a trailing incomplete tag or bare marker line", () => {
    expect(filterReasoning("Answer.\n<thinking")).toBe("Answer.");
    expect(filterReasoning("Answer.\n thinking")).toBe("Answer.");
  });

  it("discards everything after an unclosed reasoning tag", () => {
    expect(filterReasoning("<thinking>reasoning\nFinal answer.")).toBe("");
  });
});

describe("ReasoningFilter streaming", () => {
  it("3. filters reasoning that arrives across many chunks", () => {
    const out = streamChunks([
      " think",
      "ing\nHere's",
      " the internal reasoning",
      " step by step\n",
      " resp",
      "onse\nFinal",
      " answer"
    ]);
    expect(out).toBe("Final answer");
  });

  it("4. handles the thinking tag split across chunks", () => {
    const out = streamChunks([
      "<th",
      "ink>",
      "reasoning about the task",
      "</thi",
      "nk>",
      "Final answer."
    ]);
    expect(out).toBe("Final answer.");
  });

  it("5. handles the response tag split across chunks", () => {
    const out = streamChunks([
      " thinking",
      "\nreasoning goes here\n",
      "<res",
      "ponse>",
      "The visible answer."
    ]);
    expect(out).toBe("The visible answer.");
  });

  it("never briefly leaks partial reasoning tags", () => {
    const filter = new ReasoningFilter();
    expect(filter.push("<th")).toBe("");
    expect(filter.push("ink>")).toBe("");
    expect(filter.push("internal reasoning")).toBe("");
    expect(filter.push("</thi")).toBe("");
    expect(filter.push("nk>")).toBe("");
    expect(filter.push("The final answer.")).toBe("The final answer.");
    expect(filter.flush()).toBe("");
  });

  it("8. filters a screen-share style response with reasoning", () => {
    const raw = [
      " thinking",
      "The user's screen shows a Python terminal.",
      "The visible error is ModuleNotFoundError for pandas.",
      "The user wants the cause and a fix.",
      " response",
      "The error is ModuleNotFoundError: No module named 'pandas'. Install it with `pip install pandas`."
    ].join("\n");
    expect(filterReasoning(raw)).toBe(
      "The error is ModuleNotFoundError: No module named 'pandas'. Install it with `pip install pandas`."
    );
  });

  it("handles whitespace/newline variations between markers", () => {
    const raw = "\n\n  thinking \n\n reasoning text \n\n  response \n\n  The answer.";
    expect(filterReasoning(raw)).toBe("The answer.");
  });

  it("filters reasoning delimited with CRLF line endings", () => {
    const raw = "thinking\r\ninternal reasoning\r\nresponse\r\nFinal answer.";
    expect(filterReasoning(raw)).toBe("Final answer.");
  });

  it("does not leak reasoning when a CRLF block is unclosed", () => {
    const raw = " thinking\r\nunfinished internal reasoning";
    expect(filterReasoning(raw)).toBe("");
  });
});