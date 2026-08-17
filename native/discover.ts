// Test command discovery (STEP 7/19).
//
// The test tool NEVER invents a command: it reads the project's own
// configuration and returns a structured TestPlan, or TEST_COMMAND_NOT_FOUND.
// Discovery order mirrors real project conventions and uses the detected
// package manager for Node projects.

import { NativeError } from "./errors";
import type { TestPlan } from "./types";
import {
  detectPackageManager,
  hasGoModule,
  hasPytestConfig,
  hasScript,
  readMakefileTargets,
  readPackageJson
} from "./project";

/**
 * Discover the project's test command. Returns null when no reliable command
 * exists (the caller maps that to TEST_COMMAND_NOT_FOUND).
 */
export function discoverTestCommand(cwd: string): TestPlan | null {
  // Node: prefer the package manager's `test` script.
  const pkg = readPackageJson(cwd);
  if (pkg) {
    const scripts = pkg.scripts ?? {};
    if (typeof scripts.test === "string" && scripts.test.trim()) {
      const pm = detectPackageManager(cwd);
      return {
        command: `${pm} test`,
        source: "package.json#scripts.test",
        confidence: "high"
      };
    }
  }

  // Python: explicit pytest configs.
  if (hasPytestConfig(cwd)) {
    return { command: "pytest", source: "pytest config", confidence: "high" };
  }

  // Go modules.
  if (hasGoModule(cwd)) {
    return { command: "go test ./...", source: "go.mod", confidence: "high" };
  }

  // Makefile targets.
  const targets = readMakefileTargets(cwd);
  if (targets.includes("test")) {
    return { command: "make test", source: "Makefile", confidence: "high" };
  }

  return null;
}

/** Discover a project-defined build command, when one exists. */
export function discoverBuildCommand(cwd: string): TestPlan | null {
  const pkg = readPackageJson(cwd);
  const scripts = pkg?.scripts ?? {};
  if (typeof scripts.build === "string" && scripts.build.trim()) {
    return {
      command: `${detectPackageManager(cwd)} run build`,
      source: "package.json#scripts.build",
      confidence: "high"
    };
  }
  if (hasGoModule(cwd)) {
    return { command: "go build ./...", source: "go.mod", confidence: "high" };
  }
  if (readMakefileTargets(cwd).includes("build")) {
    return { command: "make build", source: "Makefile", confidence: "high" };
  }
  return null;
}

/** Discover a project-defined lint command, when one exists. */
export function discoverLintCommand(cwd: string): TestPlan | null {
  const pkg = readPackageJson(cwd);
  const scripts = pkg?.scripts ?? {};
  if (typeof scripts.lint === "string" && scripts.lint.trim()) {
    return {
      command: `${detectPackageManager(cwd)} run lint`,
      source: "package.json#scripts.lint",
      confidence: "high"
    };
  }
  if (readMakefileTargets(cwd).includes("lint")) {
    return { command: "make lint", source: "Makefile", confidence: "high" };
  }
  return null;
}

/**
 * Ensure the workspace actually defines a `test` script under the current
 * package manager (used by the strict package-manager policy path).
 */
export function assertTestScriptExists(cwd: string): void {
  if (!hasScript(cwd, "test")) {
    throw new NativeError("TEST_COMMAND_NOT_FOUND");
  }
}
