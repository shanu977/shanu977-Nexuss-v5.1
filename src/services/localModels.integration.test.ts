import { describe, it, expect, beforeAll } from "vitest";
import { streamLocalChat } from "@/services/localModels";
import { filterReasoning } from "@/utils/reasoning";

/**
 * REAL integration test against a running local Ollama instance.
 *
 * Skipped unless NEXUSS_REAL_OLLAMA=1 is set (and Ollama is reachable at
 * http://localhost:11434). Run with:
 *
 *   NEXUSS_REAL_OLLAMA=1 npx vitest run src/services/localModels.integration.test.ts
 */

const RUN = process.env.NEXUSS_REAL_OLLAMA === "1";
const ENDPOINT = process.env.NEXUSS_OLLAMA_ENDPOINT ?? "http://localhost:11434/v1";
const MODEL = process.env.NEXUSS_OLLAMA_MODEL ?? "qwen2.5-coder:7b";

async function complete(
  messages: { role: string; content: string }[],
  opts: { repeatPenalty?: number } = {}
): Promise<string> {
  let out = "";
  const stream = streamLocalChat({
    endpoint: ENDPOINT,
    modelId: MODEL,
    messages,
    ...opts,
  });
  for await (const evt of stream) {
    if (evt.type === "chunk") out += evt.content;
  }
  return filterReasoning(out);
}

describe.skipIf(!RUN)("REAL Ollama integration (qwen2.5-coder:7b)", () => {
  beforeAll(async () => {
    const res = await fetch(`${ENDPOINT.replace(/\/$/, "")}/models`).catch(() => null);
    if (!res || !res.ok) {
      throw new Error(
        `Ollama not reachable at ${ENDPOINT}. Start Ollama or set NEXUSS_OLLAMA_ENDPOINT.`
      );
    }
    const data = (await res.json()) as { data?: { id: string }[] };
    const ids = (data.data ?? []).map((m) => m.id);
    if (!ids.includes(MODEL)) {
      throw new Error(`Model ${MODEL} not present. Available: ${ids.join(", ")}`);
    }
  }, 30_000);

  it("responds coherently (no degenerate repetition) with default options", async () => {
    const reply = await complete([{ role: "user", content: "In one sentence, what is a REST API?" }]);
    expect(reply.length).toBeGreaterThan(10);
    expect(reply.length).toBeLessThan(500);
    // Degenerate loop signature: same short token repeated with spaces
    expect(reply).not.toMatch(/\b(\w{1,8})\1(\s+\1){2,}/);
    expect(reply.toLowerCase()).not.toContain("i i ");
    expect(reply).toMatch(/api/i);
  }, 120_000);

  it("keeps conversation context across turns", async () => {
    const reply = await complete([
      { role: "user", content: "My name is Priya and I am debugging a Python TypeError." },
      { role: "assistant", content: "Got it Priya, what does the traceback say?" },
      { role: "user", content: "What is my name and what am I debugging? Answer in one short sentence." },
    ]);
    expect(reply).toMatch(/priya/i);
    expect(reply).toMatch(/type\s*error|typeerror/i);
    expect(reply).not.toMatch(/\b(\w{1,8})\1(\s+\1){2,}/);
  }, 120_000);

  it("does not leak internal planning headings", async () => {
    const reply = await complete([
      { role: "user", content: "Write a two-line Python function that adds two numbers." },
    ]);
    expect(reply).not.toMatch(/^\s*(Strategy|Draft|Refine|Verification|Analysis|Reasoning):/m);
    expect(reply).toMatch(/def\s+\w+/);
  }, 120_000);

  it("repeating-prompt consistency: second run with explicit penalty is also clean", async () => {
    const reply = await complete(
      [{ role: "user", content: "Say hello and offer help in one sentence." }],
      { repeatPenalty: 1.1 }
    );
    expect(reply.length).toBeGreaterThan(5);
    expect(reply).not.toMatch(/\b(\w{1,8})\1(\s+\1){2,}/);
  }, 120_000);
});
