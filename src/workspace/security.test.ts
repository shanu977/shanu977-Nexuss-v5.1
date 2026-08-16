import { describe, expect, it } from "vitest";
import { isSecretFileName, redactSecrets } from "@/workspace/security";

describe("isSecretFileName", () => {
  it("recognizes env and credential files anywhere in the tree", () => {
    expect(isSecretFileName(".env")).toBe(true);
    expect(isSecretFileName(".env.local")).toBe(true);
    expect(isSecretFileName("config/.env.production")).toBe(true);
    expect(isSecretFileName(".env.example")).toBe(true);
    expect(isSecretFileName("secrets/id_rsa")).toBe(true);
    expect(isSecretFileName("secrets/serviceAccountKey.json")).toBe(true);
    expect(isSecretFileName("certs/server.pem")).toBe(true);
  });

  it("does not flag normal source files", () => {
    expect(isSecretFileName("src/auth/login.ts")).toBe(false);
    expect(isSecretFileName("README.md")).toBe(false);
    expect(isSecretFileName("package.json")).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("redacts KEY=VALUE values but keeps keys and comments in env files", () => {
    const input = [
      "# Database connection",
      "DATABASE_URL=postgres://user:pass@host/db",
      "API_KEY=sk-abcdefghijklmnop",
      "",
      "PORT=8080"
    ].join("\n");
    const out = redactSecrets(input, ".env");
    expect(out).toContain("# Database connection");
    expect(out).toContain("DATABASE_URL");
    expect(out).not.toContain("postgres://user:pass@host/db");
    expect(out).not.toContain("sk-abcdefghijklmnop");
    expect(out).toContain("PORT");
    expect(out).toContain("***REDACTED***");
  });

  it("redacts credential tokens in any file", () => {
    const input =
      "const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz'; const g = 'AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz';";
    const out = redactSecrets(input, "src/config.ts");
    expect(out).not.toContain("sk-proj");
    expect(out).not.toContain("AIzaSy");
    expect(out).toContain("***REDACTED***");
  });

  it("redacts PEM private key blocks", () => {
    const input =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(input, "src/keys.ts");
    expect(out).not.toContain("MIIEowIBAAKCAQEA");
    expect(out).toContain("***REDACTED***");
  });

  it("leaves normal code untouched", () => {
    const code = "export function login(u: string, p: string): boolean {\n  return u.length > 0;\n}\n";
    expect(redactSecrets(code, "src/auth.ts")).toBe(code);
  });

  it("handles empty content", () => {
    expect(redactSecrets("", ".env")).toBe("");
  });
});