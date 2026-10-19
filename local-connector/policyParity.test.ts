// Policy-parity regression: pins the web connector's inline command policy
// (local-connector/server.js — must stay self-contained for the one-time
// download asset) to the desktop policy (native/policy.ts). A drift in either
// direction fails this test so the two runtimes cannot silently diverge.
//
// Documented intentional differences (connector is a looser chat-superset):
//   - CONNECTOR_ONLY_BINS: git / echo / pwd / cat are allowed by the web
//     connector and not by the stricter desktop runtime.
//   - The desktop runtime adds structural rules (package.json script checks,
//     python restricted to -m pytest|unittest, node script-path checks) that
//     the connector does not replicate. Only the shared metacharacter rules
//     and the bin allow-lists are pinned here.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FORBIDDEN_META as NATIVE_FORBIDDEN_META,
  FORBIDDEN_PIPE_CHAIN as NATIVE_FORBIDDEN_PIPE_CHAIN,
  ALLOWED_BINS as NATIVE_ALLOWED_BINS,
} from "../native/policy";

const serverSrc = readFileSync(
  fileURLToPath(new URL("./server.js", import.meta.url)),
  "utf8"
);

/** Extract a `const NAME = <literal>;` initializer from server.js source. */
function extractConst(name: string): string {
  // Regex literal first: a character class may itself contain `;`, so a
  // naive `[^;]+` capture would truncate (e.g. FORBIDDEN_META).
  const reLiteral = new RegExp(`const ${name}\\s*=\\s*(\\/[^\\n]*\\/[a-z]*);`);
  const mLiteral = serverSrc.match(reLiteral);
  if (mLiteral) return mLiteral[1].trim();
  const re = new RegExp(`const ${name}\\s*=\\s*([^;]+);`);
  const m = serverSrc.match(re);
  if (!m) throw new Error(`could not extract const ${name} from server.js`);
  return m[1].trim();
}

function extractRegexLiteral(name: string): RegExp {
  const lit = extractConst(name);
  // eslint-disable-next-line no-eval -- evaluating a regex literal we just
  // parsed out of our own source file; not user input.
  const value = eval(lit) as unknown;
  if (!(value instanceof RegExp)) {
    throw new Error(`const ${name} in server.js is not a RegExp literal`);
  }
  return value;
}

function extractStringSet(name: string): Set<string> {
  const lit = extractConst(name);
  const matches = [...lit.matchAll(/'([^']+)'|"([^"]+)"/g)];
  return new Set(matches.map((m) => (m[1] !== undefined ? m[1] : m[2])));
}

/** Bins the web connector allows that the desktop runtime deliberately does not. */
const CONNECTOR_ONLY_BINS = new Set(["git", "echo", "pwd", "cat"]);

describe("connector/desktop command-policy parity", () => {
  it("pins FORBIDDEN_META to the desktop rule (byte-identical regex source)", () => {
    const connector = extractRegexLiteral("FORBIDDEN_META");
    expect(connector.source).toBe(NATIVE_FORBIDDEN_META.source);
    expect(connector.flags).toBe(NATIVE_FORBIDDEN_META.flags);
  });

  it("pins FORBIDDEN_PIPE_CHAIN to the desktop rule", () => {
    const connector = extractRegexLiteral("FORBIDDEN_PIPE_CHAIN");
    expect(connector.source).toBe(NATIVE_FORBIDDEN_PIPE_CHAIN.source);
    expect(connector.flags).toBe(NATIVE_FORBIDDEN_PIPE_CHAIN.flags);
  });

  it("pins the PowerShell metachar rule to the desktop PowerShell branch", () => {
    // native/policy.ts uses /[&;<>`\r\n%^]/ for PowerShell commands (allows $).
    const connectorPs = extractRegexLiteral("FORBIDDEN_META_POWERSHELL");
    expect(connectorPs.source).toBe(/[&;<>`\r\n%^]/.source);
  });

  it("keeps every desktop bin available in the connector (case-insensitive)", () => {
    const connectorBins = new Set(
      [...extractStringSet("ALLOWED_BINS")].map((s) => s.toLowerCase())
    );
    const nativeLower = new Set([...NATIVE_ALLOWED_BINS].map((s) => s.toLowerCase()));
    for (const bin of nativeLower) {
      expect(connectorBins.has(bin), `connector is missing desktop bin "${bin}"`).toBe(true);
    }
  });

  it("allows exactly the documented connector-only bins beyond the desktop set", () => {
    const connectorBins = new Set(
      [...extractStringSet("ALLOWED_BINS")].map((s) => s.toLowerCase())
    );
    const nativeLower = new Set([...NATIVE_ALLOWED_BINS].map((s) => s.toLowerCase()));
    const extras = [...connectorBins].filter((b) => !nativeLower.has(b)).sort();
    expect(extras).toEqual([...CONNECTOR_ONLY_BINS].sort());
  });

  it("documents the single-file distribution constraint in server.js", () => {
    expect(serverSrc).toContain("must stay fully self-contained");
    expect(serverSrc).toContain("policyParity.test.ts");
  });

  it("never routes simple commands through cmd.exe", () => {
    // The old implementation wrapped dir/ls/echo/pwd/cat via cmd.exe /d /s /c.
    // Strip comments first so documentation mentioning "cmd.exe" is allowed.
    const code = serverSrc
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/ComSpec|["'`]cmd\.exe|["'`]\/d["'`]/);
  });
});
