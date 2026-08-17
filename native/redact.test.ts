// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildScrubbedEnv,
  collectSensitiveEnvValues,
  redactOutput
} from "./redact";

describe("buildScrubbedEnv", () => {
  it("drops high-risk credential variables but keeps neutral ones", () => {
    const scrubbed = buildScrubbedEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      AWS_SECRET_ACCESS_KEY: "super-secret",
      GITHUB_TOKEN: "ghp_abc",
      MYAPP_API_KEY: "key-123",
      DB_PASSWORD: "pw",
      LANG: "en_US",
      NORMAL_VAR: "kept"
    });
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.HOME).toBe("/home/u");
    expect(scrubbed.LANG).toBe("en_US");
    expect(scrubbed.NORMAL_VAR).toBe("kept");
    expect(scrubbed.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(scrubbed.GITHUB_TOKEN).toBeUndefined();
    expect(scrubbed.MYAPP_API_KEY).toBeUndefined();
    expect(scrubbed.DB_PASSWORD).toBeUndefined();
  });
});

describe("redactOutput", () => {
  it("masks generic secret shapes", () => {
    const out = redactOutput(
      "token sk-1234567890abcdef used, and AIza1234567890abcdef present",
      []
    );
    expect(out).toContain("***REDACTED***");
    expect(out).not.toContain("sk-1234567890abcdef");
    expect(out).not.toContain("AIza1234567890abcdef");
  });

  it("masks known sensitive env values", () => {
    const out = redactOutput("the value is abcdefghijkl and more", [
      "abcdefghijkl"
    ]);
    expect(out).toContain("***REDACTED***");
    expect(out).not.toContain("abcdefghijkl");
  });

  it("masks password=/token= value pairs", () => {
    const out = redactOutput("password=correctHorseBattery", []);
    expect(out).toBe("password=***REDACTED***");
    const out2 = redactOutput("token: abcdef0123456789", []);
    expect(out2).toBe("token: ***REDACTED***");
  });

  it("returns short values unchanged", () => {
    expect(redactOutput("hi", ["a"])).toBe("hi");
    expect(redactOutput("", ["longvalue"])).toBe("");
  });
});

describe("collectSensitiveEnvValues", () => {
  it("collects values of high-risk variables only", () => {
    const values = collectSensitiveEnvValues({
      FOO_TOKEN: "value-one",
      BANANA: "value-two",
      DBSECRET: "value-three"
    });
    expect(values).toContain("value-one");
    expect(values).toContain("value-three");
    expect(values).not.toContain("value-two");
  });
});
