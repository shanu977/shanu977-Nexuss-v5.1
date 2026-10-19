// One-time terminal setup support for the web app.
//
// A browser page cannot launch local processes, so first-time terminal access
// needs a small, consented setup on the user's computer: a downloadable
// script that saves the standalone Nexuss connector (served from this origin
// at /nexuss-connector.js) into the user's local app data, adds a per-user
// startup entry so it runs at sign-in, and starts it immediately. Every later
// Connect Terminal click is a pure health-check — one click, no setup.

const SETUP_FILENAME = "Nexuss-Terminal-Setup.cmd";
const CONNECTOR_ASSET_PATH = "/nexuss-connector.js";
/** localStorage: this browser profile has verified a working connector once. */
const SETUP_VERIFIED_KEY = "nexuss.terminal.setupVerified";

/** True when the user agent reports Windows (the supported setup target). */
export function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /windows|win32|win64/i.test(ua) || /windows/i.test((navigator as unknown as { platform?: string }).platform || "");
}

/** Remember that this browser has verified a running connector at least once. */
export function markTerminalSetupVerified(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETUP_VERIFIED_KEY, "1");
  } catch {
    // Storage unavailable — setup flow still works.
  }
}

/** True once this browser profile has verified a working connector. */
export function hasTerminalSetupVerified(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SETUP_VERIFIED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * PowerShell payload embedded in the downloadable setup command file.
 * It only touches the current user's folders (no admin, no system-wide
 * changes): checks the Node.js runtime, downloads the connector from the
 * current Nexuss origin, writes a startup launcher into the user's Startup
 * folder (visible and removable), registers a per-user `nexuss://` protocol
 * handler (fixed absolute command — the only bridge a web page can use to ask
 * Windows to restart the connector, always behind the OS consent dialog), and
 * starts the connector now. Every step is idempotent: re-running setup
 * overwrites in place and never creates duplicate launchers or processes.
 */
export function buildSetupPowerShell(origin: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
    "if (-not (Get-Command node -ErrorAction SilentlyContinue)) {",
    "  Write-Host ''",
    "  Write-Host 'Node.js is required to run the Nexuss terminal connector.'",
    "  Write-Host 'Your browser will open the official Node.js download page.'",
    "  Write-Host 'Install Node.js, then run this setup file again.'",
    "  Start-Process 'https://nodejs.org/en/download'",
    "  Read-Host 'Press Enter to close this window'",
    "  exit 1",
    "}",
    "$dir = Join-Path $env:LOCALAPPDATA 'Nexuss'",
    "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
    "$js = Join-Path $dir 'nexuss-connector.js'",
    `$src = '${origin}${CONNECTOR_ASSET_PATH}'`,
    "Write-Host 'Downloading the Nexuss terminal connector...'",
    "Invoke-WebRequest -Uri $src -OutFile $js -UseBasicParsing",
    "if ((Get-Content $js -Raw) -notmatch 'nexuss-local') { throw 'The downloaded connector file looks invalid.' }",
    "$startup = [Environment]::GetFolderPath('Startup')",
    "$launcher = Join-Path $startup 'Nexuss Terminal.cmd'",
    "Set-Content -LiteralPath $launcher -Value '@echo off' -Encoding ASCII",
    "Add-Content -LiteralPath $launcher -Value 'start \"\" /b node \"%LOCALAPPDATA%\\Nexuss\\nexuss-connector.js\"' -Encoding ASCII",
    "$scheme = 'HKCU:\\Software\\Classes\\nexuss'",
    "New-Item -Path $scheme -Force | Out-Null",
    "New-Item -Path \"$scheme\\shell\\open\\command\" -Force | Out-Null",
    "Set-ItemProperty -Path $scheme -Name '(default)' -Value 'URL:Nexuss Terminal Protocol'",
    "Set-ItemProperty -Path $scheme -Name 'URL Protocol' -Value ''",
    "Set-ItemProperty -Path \"$scheme\\shell\\open\\command\" -Name '(default)' -Value ('node \"' + $js + '\"')",
    "Write-Host 'Starting your terminal connector...'",
    "Start-Process -FilePath 'node' -ArgumentList $js -WindowStyle Hidden",
    "Write-Host ''",
    "Write-Host 'Setup complete. Return to Nexuss and click Retry to connect.'",
    "Read-Host 'Press Enter to close this window'"
  ].join("\n");
}

/** Base64 of the UTF-16LE encoding PowerShell's -EncodedCommand expects. */
function base64Utf16LE(text: string): string {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Build the downloadable one-time setup file. The PowerShell payload is
 * base64-encoded (UTF-16LE) so the .cmd has no fragile nested quoting.
 */
export function buildSetupCmd(origin: string): { filename: string; content: string } {
  const encoded = base64Utf16LE(buildSetupPowerShell(origin));
  return {
    filename: SETUP_FILENAME,
    content: `@echo off\r\nrem Nexuss one-time terminal setup (user-level, no admin rights required)\r\npowershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}\r\n`
  };
}

/**
 * Trigger a download of the setup file. Returns the filename for tests and
 * logging; a null return means the environment could not produce a download.
 */
export function downloadTerminalSetup(): string | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const origin = window.location?.origin;
  if (!origin || origin === "null") return null;
  const { filename, content } = buildSetupCmd(origin);
  const blob = new Blob([content], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the browser has had a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return filename;
}
