import { describe, expect, it } from "vitest";

it("checks jsdom environment", () => {
  // @vitest-environment jsdom
  expect(window).toBeDefined();
  expect(document).toBeDefined();
  expect(navigator).toBeDefined();
});