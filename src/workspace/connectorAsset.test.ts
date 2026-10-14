import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The web app offers public/nexuss-connector.js as the one-time setup
// download. It must always be an exact copy of the canonical connector
// (local-connector/server.js) plus a generated header — run
// `npm run connector:sync` whenever the source changes.
describe("connector download asset", () => {
  it("is in sync with local-connector/server.js", () => {
    const root = process.cwd();
    const source = readFileSync(join(root, "local-connector", "server.js"), "utf8");
    const asset = readFileSync(join(root, "public", "nexuss-connector.js"), "utf8");

    expect(asset.startsWith("// GENERATED FILE")).toBe(true);
    // The public asset drops the shebang (invalid below a header comment);
    // everything after the generated header must match the canonical
    // connector exactly. Assert via suffix so the source's own leading
    // comment block is never mistaken for the header.
    const sourceBody = source.replace(/^#!.*\r?\n/, "");
    expect(asset.endsWith(sourceBody)).toBe(true);
    const header = asset.slice(0, asset.length - sourceBody.length);
    expect(header.startsWith("// GENERATED FILE")).toBe(true);
    expect(header).not.toContain("\n#!");
  });
});
