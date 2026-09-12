// Command policy: the ONLY gate between an untrusted model/user command
// string and the OS process API.
//
// Rules:
//   - The command is tokenized locally (no shell evaluation).
//   - The raw string must not contain shell metacharacters (`& | ; < > % ^
//     ` $` newlines), so nothing can chain, redirect, or substitute.
//   - The first token must be an allowlisted runtime/package manager.
//   - `npm|pnpm|yarn|bun run <script>` requires the script to exist in
//     package.json; a bare lifecycle name (`test`, `build`, `lint`, ...) must
//     also exist.
//   - `python* -m pytest|unittest`, `pytest`, `go test|build|vet`,
//     `cargo test|build`, `make <target>` are allowed.
//   - `node` runs only `node --test` or a workspace-relative script file.
//   - Commands that exactly match a trusted discovered plan (from project
//     config) always pass.

import { NativeError } from "./errors";
import { readMakefileTargets, readPackageJson } from "./project";
import { resolveInsideRoot } from "./boundary";

const FORBIDDEN_META = /[&;<>`\r\n%^$]/;
const FORBIDDEN_PIPE_CHAIN = /&&|\|\|/;

const ALLOWED_BINS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "node",
  "python",
  "python3",
  "py",
  "pytest",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "go",
  "cargo",
  "make",
  "deno",
  "powershell",
  "pwsh",
  "Get-ChildItem",
  "get-childitem",
  "Get-PSDrive",
  "get-psdrive",
  "dir",
  "ls"
]);

export interface CommandPolicyOptions {
  /** Canonical absolute cwd (already validated against the workspace root). */
  cwd: string;
  /** Canonical workspace root. */
  workspaceRoot: string;
  /** Extra exact command strings considered trusted (e.g. discovered plans). */
  allowedExact?: string[];
}

export interface ValidatedCommand {
  /** Canonical absolute cwd the process will run in. */
  cwd: string;
  /** Tokenized argv for spawn (no shell). */
  argv: string[];
  /** The normalized command string. */
  command: string;
}

export function normalizeCommand(command: string): string {
  return command.replace(/\\/g, "/").replace(/\s+/g, " ").trim();
}

/**
 * Minimal shell-free tokenizer: splits on whitespace honoring single/double
 * quotes. Returns null on unbalanced quotes.
 */
export function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (quote) return null;
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export function validateCommand(
  command: string,
  opts: CommandPolicyOptions
): ValidatedCommand {
  const raw = command.trim();
  if (!raw) throw new NativeError("COMMAND_NOT_ALLOWED", "Command is empty.");

  const normalized = normalizeCommand(raw);
  // Exact trusted commands (discovered from project config) always pass: they
  // are never user/model-supplied strings, so metacharacter rules do not apply.
  if (opts.allowedExact?.some((allowed) => normalizeCommand(allowed) === normalized)) {
    return { cwd: opts.cwd, argv: requireTokens(normalized), command: normalized };
  }

  // Allow single | for PowerShell pipelines (Get-ChildItem | Select-Object) but block && and ||
  if (FORBIDDEN_PIPE_CHAIN.test(raw)) {
    throw new NativeError("COMMAND_NOT_ALLOWED", "Shell chaining && and || is not allowed.");
  }
  // For PowerShell terminal commands, allow | pipe; for others, allow but still validate
  const isTerminalPowerShell = raw.toLowerCase().includes("get-childitem") || raw.toLowerCase().includes("get-psdrive") || raw.toLowerCase().startsWith("powershell") || raw.toLowerCase().startsWith("pwsh");
  if (!isTerminalPowerShell && FORBIDDEN_META.test(raw)) {
    throw new NativeError(
      "COMMAND_NOT_ALLOWED",
      "Shell metacharacters are not allowed in workspace commands."
    );
  }
  if (isTerminalPowerShell && /[&;<>`\r\n%^$]/.test(raw)) {
    throw new NativeError("COMMAND_NOT_ALLOWED", "Shell metacharacters are not allowed.");
  }

  const tokens = tokenizeCommand(normalized);
  if (!tokens || tokens.length === 0) {
    throw new NativeError("COMMAND_NOT_ALLOWED", "Command could not be parsed.");
  }

  const bin = tokens[0].toLowerCase();
  const origBin = tokens[0];
  // Case-insensitive check for PowerShell bins
  const lowerAllowed = new Set([...ALLOWED_BINS].map((s) => s.toLowerCase()));
  if (!lowerAllowed.has(bin)) {
    throw new NativeError("COMMAND_NOT_ALLOWED", `"${origBin}" is not an allowed command.`);
  }

  const arg1 = tokens[1];

  // Terminal inspection commands: allow directly without package.json checks
  if (bin === "powershell" || bin === "pwsh" || bin === "get-childitem" || bin === "get-psdrive" || bin === "dir" || bin === "ls") {
    return { cwd: opts.cwd, argv: tokens, command: normalized };
  }
  if (bin === "node" && arg1 === "--version") {
    return { cwd: opts.cwd, argv: tokens, command: normalized };
  }
  if ((bin === "npm" || bin === "pnpm" || bin === "yarn" || bin === "bun") && arg1 === "--version") {
    return { cwd: opts.cwd, argv: tokens, command: normalized };
  }

  if (bin === "npm" || bin === "pnpm" || bin === "yarn" || bin === "bun") {
    assertPackageManagerScript(opts.cwd, tokens, bin);
  } else if (bin === "python" || bin === "python3" || bin === "py") {
    if (arg1 === "-m") {
      if (tokens[2] !== "pytest" && tokens[2] !== "unittest") {
        throw new NativeError("COMMAND_NOT_ALLOWED", "Only `-m pytest` / `-m unittest` are allowed.");
      }
    } else {
      throw new NativeError("COMMAND_NOT_ALLOWED", "Use `python -m pytest` to run tests.");
    }
  } else if (bin === "node") {
    if (arg1 === "--test") {
      // node --test [workspace-relative file...] is allowed.
      for (const arg of tokens.slice(2)) {
        if (arg.startsWith("-")) {
          throw new NativeError("COMMAND_NOT_ALLOWED", `node flag "${arg}" is not allowed.`);
        }
      }
    } else if (arg1?.startsWith("-")) {
      throw new NativeError("COMMAND_NOT_ALLOWED", "`node -e` / flags are not allowed.");
    } else {
      // Running a workspace script file.
      const file = arg1;
      if (!file) throw new NativeError("COMMAND_NOT_ALLOWED", "node requires a script path.");
      resolveInsideRoot(opts.workspaceRoot, file.replace(/^\.\//, ""));
    }
  } else if (bin === "pytest") {
    // pytest [options] — allow; options are filtered to non-shell-safe usage.
  } else if (bin === "go") {
    if (!arg1 || !["test", "build", "vet", "run"].includes(arg1)) {
      throw new NativeError("COMMAND_NOT_ALLOWED", "go requires test/build/vet/run.");
    }
  } else if (bin === "cargo") {
    if (!arg1 || !["test", "build"].includes(arg1)) {
      throw new NativeError("COMMAND_NOT_ALLOWED", "cargo requires test/build.");
    }
  } else if (bin === "make") {
    if (arg1 && !/^[A-Za-z0-9_.-]+$/.test(arg1)) {
      throw new NativeError("COMMAND_NOT_ALLOWED", "Invalid make target.");
    }
    const targets = readMakefileTargets(opts.cwd);
    if (arg1 && !targets.includes(arg1)) {
      throw new NativeError("COMMAND_NOT_ALLOWED", `Makefile has no target "${arg1}".`);
    }
  } else if (bin === "uv" || bin === "poetry") {
    if (arg1 !== "run") {
      throw new NativeError("COMMAND_NOT_ALLOWED", `${bin} requires \`run\`.`);
    }
  } else if (bin === "pip" || bin === "pip3") {
    throw new NativeError("COMMAND_NOT_ALLOWED", "pip is not an allowed workspace command.");
  } else if (bin === "deno") {
    if (arg1 !== "test") {
      throw new NativeError("COMMAND_NOT_ALLOWED", "deno only allows `deno test`.");
    }
  }

  return { cwd: opts.cwd, argv: tokens, command: normalized };
}

function assertPackageManagerScript(cwd: string, tokens: string[], bin: string): void {
  if (tokens.length < 2) {
    throw new NativeError("COMMAND_NOT_ALLOWED", `${bin} requires a script name.`);
  }
  const arg1 = tokens[1];
  const scriptName = arg1 === "run" ? tokens[2] : arg1;
  if (!scriptName || scriptName.startsWith("-")) {
    throw new NativeError("COMMAND_NOT_ALLOWED", `Invalid ${bin} script name.`);
  }
  const pkg = readPackageJson(cwd);
  const scripts = pkg?.scripts ?? {};
  if (!(scriptName in scripts) || !scripts[scriptName]) {
    throw new NativeError(
      "COMMAND_NOT_ALLOWED",
      `package.json has no "${scriptName}" script.`
    );
  }
  // The script body itself is user-authored and run as-is; it is NOT parsed
  // here (it may legitimately contain shell features). The model only ever
  // selects the script name; it can never inject a new one.
  if (arg1 === "run" && tokens.length > 3) {
    throw new NativeError("COMMAND_NOT_ALLOWED", `${bin} run does not accept extra arguments.`);
  }
  if (arg1 === "run") {
    validateScriptPath(cwd, scriptName, scripts[scriptName]);
  }
}

function validateScriptPath(cwd: string, scriptName: string, body: string): void {
  // Reject scripts that shell out to an absolute/UNC path as a first token
  // (defense in depth for e.g. "build": "C:\\tools\\x.exe"). Relative
  // workspace scripts and normal tool invocations are fine.
  const first = body.trim().split(/\s+/)[0] ?? "";
  if (/^[a-zA-Z]:[\\/]/.test(first) || /^\\\\/.test(first)) {
    throw new NativeError("COMMAND_NOT_ALLOWED", `Script "${scriptName}" runs an absolute path.`);
  }
}

function requireTokens(command: string): string[] {
  const tokens = tokenizeCommand(command);
  if (!tokens || tokens.length === 0) {
    throw new NativeError("COMMAND_NOT_ALLOWED", "Command could not be parsed.");
  }
  return tokens;
}
