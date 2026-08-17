// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NativeError } from "./errors";
import {
  discoverBuildCommand,
  discoverLintCommand,
  discoverTestCommand
} from "./discover";
import { detectPackageManager, hasScript, readPackageJson } from "./project";
import { makeFixture } from "./test-helpers";

describe("detectPackageManager", () => {
  it("reads lockfiles, defaulting to npm", () => {
    const cases: Array<[string, string]> = [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["bun.lockb", "bun"],
      ["package-lock.json", "npm"]
    ];
    for (const [lockfile, expected] of cases) {
      const fx = makeFixture();
      try {
        fx.write("package.json", "{}");
        fx.write(lockfile, "");
        expect(detectPackageManager(fx.root)).toBe(expected);
      } finally {
        fx.cleanup();
      }
    }
  });
});

describe("discoverTestCommand", () => {
  it("prefers package.json#scripts.test with the detected pm", () => {
    const fx = makeFixture();
    try {
      fx.write("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
      fx.write("pnpm-lock.yaml", "");
      expect(discoverTestCommand(fx.root)).toEqual({
        command: "pnpm test",
        source: "package.json#scripts.test",
        confidence: "high"
      });
    } finally {
      fx.cleanup();
    }
  });

  it("discovers pytest configs", () => {
    const fx = makeFixture();
    try {
      fx.write("pytest.ini", "[pytest]\n");
      expect(discoverTestCommand(fx.root)).toEqual({
        command: "pytest",
        source: "pytest config",
        confidence: "high"
      });
    } finally {
      fx.cleanup();
    }
  });

  it("discovers Go modules and Makefile targets", () => {
    const fx = makeFixture();
    try {
      fx.write("go.mod", "module example\n");
      expect(discoverTestCommand(fx.root)?.command).toBe("go test ./...");
    } finally {
      fx.cleanup();
    }
    const fx2 = makeFixture();
    try {
      fx2.write("Makefile", "build:\n\techo hi\ntest:\n\techo ok\n");
      expect(discoverTestCommand(fx2.root)?.command).toBe("make test");
    } finally {
      fx2.cleanup();
    }
  });

  it("returns null when nothing is configured", () => {
    const fx = makeFixture();
    try {
      expect(discoverTestCommand(fx.root)).toBeNull();
    } finally {
      fx.cleanup();
    }
  });
});

describe("discoverBuildCommand / discoverLintCommand", () => {
  it("reads package.json build/lint and Makefile targets", () => {
    const fx = makeFixture();
    try {
      fx.write("package.json", JSON.stringify({ scripts: { build: "next build" } }));
      expect(discoverBuildCommand(fx.root)?.command).toBe("npm run build");
      expect(discoverLintCommand(fx.root)).toBeNull();
    } finally {
      fx.cleanup();
    }
    const fx2 = makeFixture();
    try {
      fx2.write("Makefile", "lint:\n\tprettier --check .\n");
      expect(discoverLintCommand(fx2.root)?.command).toBe("make lint");
    } finally {
      fx2.cleanup();
    }
  });
});

describe("hasScript / readPackageJson", () => {
  it("treats empty scripts as absent", () => {
    const fx = makeFixture();
    try {
      fx.write("package.json", JSON.stringify({ scripts: { test: "  " } }));
      expect(hasScript(fx.root, "test")).toBe(false);
      expect(readPackageJson(fx.root)?.scripts?.test).toBe("  ");
    } finally {
      fx.cleanup();
    }
  });

  it("throws TEST_COMMAND_NOT_FOUND when no test script exists", () => {
    const fx = makeFixture();
    try {
      fx.write("package.json", JSON.stringify({}));
      expect(() => {
        throw new NativeError("TEST_COMMAND_NOT_FOUND");
      }).toThrowError("No test command");
    } finally {
      fx.cleanup();
    }
  });
});
