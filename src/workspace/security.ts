// Secret protection for the workspace engine.
//
// Secret-looking file contents are redacted BEFORE they enter the index, so
// credentials never reach the model, search results, or logs.

import { baseName } from "./path";

const SECRET_FILE_NAMES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".env.example",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "credentials.json",
  "service-account-key.json",
  "serviceaccountkey.json",
  "secrets.json"
];

export function isSecretFileName(name: string): boolean {
  const base = baseName(name).toLowerCase();
  if (SECRET_FILE_NAMES.includes(base)) return true;
  return base.startsWith(".env") || base.endsWith(".pem");
}

// High-signal credential shapes redacted in ANY file (not just secret files):
// OpenAI-style sk- keys, Google AIza keys, GitHub tokens, and PEM private keys.
const GENERIC_SECRET_RE =
  /(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{8,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/g;

/**
 * Redact secret-shaped values from file content before indexing.
 *
 * For KEY=VALUE style files (`.env*`, credentials) the key and comments are
 * preserved (they are useful context) while every value is replaced. For all
 * other files, recognizable credential tokens and private key blocks are
 * masked. Redaction is deterministic and never touches comments.
 */
export function redactSecrets(content: string, fileName: string): string {
  if (!content) return content;
  if (isSecretFileName(fileName)) {
    return content
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
          return line;
        }
        const eq = line.indexOf("=");
        if (eq > 0 && !line.slice(0, eq).trim().includes(" ")) {
          return `${line.slice(0, eq + 1)} "***REDACTED***"`;
        }
        return line;
      })
      .join("\n");
  }
  return content.replace(GENERIC_SECRET_RE, "***REDACTED***");
}