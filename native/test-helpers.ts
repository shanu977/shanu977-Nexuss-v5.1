// Temp-workspace fixtures for the native test suite. Each helper creates a
// unique directory under os.tmpdir() and reports its canonical path, so the
// boundary/policy/runtime checks run against a real trusted root.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Fixture {
  root: string;
  write(rel: string, content: string): Fixture;
  cleanup(): void;
}

export function makeFixture(prefix = "nexuss-native-"): Fixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = realpathSync(dir);
  return {
    root,
    write(rel, content) {
      const full = path.join(root, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
      return this;
    },
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
  };
}

export function nodeScript(body: string): string {
  return `node -e ${JSON.stringify(body)}`;
}
