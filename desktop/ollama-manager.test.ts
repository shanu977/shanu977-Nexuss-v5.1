import { describe, expect, it } from "vitest";
import { recommendOllamaModel } from "./ollama-manager";

describe("Ollama model recommendation", () => {
  it("returns system information and at least one recommendation", async () => {
    const result = await recommendOllamaModel();

    expect(result.system).toBeDefined();
    expect(result.system.memory.totalGB).toBeGreaterThan(0);
    expect(result.recommendations.length).toBeGreaterThan(0);

    for (const recommendation of result.recommendations) {
      expect(recommendation.model).toBeTruthy();
      expect(recommendation.reason).toBeTruthy();
      expect(typeof recommendation.suitable).toBe("boolean");
    }
  });
});
