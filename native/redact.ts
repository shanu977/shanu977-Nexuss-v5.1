// Secret protection for native execution output (STEP 13/14).
//
// The child process receives a scrubbed environment (high-risk credential
// variables removed so unrelated machine secrets never leak into a project
// run) and every byte that reaches the model is redacted: secret-shaped tokens
// and any known sensitive env values that appear in the output are masked. The
// model NEVER receives the environment itself.

const HIGH_RISK_ENV_RE =
  /^(?:[A-Z0-9_]*?(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|COOKIE|SESSION)[A-Z0-9_]*?)$|^[A-Z0-9_]*API_?KEY$/;

// Neutral vars required for tools to find runtimes and resolve home dirs.
const KEEP_ENV = new Set([
  "PATH",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "LANG",
  "LC_ALL",
  "TERM",
  "CI",
  "SHELL",
  "WINDIR",
  "windir",
  "SystemDrive",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "SESSIONNAME",
  "USERDOMAIN",
  "USERNAME",
  "PWD"
]);

const GENERIC_SECRET_RE =
  /(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{8,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----)/g;

/** Build the controlled child environment, dropping high-risk variables. */
export function buildScrubbedEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (HIGH_RISK_ENV_RE.test(upper) && !KEEP_ENV.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Redact secret-shaped text from command output; returns the redacted text. */
export function redactOutput(output: string, sensitiveValues: string[]): string {
  if (!output) return output;
  let redacted = output.replace(GENERIC_SECRET_RE, "***REDACTED***");
  for (const value of sensitiveValues) {
    if (!value || value.length < 6) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redacted = redacted.replace(new RegExp(escaped, "g"), "***REDACTED***");
  }
  // password=/token=/key= value pairs where the value looks like a secret.
  redacted = redacted.replace(
    /(password|passwd|token|secret|api[_-]?key|private[_-]?key)(\s*[=:]\s*["']?)[A-Za-z0-9._~+/@-]{8,}/gi,
    "$1$2***REDACTED***"
  );
  return redacted;
}

/** Collect the sensitive env values (from the parent env) worth masking. */
export function collectSensitiveEnvValues(
  env: Record<string, string | undefined>
): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value.length < 6) continue;
    const upper = key.toUpperCase();
    if (HIGH_RISK_ENV_RE.test(upper)) values.push(value);
  }
  return values;
}
