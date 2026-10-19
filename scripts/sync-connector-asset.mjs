// Syncs local-connector/server.js into public/nexuss-connector.js so the web
// app can offer it as a one-time download (the browser cannot start local
// processes; the user runs a small guided setup once that fetches this file
// and auto-starts it). Drift is prevented by connectorAsset.test.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "local-connector", "server.js");
const target = join(root, "public", "nexuss-connector.js");

const header = [
  "// GENERATED FILE — do not edit directly.",
  "// Synced from local-connector/server.js by scripts/sync-connector-asset.mjs",
  "// (npm run connector:sync). Served at /nexuss-connector.js for the one-time",
  "// terminal setup download. A unit test fails the build if this drifts.",
  ""
].join("\n");

// A shebang must stay on line 1 to be valid, and the generated header has to
// come first — so drop the shebang (Node doesn't need it; users run
// `node nexuss-connector.js`).
const sourceBody = readFileSync(source, "utf8").replace(/^#!.*\r?\n/, "");
const content = header + sourceBody;
writeFileSync(target, content, "utf8");
console.log(`Synced ${source} -> ${target}`);
