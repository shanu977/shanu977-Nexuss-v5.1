// Read-only inspection of the project under execution. All results are
// surfaced as plain data; nothing here ever executes anything.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function readJson<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function readText(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function hasFile(cwd: string, name: string): boolean {
  return existsSync(path.join(cwd, name));
}

export function readPackageJson(cwd: string): {
  scripts?: Record<string, string>;
  name?: string;
} | null {
  return readJson<{ scripts?: Record<string, string>; name?: string }>(
    path.join(cwd, "package.json")
  );
}

export function hasScript(cwd: string, name: string): boolean {
  const pkg = readPackageJson(cwd);
  const body = pkg?.scripts?.[name];
  return typeof body === "string" && body.trim().length > 0;
}

/** Detect the project's package manager from lockfiles, then package.json. */
export function detectPackageManager(cwd: string): string {
  if (hasFile(cwd, "pnpm-lock.yaml")) return "pnpm";
  if (hasFile(cwd, "yarn.lock")) return "yarn";
  if (hasFile(cwd, "bun.lockb") || hasFile(cwd, "bun.lock")) return "bun";
  if (hasFile(cwd, "package-lock.json")) return "npm";
  if (hasFile(cwd, "package.json")) return "npm";
  return "npm";
}

/** True when the directory looks like a Python project with a pytest config. */
export function hasPytestConfig(cwd: string): boolean {
  if (hasFile(cwd, "pytest.ini")) return true;
  const pyproject = readText(path.join(cwd, "pyproject.toml"));
  if (pyproject && /\[tool\.pytest\.ini_options\]/.test(pyproject)) return true;
  const setupCfg = readText(path.join(cwd, "setup.cfg"));
  if (setupCfg && /\[tool:pytest\]/.test(setupCfg)) return true;
  if (hasFile(cwd, "tox.ini")) {
    const tox = readText(path.join(cwd, "tox.ini"));
    if (tox && /\[pytest\]/.test(tox)) return true;
  }
  return false;
}

/** True when the directory is a Go module. */
export function hasGoModule(cwd: string): boolean {
  return hasFile(cwd, "go.mod");
}

/** Names of `make` targets defined in the Makefile. */
export function readMakefileTargets(cwd: string): string[] {
  const text = readText(path.join(cwd, "Makefile"));
  if (!text) return [];
  const targets: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.-]+)\s*:/.exec(line.trim());
    if (m && !m[1].startsWith(".")) targets.push(m[1]);
  }
  return targets;
}
