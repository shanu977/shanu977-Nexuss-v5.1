// GENERATED FILE — do not edit directly.
// Synced from local-connector/server.js by scripts/sync-connector-asset.mjs
// (npm run connector:sync). Served at /nexuss-connector.js for the one-time
// terminal setup download. A unit test fails the build if this drifts.
// Nexuss Local Connector - lightweight loopback gateway for Ollama
// Binds only to 127.0.0.1, allows only Nexuss origins, proxies only to Ollama on localhost:11434
// Usage: node local-connector/server.js  (or npx nexuss-connector)
// Then Nexuss Web at https://www.nexuss.in will fetch http://localhost:11435/v1/models instead of http://localhost:11434
//
// DISTRIBUTION NOTE: this file is served as a standalone one-time-setup asset
// (public/nexuss-connector.js, copied verbatim by scripts/sync-connector-asset.mjs).
// It must stay fully self-contained — no local require() of sibling modules.
// The command-policy constants below are pinned against native/policy.ts by
// local-connector/policyParity.test.ts so the two runtimes cannot drift apart.

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONNECTOR_PORT = process.env.NEXUSS_CONNECTOR_PORT ? parseInt(process.env.NEXUSS_CONNECTOR_PORT, 10) : 11435;
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
// Health-contract version advertised to the web app. Bump when /health or the
// terminal endpoints change shape in a way older clients cannot tolerate;
// the client refuses protocol values below its minimum and offers a safe,
// idempotent update (re-running the one-time setup re-downloads this file).
const CONNECTOR_PROTOCOL = 2;
const CONNECTOR_VERSION = '1.1.0';

const ALLOWED_ORIGINS = [
  'https://www.nexuss.in',
  'https://nexuss.in',
  'https://shanu977-nexuss-v5-1.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Allow any localhost/127.0.0.1 with any port for local dev
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1') return true;
  } catch {}
  return false;
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (!origin) {
    // No origin (curl), allow
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin, Access-Control-Request-Headers, Access-Control-Request-Private-Network');
}

// ============================================================================
// Command policy (MUST stay in lockstep with native/policy.ts — the desktop
// twin). Pinned by local-connector/policyParity.test.ts. The connector is
// intentionally a looser superset for chat-driven terminal use: it also allows
// git / echo / pwd / cat (connector-only bins, documented in the parity test).
// ============================================================================
const FORBIDDEN_META = /[&;<>`\r\n%^$]/;
const FORBIDDEN_PIPE_CHAIN = /&&|\|\|/;
// PowerShell scripts may use $ (variables) and | (pipelines); other bins may not.
const FORBIDDEN_META_POWERSHELL = /[&;<>`\r\n%^]/;
const ALLOWED_BINS = new Set([
  'npm','pnpm','yarn','bun','node','python','python3','py','pytest','pip','pip3','uv','poetry',
  'go','cargo','make','deno','git','dir','ls','echo','pwd','cat',
  'Get-ChildItem','Get-PSDrive','powershell','pwsh'
]);
const ALLOWED_BINS_LOWER = new Set([...ALLOWED_BINS].map((s) => s.toLowerCase()));

/** Quote-aware tokenizer used ONLY for allow-list validation. */
function tokenizeCommand(cmd) {
  const tokens = []; let cur = ''; let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === "'" || ch === '"') q = ch;
    else if (ch === ' ' || ch === '\t') { if (cur) { tokens.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (q) return null;
  if (cur) tokens.push(cur);
  return tokens;
}

// ============================================================================
// Workspace boundary (desktop twin: native/boundary.ts — same threat model,
// different root source). The connector's permitted workspace is ONE trusted
// root: NEXUSS_WORKSPACE_ROOT (explicit override; used by tests) or the user
// home directory (the web product's default workspace). Every client-supplied
// cwd and every absolute path appearing in a command must canonicalize to a
// location inside that root. UNC shares, other drives, `..` escapes, and
// symlink/junction escapes are rejected. Fail closed. Client-supplied cwd and
// any authorization-looking fields are never trusted on their own.
//
// Intentional difference from native/boundary.ts: the web client sends absolute
// cwd paths (home-based), so absolute paths are accepted HERE only when they
// canonicalize inside the trusted root; native (Electron, dialog-picked root)
// rejects absolute paths entirely.
// ============================================================================

/** Resolve the single trusted workspace root for this connector process. */
function resolveWorkspaceRoot() {
  const override = (process.env.NEXUSS_WORKSPACE_ROOT || '').trim();
  const raw = override || os.homedir() || process.env.USERPROFILE || process.env.HOME || '';
  if (!raw) return null;
  const stripped = stripExtendedPrefix(raw);
  if (isUNCPath(stripped) || stripped.startsWith('\\\\')) {
    console.error('[Nexuss Connector] Workspace root must be a local drive path, not UNC.');
    return null;
  }
  try {
    const real = fs.realpathSync.native ? fs.realpathSync.native(stripped) : fs.realpathSync(stripped);
    return path.normalize(real);
  } catch {
    try { return path.normalize(path.resolve(stripped)); } catch { return null; }
  }
}

function stripExtendedPrefix(p) {
  if (typeof p !== 'string') return '';
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice(8);
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

function isUNCPath(p) {
  const s = stripExtendedPrefix(String(p || ''));
  return /^\\\\[^\\]+\\/.test(s) || /^\/\/[^/]+\//.test(s);
}

function isAbsolutePath(p) {
  const s = stripExtendedPrefix(String(p || ''));
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
  if (isUNCPath(s)) return true;
  return s.startsWith('\\\\') || s.startsWith('//');
}

function canonicalizeExisting(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** realpath the deepest existing ancestor; re-append missing tail (write targets). */
function realpathAllowingMissing(p) {
  let existing = path.resolve(p);
  const missing = [];
  for (;;) {
    const real = canonicalizeExisting(existing);
    if (real) return missing.length ? path.join(real, ...missing.reverse()) : real;
    const parent = path.dirname(existing);
    if (parent === existing) return null;
    missing.push(path.basename(existing));
    existing = parent;
  }
}

function trimTrailingSep(p) {
  const n = path.normalize(p);
  if (/^[a-zA-Z]:\\$/.test(n)) return n;
  const t = n.replace(/[\\/]+$/, '');
  return t || n;
}

/** True when candidate is root itself or lives under it (case-insensitive on win32). */
function isInsideRoot(root, candidate) {
  const r = trimTrailingSep(root).toLowerCase();
  const c = trimTrailingSep(candidate).toLowerCase();
  return c === r || c.startsWith(r + path.sep);
}

/**
 * Validate a client-supplied cwd. Never trusts the client: absolute paths must
 * canonicalize inside the trusted root; relative paths resolve against the root
 * and may not contain `..`. Symlink/junction escapes are detected via realpath.
 * Returns { ok: true, cwd } or { ok: false, error } with a static safe message.
 */
function validateConnectorCwd(root, rawCwd) {
  const raw = (rawCwd == null ? '' : String(rawCwd)).trim();
  if (!raw) return { ok: true, cwd: root };
  if (isUNCPath(raw) || raw.startsWith('\\\\') || raw.startsWith('//')) {
    return { ok: false, error: 'UNC paths are not allowed.' };
  }
  if (isAbsolutePath(raw)) {
    const norm = path.normalize(stripExtendedPrefix(raw));
    if (!isInsideRoot(root, norm)) {
      return { ok: false, error: 'Working directory is outside the permitted workspace.' };
    }
    const realFull = canonicalizeExisting(norm);
    if (realFull && !isInsideRoot(root, realFull)) {
      return { ok: false, error: 'Working directory is outside the permitted workspace.' };
    }
    return { ok: true, cwd: realFull || norm };
  }
  const segments = raw.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.some((seg) => seg === '..')) {
    return { ok: false, error: 'Working directory is outside the permitted workspace.' };
  }
  const joined = path.resolve(root, ...segments);
  if (!isInsideRoot(root, joined)) {
    return { ok: false, error: 'Working directory is outside the permitted workspace.' };
  }
  const realFull = canonicalizeExisting(joined);
  if (realFull && !isInsideRoot(root, realFull)) {
    return { ok: false, error: 'Working directory is outside the permitted workspace.' };
  }
  return { ok: true, cwd: realFull || joined };
}

/**
 * Extract absolute Windows path candidates from a raw command string so each
 * can be boundary-checked. Catches quoted and unquoted drive paths and UNC
 * shares while ignoring $env: templates and things like http:// (letter
 * preceded by a word char) or HKLM:\ registry paths.
 */
function extractPathCandidates(command) {
  const out = new Set();
  const quoted = /'([^']*)'|"([^"]*)"/g;
  let m;
  while ((m = quoted.exec(command))) {
    const s = m[1] !== undefined ? m[1] : m[2];
    if (typeof s === 'string' && (/^[a-zA-Z]:[\\/]/.test(s) || isUNCPath(s) || s.startsWith('\\\\'))) {
      out.add(s);
    }
  }
  const drive = /(?<![\w$])([a-zA-Z]:[\\/][^\s'"`]*)/g;
  while ((m = drive.exec(command))) out.add(m[1]);
  const unc = /(?<![\w])(\\\\[^\s'"`]+)/g;
  while ((m = unc.exec(command))) out.add(m[1]);
  return [...out];
}

/**
 * Scan a command for absolute paths that escape the workspace root (or UNC
 * shares). Returns a static safe error string, or null when clean. Write
 * targets that do not exist yet are still containment-checked via the deepest
 * existing ancestor, so `Set-Content` to D:\... is rejected before spawn.
 */
function findCommandPathViolation(root, command) {
  for (const cand of extractPathCandidates(command)) {
    if (isUNCPath(cand) || cand.startsWith('\\\\') || cand.startsWith('//')) {
      return 'UNC paths are not allowed.';
    }
    const norm = path.normalize(stripExtendedPrefix(cand));
    const resolved = path.resolve(norm);
    if (!isInsideRoot(root, resolved)) {
      return 'Path is outside the permitted workspace.';
    }
    const real = realpathAllowingMissing(resolved);
    if (real && !isInsideRoot(root, real)) {
      return 'Path is outside the permitted workspace.';
    }
  }
  return null;
}

/**
 * Resolve a user-supplied simple-command path argument (cat/dir/ls) against
 * cwd and revalidate against the root immediately before the filesystem op
 * (TOCTOU mitigation). Returns { ok, abs, error }.
 */
function resolveSimpleArgPath(root, cwd, arg) {
  if (isUNCPath(arg) || arg.startsWith('\\\\') || arg.startsWith('//')) {
    return { ok: false, error: 'UNC paths are not allowed.' };
  }
  let abs;
  if (isAbsolutePath(arg)) {
    abs = path.normalize(stripExtendedPrefix(arg));
  } else {
    const segments = arg.split(/[\\/]+/).filter((s) => s.length > 0);
    if (segments.some((s) => s === '..')) {
      return { ok: false, error: 'Path is outside the permitted workspace.' };
    }
    abs = path.resolve(cwd, ...segments);
  }
  if (!isInsideRoot(root, abs)) {
    return { ok: false, error: 'Path is outside the permitted workspace.' };
  }
  // Revalidate the canonical path right before use (symlink/junction escapes).
  const real = realpathAllowingMissing(abs);
  if (!real) return { ok: false, error: 'File not found.' };
  if (!isInsideRoot(root, real)) {
    return { ok: false, error: 'Path is outside the permitted workspace.' };
  }
  return { ok: true, abs: real };
}

// Conservative Ollama install detection: filesystem + PATH lookup only (no
// shell spawns). Returns the trusted executable/app path plus whether this
// platform can launch it directly, or null when nothing was found.
function findOllamaExecutable() {
  try {
    const candidates = [];
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA;
      const pf = process.env.ProgramFiles;
      if (local) {
        candidates.push(path.join(local, 'Programs', 'Ollama', 'ollama.exe'));
        candidates.push(path.join(local, 'Ollama', 'ollama.exe'));
      }
      if (pf) candidates.push(path.join(pf, 'Ollama', 'ollama.exe'));
      if (process.env.ProgramData) candidates.push(path.join(process.env.ProgramData, 'chocolatey', 'bin', 'ollama.exe'));
      candidates.push(path.join(os.homedir(), 'scoop', 'shims', 'ollama.exe'));
      for (const c of candidates) {
        try { if (c && fs.existsSync(c)) return { path: c, launchable: true }; } catch {}
      }
      const binName = 'ollama.exe';
      for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        try {
          const full = path.join(dir, binName);
          if (fs.existsSync(full)) return { path: full, launchable: true };
        } catch {}
      }
      return null;
    } else if (process.platform === 'darwin') {
      // macOS ships Ollama as an app bundle; it must be opened via `open -a`,
      // which this connector deliberately does not do — report the install
      // location but not a direct launch method.
      const apps = ['/Applications/Ollama.app', path.join(os.homedir(), 'Applications', 'Ollama.app')];
      for (const c of apps) {
        try { if (fs.existsSync(c)) return { path: c, launchable: false }; } catch {}
      }
      return null;
    } else if (process.platform === 'linux') {
      const bins = [
        '/usr/local/bin/ollama',
        '/usr/bin/ollama',
        path.join(os.homedir(), '.ollama', 'bin', 'ollama'),
      ];
      for (const c of bins) {
        try { if (fs.existsSync(c)) return { path: c, launchable: true }; } catch {}
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

// Conservative Ollama install detection: filesystem + PATH lookup only (no
// shell spawns). Returns true/false, or null on platforms we don't know.
function detectOllamaInstalled() {
  try {
    if (process.platform !== 'win32' && process.platform !== 'darwin' && process.platform !== 'linux') {
      return null;
    }
    return findOllamaExecutable() !== null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ollama startup (web connector). The browser cannot launch a Windows
// executable, so `POST /v1/ollama/ensure` runs here with hard boundaries:
//   - the executable path comes ONLY from trusted local detection above
//     (never from the request body or any client-supplied value);
//   - `shell: false` — no cmd.exe, no PowerShell, no string interpolation;
//   - arguments are fixed (`serve` on POSIX; the bare app launcher on
//     Windows, which starts the Ollama service);
//   - a single in-flight ensure per connector process (concurrent HTTP
//     requests share it) so parallel chat messages can never spawn multiple
//     Ollama processes;
//   - readiness is only ever declared by Ollama's real /api/version health
//     probe, polled at a bounded interval with a bounded startup timeout.
// ---------------------------------------------------------------------------

const OLLAMA_START_TIMEOUT_MS = process.env.NEXUSS_OLLAMA_START_TIMEOUT_MS
  ? Math.max(1000, parseInt(process.env.NEXUSS_OLLAMA_START_TIMEOUT_MS, 10) || 20000)
  : 20000;
const OLLAMA_POLL_INTERVAL_MS = process.env.NEXUSS_OLLAMA_POLL_INTERVAL_MS
  ? Math.max(50, parseInt(process.env.NEXUSS_OLLAMA_POLL_INTERVAL_MS, 10) || 400)
  : 400;

/** promisified probeOllamaVersion. Resolves { running, version }. */
function probeOllamaHealthAsync() {
  return new Promise((resolve) => {
    probeOllamaVersion((running, version) => resolve({ running, version }));
  });
}

/** Spawn the trusted Ollama executable. shell:false, fixed args, hidden. */
function spawnOllamaProcess(exePath) {
  const { spawn } = require('child_process');
  // Windows: the bare app launcher starts the Ollama service (same entry
  // point the user double-clicks). POSIX: `ollama serve` runs the server.
  const args = process.platform === 'win32' ? [] : ['serve'];
  return spawn(exePath, args, {
    windowsHide: true,
    shell: false,
    detached: false,
    stdio: 'ignore',
    env: process.env,
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ollamaEnsureInFlight = null;

/**
 * Ensure Ollama is running and healthy. Concurrent callers share ONE
 * execution. Injectable deps exist purely for unit tests; production uses
 * the real detection/probe/spawn implementations above. Never throws.
 */
function ensureOllamaRunning(deps = {}) {
  if (ollamaEnsureInFlight) return ollamaEnsureInFlight;
  ollamaEnsureInFlight = runOllamaEnsure(deps).finally(() => { ollamaEnsureInFlight = null; });
  return ollamaEnsureInFlight;
}

async function runOllamaEnsure(deps) {
  const startedAt = Date.now();
  const detectInstalled = deps.detectInstalled || detectOllamaInstalled;
  const findExecutable = deps.findExecutable || findOllamaExecutable;
  const probeHealth = deps.probeHealth || probeOllamaHealthAsync;
  const spawnOllama = deps.spawnOllama || spawnOllamaProcess;
  const timeoutMs = typeof deps.timeoutMs === 'number' ? deps.timeoutMs : OLLAMA_START_TIMEOUT_MS;
  const pollIntervalMs = typeof deps.pollIntervalMs === 'number' ? deps.pollIntervalMs : OLLAMA_POLL_INTERVAL_MS;
  const doSleep = deps.sleep || sleep;

  const result = (status, extra) => ({
    status,
    installed: extra && 'installed' in extra ? extra.installed : null,
    running: status === 'running',
    started: !!(extra && extra.started),
    version: (extra && extra.version) || null,
    endpoint: `http://${OLLAMA_HOST}:${OLLAMA_PORT}`,
    durationMs: Date.now() - startedAt,
    error: (extra && extra.error) || null,
  });

  try {
    const installed = detectInstalled();
    if (installed === false) {
      return result('missing', {
        installed: false,
        error: 'Ollama is not installed on this computer.',
      });
    }

    // Fast path: already healthy — never launch a second instance.
    const health = await probeHealth();
    if (health.running) {
      return result('running', { installed: installed !== false, version: health.version });
    }

    const exe = findExecutable();
    if (!exe || !exe.launchable) {
      return result('stopped', {
        installed: installed !== false,
        error: 'Ollama is installed but could not be started automatically on this system. Start Ollama manually and try again.',
      });
    }

    let child;
    try {
      child = spawnOllama(exe.path);
    } catch (e) {
      return result('failed', {
        installed: true,
        error: 'Ollama could not be started automatically.',
      });
    }

    // Track early process death so a failed launch is reported as `failed`
    // instead of burning the whole startup timeout.
    let exited = false;
    let spawnErrored = false;
    if (child && typeof child.on === 'function') {
      child.on('error', () => { spawnErrored = true; });
      child.on('exit', () => { exited = true; });
    }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const now = Date.now();
      if (now >= deadline) break;
      await doSleep(Math.min(pollIntervalMs, deadline - now));
      const probe = await probeHealth();
      if (probe.running) {
        return result('running', { installed: true, started: true, version: probe.version });
      }
      if (spawnErrored || exited) {
        return result('failed', {
          installed: true,
          started: true,
          error: 'Ollama could not be started automatically. Open the Ollama app once, then try again.',
        });
      }
    }

    if (!exited && !spawnErrored) {
      // Process is up but its API has not answered yet within the bounded
      // window — report `starting` (NOT ready) so callers keep polling
      // health instead of assuming success.
      return result('starting', {
        installed: true,
        started: true,
        error: 'Ollama is still starting up.',
      });
    }
    return result('failed', {
      installed: true,
      started: true,
      error: 'Ollama could not be started automatically.',
    });
  } catch (e) {
    return result('failed', {
      installed: null,
      error: 'Ollama could not be started automatically.',
    });
  }
}

// Probe Ollama's /api/version with a short timeout. cb(running, version).
function probeOllamaVersion(cb) {
  let done = false;
  const finish = (running, version) => { if (done) return; done = true; cb(running, version); };
  try {
    const probe = http.get({ hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/version', timeout: 1500 }, (pr) => {
      let data = '';
      pr.on('data', (c) => { data += c; if (data.length > 4096) pr.destroy(); });
      pr.on('error', () => finish(false, null));
      pr.on('end', () => {
        let version = null;
        try { version = (JSON.parse(data) || {}).version || null; } catch {}
        finish(pr.statusCode >= 200 && pr.statusCode < 300, version);
      });
    });
    probe.on('timeout', () => { probe.destroy(); finish(false, null); });
    probe.on('error', () => finish(false, null));
  } catch {
    finish(false, null);
  }
}

// Proxy a request to Ollama. bodyBuffer overrides the client body (used for
// pre-validated payloads such as /api/pull); otherwise the client body is piped.
function proxyToOllama(req, res, targetPath, method, bodyBuffer) {
  const options = {
    hostname: OLLAMA_HOST,
    port: OLLAMA_PORT,
    path: targetPath,
    method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (req.headers.authorization) {
    options.headers['Authorization'] = req.headers.authorization;
  }

  const proxyReq = http.request(options, (proxyRes) => {
    // Forward status and headers, but ensure CORS headers are set
    setCorsHeaders(req, res);
    // Don't forward CORS headers from Ollama, use our own
    const headers = { ...proxyRes.headers };
    delete headers['access-control-allow-origin'];
    delete headers['access-control-allow-private-network'];
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`[Nexuss Connector] Proxy error for ${targetPath}:`, err.message);
    if (!res.headersSent) {
      setCorsHeaders(req, res);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Cannot connect to Ollama at ${OLLAMA_HOST}:${OLLAMA_PORT}. Is Ollama running?` }));
    }
  });

  if (bodyBuffer) {
    proxyReq.end(bodyBuffer);
  } else if (method === 'POST' || method === 'PUT') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

// Trusted workspace root for this process (resolved once at startup).
const WORKSPACE_ROOT = resolveWorkspaceRoot();

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname || '/';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCorsHeaders(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  setCorsHeaders(req, res);

  // Health check for connector itself (does not proxy to Ollama)
  if (pathname === '/health' || pathname === '/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connector: 'nexuss-local', protocol: CONNECTOR_PROTOCOL, version: CONNECTOR_VERSION, ollama: `http://${OLLAMA_HOST}:${OLLAMA_PORT}`, terminal: 'enabled' }));
    return;
  }

  // Ollama status for the automatic setup flow. Server-side probe (fs +
  // /api/version) so the browser gets a truthful installed/running answer
  // without CORS or private-network-access limits. GET only, loopback only.
  if (pathname === '/v1/ollama/status') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
      return;
    }
    const statusOrigin = req.headers.origin;
    if (statusOrigin && !isAllowedOrigin(statusOrigin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Origin ${statusOrigin} not allowed.` }));
      return;
    }
    const installed = detectOllamaInstalled();
    probeOllamaVersion((running, version) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        connector: 'nexuss-local',
        ollama: { installed, running, version, endpoint: `http://${OLLAMA_HOST}:${OLLAMA_PORT}` },
      }));
    });
    return;
  }

  // Ollama startup/recovery for the web chat: verify health, and when the
  // service is stopped launch the TRUSTED detected executable (shell:false,
  // fixed args — the request body can never name a program or command), then
  // poll Ollama's real /api/version until healthy or a bounded timeout.
  // Single-flight server-side: concurrent requests share one attempt.
  // POST only, loopback + origin checked, same protections as /v1/ollama/status.
  if (pathname === '/v1/ollama/ensure') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }
    const ensureOrigin = req.headers.origin;
    if (ensureOrigin && !isAllowedOrigin(ensureOrigin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Origin ${ensureOrigin} not allowed.` }));
      return;
    }
    // Any request body is ignored — startup never accepts client paths or commands.
    req.resume();
    ensureOllamaRunning().then((outcome) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', connector: 'nexuss-local', ollama: outcome }));
    }).catch(() => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        connector: 'nexuss-local',
        ollama: {
          status: 'failed', installed: null, running: false, started: false, version: null,
          endpoint: `http://${OLLAMA_HOST}:${OLLAMA_PORT}`, durationMs: 0,
          error: 'Ollama could not be started automatically.',
        },
      }));
    });
    return;
  }

  // Free/total disk bytes for the volume holding the user's home directory.
  // Read-only (fs.statfs), GET only, loopback + origin checked. Lets the setup
  // wizard show a real "available storage" number instead of a browser guess.
  // Returns { disk: null } when the Node build has no statfs — the UI then
  // reports storage as unavailable rather than zero.
  if (pathname === '/v1/system/disk') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
      return;
    }
    const diskOrigin = req.headers.origin;
    if (diskOrigin && !isAllowedOrigin(diskOrigin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Origin ${diskOrigin} not allowed.` }));
      return;
    }
    let disk = null;
    try {
      if (typeof fs.statfsSync === 'function') {
        const target = os.homedir() || process.cwd();
        const s = fs.statfsSync(target);
        const blockSize = Number(s.bsize || s.blocksize || 4096);
        const freeBytes = Number(s.bavail) * blockSize;
        const totalBytes = Number(s.blocks) * blockSize;
        if (Number.isFinite(freeBytes) && freeBytes >= 0) {
          disk = { freeBytes, totalBytes: Number.isFinite(totalBytes) ? totalBytes : null };
        }
      }
    } catch {
      disk = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connector: 'nexuss-local', disk }));
    return;
  }

  // Model download: validate the model id server-side, then stream Ollama's
  // NDJSON pull progress straight back to the client.
  if (pathname === '/api/pull') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }
    const pullOrigin = req.headers.origin;
    if (pullOrigin && !isAllowedOrigin(pullOrigin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Origin ${pullOrigin} not allowed.` }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body || '{}'); } catch { data = null; }
      const model = data && typeof data.model === 'string' ? data.model.trim() : '';
      if (!data || !/^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,127}$/.test(model)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid model name.' }));
        return;
      }
      data.model = model;
      data.stream = true;
      proxyToOllama(req, res, '/api/pull', 'POST', Buffer.from(JSON.stringify(data), 'utf8'));
    });
    return;
  }

  // Honest capability advertisement: what this connector REALLY offers on the
  // terminal surface. The web app feature-detects this endpoint (older
  // connectors simply 404 and the client falls back to the /health terminal
  // flag), so no protocol bump is needed — the shape itself is the signal.
  if (pathname === '/v1/terminal/capabilities') {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use GET.' }));
      return;
    }
    const capOrigin = req.headers.origin;
    if (capOrigin && !isAllowedOrigin(capOrigin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Origin ${capOrigin} not allowed.` }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      connector: 'nexuss-local',
      protocol: CONNECTOR_PROTOCOL,
      version: CONNECTOR_VERSION,
      capabilities: { run: true, test: true }
    }));
    return;
  }

  // Terminal endpoint: POST /v1/terminal/run -> real Windows process, gated by
  // the command policy AND the workspace boundary.
  if (pathname === '/v1/terminal/run') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Origin ${origin} not allowed.` }));
      return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      (async () => {
        try {
          const respondEarly = (status, payload) => {
            if (res.headersSent || res.writableEnded || res.destroyed) return;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
          };
          if (!WORKSPACE_ROOT) {
            respondEarly(500, { error: 'Workspace is not available on this machine.' });
            return;
          }
          const data = JSON.parse(body || '{}');
          const command = (data.command || '').trim();
          if (!command) {
            respondEarly(400, { error: 'command is required' });
            return;
          }
          // Reuse native policy: allow | for PowerShell pipelines, block && and ||
          if (FORBIDDEN_PIPE_CHAIN.test(command)) {
            respondEarly(400, { error: 'Shell chaining && and || is not allowed.' });
            return;
          }
          const isPowerShell = command.toLowerCase().includes('get-childitem') || command.toLowerCase().includes('get-psdrive') || command.toLowerCase().startsWith('powershell') || command.toLowerCase().startsWith('pwsh');
          if (!isPowerShell && /[|]/.test(command)) {
            respondEarly(400, { error: 'Pipe | is only allowed for PowerShell terminal commands.' });
            return;
          }
          if (!isPowerShell && FORBIDDEN_META.test(command)) {
            respondEarly(400, { error: 'Shell metacharacters are not allowed.' });
            return;
          }
          if (isPowerShell && FORBIDDEN_META_POWERSHELL.test(command)) {
            respondEarly(400, { error: 'Shell metacharacters are not allowed.' });
            return;
          }
          const tokens = tokenizeCommand(command.trim());
          if (!tokens || tokens.length === 0) {
            respondEarly(400, { error: 'Command could not be parsed.' });
            return;
          }
          const bin = tokens[0].toLowerCase();
          if (!ALLOWED_BINS_LOWER.has(bin)) {
            respondEarly(400, { error: `"${bin}" is not an allowed command.` });
            return;
          }
          // Workspace boundary: no absolute path inside the command may escape
          // the trusted root (or be a UNC share). Checked BEFORE any spawn.
          const pathViolation = findCommandPathViolation(WORKSPACE_ROOT, command);
          if (pathViolation) {
            respondEarly(400, { error: pathViolation });
            return;
          }
          // Workspace boundary: client cwd is untrusted — must resolve inside
          // the root (absolute-inside-root, or relative without `..`).
          const cwdCheck = validateConnectorCwd(WORKSPACE_ROOT, data.cwd);
          if (!cwdCheck.ok) {
            respondEarly(400, { error: cwdCheck.error });
            return;
          }
          const cwd = cwdCheck.cwd;
          const { spawn } = require('child_process');
          const start = Date.now();
          let responded = false;
          const respond = (payload) => {
            if (responded || res.writableEnded || res.destroyed) return;
            responded = true;
            try {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(payload));
            } catch {}
          };
          const basePayload = { command, cwd };

          // ---- Node-side simple commands (NEVER routed through cmd.exe) ----
          // cat/dir/ls/echo/pwd are implemented in-process with per-path
          // boundary revalidation immediately before each filesystem op.
          if (bin === 'cat' || bin === 'dir' || bin === 'ls' || bin === 'echo' || bin === 'pwd') {
            const MAX = 512 * 1024;
            const clip = (s) => (Buffer.byteLength(s, 'utf8') <= MAX ? s : s.slice(0, MAX));
            const finishSimple = (ok, stdout, stderr, exitCode) => {
              respond({
                ...basePayload, success: ok, stdout: clip(stdout || ''), stderr: clip(stderr || ''),
                exitCode, signal: null, durationMs: Date.now() - start, timedOut: false, killed: false,
                outputTruncated: false, redacted: false
              });
            };
            if (bin === 'echo') {
              finishSimple(true, tokens.slice(1).join(' ') + '\r\n', '', 0);
              return;
            }
            if (bin === 'pwd') {
              finishSimple(true, cwd + '\r\n', '', 0);
              return;
            }
            // Flags like /b or -Force are ignored for these built-ins; at most one path.
            const pathArgs = tokens.slice(1).filter((t) => !/^[-/][A-Za-z0-9]+$/.test(t));
            if (bin === 'cat') {
              if (pathArgs.length !== 1) {
                finishSimple(false, '', 'cat accepts a single file path.', 1);
                return;
              }
              const resolved = resolveSimpleArgPath(WORKSPACE_ROOT, cwd, pathArgs[0]);
              if (!resolved.ok) {
                respondEarly(400, { error: resolved.error });
                return;
              }
              // Revalidate immediately before reading (TOCTOU mitigation).
              let stat = null;
              try { stat = fs.statSync(resolved.abs); } catch { stat = null; }
              if (!stat || !stat.isFile()) {
                finishSimple(false, '', 'File not found.', 1);
                return;
              }
              let content = '';
              try { content = fs.readFileSync(resolved.abs, 'utf8'); } catch (e) {
                finishSimple(false, '', `Could not read file: ${e.message || 'unknown error'}`, 1);
                return;
              }
              finishSimple(true, content, '', 0);
              return;
            }
            // dir / ls — list a directory (default: cwd).
            const targetArg = pathArgs.length === 0 ? null : (pathArgs.length === 1 ? pathArgs[0] : null);
            if (pathArgs.length > 1) {
              finishSimple(false, '', 'dir accepts a single path.', 1);
              return;
            }
            let dirAbs = cwd;
            if (targetArg) {
              const resolved = resolveSimpleArgPath(WORKSPACE_ROOT, cwd, targetArg);
              if (!resolved.ok) {
                respondEarly(400, { error: resolved.error });
                return;
              }
              dirAbs = resolved.abs;
            }
            let entries = null;
            try { entries = fs.readdirSync(dirAbs); } catch {
              finishSimple(false, '', 'Directory not found.', 1);
              return;
            }
            finishSimple(true, entries.join('\r\n') + (entries.length ? '\r\n' : ''), '', 0);
            return;
          }

          // ---- Spawn path for everything else (shell:false, never cmd.exe) ----
          let spawnCmd, spawnArgs;
          const isPsBin = /^(powershell|pwsh)(\.exe)?$/i.test(tokens[0]) || /^(get-childitem|get-psdrive)$/i.test(tokens[0]);
          if (isPsBin) {
            // PowerShell: hand the -Command payload to powershell.exe VERBATIM so quoting
            // inside the script (quoted paths, $env: expansion) is interpreted by
            // PowerShell exactly as authored. Re-tokenizing stripped those quotes and
            // broke every path containing a space.
            // NOTE: internal/app templates intentionally target Windows PowerShell 5.1
            // (`powershell`); `Set-Content -Encoding Byte` is 5.1-only. pwsh (7+) remains
            // allowed for user-authored commands but is not the template default.
            const lowerCmd = command.toLowerCase();
            const cmdIdx = lowerCmd.indexOf('-command');
            const headRaw = (cmdIdx >= 0 ? command.slice(0, cmdIdx) : tokens[0]).trim();
            const headWords = tokenizeCommand(headRaw) || [tokens[0]];
            const flags = headWords.slice(1).filter((w) => w.startsWith('-'));
            const isShell = /^(powershell|pwsh)(\.exe)?$/i.test(tokens[0]);
            let script = null;
            if (cmdIdx >= 0) script = command.slice(cmdIdx + '-command'.length).trim();
            else if (!isShell) script = command;
            if (!script) {
              spawnCmd = tokens[0];
              spawnArgs = tokens.slice(1);
            } else {
              if (script.length >= 2 && script.startsWith('"') && script.endsWith('"')) script = script.slice(1, -1);
              spawnCmd = isShell ? tokens[0] : 'powershell';
              spawnArgs = [...(flags.length ? flags : ['-NoProfile']), '-Command', script];
            }
          } else {
            spawnCmd = tokens[0];
            spawnArgs = tokens.slice(1);
          }
          // Spawn with shell:false, windowsHide:true, detached false on win32
          const env = { ...process.env };
          const child = spawn(spawnCmd, spawnArgs, { cwd, env, windowsHide: true, shell: false, detached: process.platform !== 'win32' });
          let stdout = '', stderr = '', stdoutBytes=0, stderrBytes=0;
          const MAX = 512*1024;
          let truncated=false;
          const append = (buf, text, isStdout) => {
            const enc = Buffer.byteLength(text, 'utf8');
            if (isStdout) {
              if (stdoutBytes + enc <= MAX) { stdout+=text; stdoutBytes+=enc; } else truncated=true;
            } else {
              if (stderrBytes + enc <= MAX) { stderr+=text; stderrBytes+=enc; } else truncated=true;
            }
          };
          child.stdout && child.stdout.on('data', c=> append(stdout, c.toString('utf8'), true));
          child.stderr && child.stderr.on('data', c=> append(stderr, c.toString('utf8'), false));
          const timeoutMs = Math.min(120000, Math.max(1000, data.timeoutMs || 120000));
          let timedOut=false, killed=false;
          const timer = setTimeout(()=>{ timedOut=true; try{ if(process.platform==='win32'){ spawn('taskkill',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore'}).unref(); } else { process.kill(-child.pid,'SIGTERM'); setTimeout(()=>{ try{ process.kill(-child.pid,'SIGKILL'); }catch{} },1500).unref(); } }catch{} }, timeoutMs);
          // Guard against double responses: 'error' and 'close' can BOTH fire
          // (e.g. spawn ENOENT from a missing cwd). Writing headers twice used
          // to throw ERR_HTTP_HEADERS_SENT and kill the whole connector.
          child.on('close', (code, signal) => {
            clearTimeout(timer);
            // Basic redaction of secrets (same as native/redact)
            const redact = (s) => s.replace(/sk-[a-zA-Z0-9]{20,}/g,'***REDACTED***').replace(/ghp_[a-zA-Z0-9]{20,}/g,'***REDACTED***').replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g,'***REDACTED***');
            const out = redact(stdout);
            const err = redact(stderr);
            const success = !timedOut && !killed && code===0 && signal===null;
            respond({
              success, stdout: out, stderr: err, exitCode: code, signal, durationMs: Date.now()-start, timedOut, killed, outputTruncated: truncated, redacted: out!==stdout||err!==stderr, command, cwd
            });
          });
          child.on('error', (err) => {
            clearTimeout(timer);
            respond({ success:false, stdout:"", stderr: err.message, exitCode: null, signal: null, durationMs: Date.now()-start, timedOut:false, killed:false, outputTruncated:false, redacted:false, command, cwd });
          });
        } catch (e) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(e.message||e) }));
          }
        }
      })();
    });
    return;
  }

  // Explicit allowlist of proxied Ollama paths (everything else 404s).
  // /api/pull is handled above with extra validation.
  const allowedPaths = new Set([
    '/v1/models', '/v1/chat/completions', '/v1/embeddings',
    '/models', '/chat/completions',
    '/api/tags', '/api/version',
    '/health', '/',
  ]);
  if (!allowedPaths.has(pathname)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Allowed: /v1/models, /v1/chat/completions, /api/tags, /api/pull.' }));
    return;
  }

  // Validate origin
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Origin ${origin} not allowed.` }));
    return;
  }

  // Proxy to Ollama (client body piped for POST)
  const targetPath = pathname + (parsed.search || '');
  proxyToOllama(req, res, targetPath, req.method, null);
});

function startServer() {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Another process already owns the port. Classify it, exactly once, and
      // ALWAYS terminate with a truthful exit code + actionable message:
      //   - answers /health 200 -> a healthy connector is running: exit 0;
      //   - answers otherwise / errors -> a foreign process holds the port: exit 1;
      //   - accepts TCP but never answers within 2s (silent occupant): exit 1.
      // Previously the timeout branch destroyed the probe without exiting, so
      // the process could leave silently and launchers believed the connector
      // had started when nothing was listening. The occupant is never killed.
      let settled = false;
      const finish = (code, msg) => {
        if (settled) return;
        settled = true;
        try {
          fs.writeSync(code === 0 ? 1 : 2, msg + '\n');
        } catch {
          if (code === 0) console.log(msg); else console.error(msg);
        }
        process.exit(code);
      };
      const probe = http.get(`http://127.0.0.1:${CONNECTOR_PORT}/health`, (pr) => {
        pr.resume();
        if (pr.statusCode === 200) {
          finish(0, `[Nexuss Connector] Port ${CONNECTOR_PORT} already served by a healthy connector. Nothing to start.`);
        }
        finish(1, `[Nexuss Connector] Port ${CONNECTOR_PORT} is in use by another process that answered /health with HTTP ${pr.statusCode}. Stop that process first, then start the connector again.`);
      });
      probe.on('error', () => {
        finish(1, `[Nexuss Connector] Port ${CONNECTOR_PORT} is in use, but that process is not the Nexuss connector (no /health). Stop the program using port ${CONNECTOR_PORT}, then start the connector again.`);
      });
      probe.setTimeout(2000, () => {
        finish(1, `[Nexuss Connector] Port ${CONNECTOR_PORT} is in use by a process that did not answer /health within 2000 ms. Stop that program (check Task Manager), then start the connector again.`);
        probe.destroy();
      });
      return;
    }
    console.error(`[Nexuss Connector] Server error:`, err);
    process.exit(1);
  });

  server.listen(CONNECTOR_PORT, '127.0.0.1', () => {
    console.log(`[Nexuss Connector] Running on http://127.0.0.1:${CONNECTOR_PORT}`);
    console.log(`[Nexuss Connector] Forwarding to Ollama at http://${OLLAMA_HOST}:${OLLAMA_PORT}`);
    console.log(`[Nexuss Connector] Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
    console.log(`[Nexuss Connector] Workspace root: ${WORKSPACE_ROOT || '(unavailable)'}`);
    console.log(`[Nexuss Connector] For production https://www.nexuss.in to access your local Ollama, keep this running.`);
  });
}

// Start only when executed directly (node server.js / the downloaded asset).
// When required by tests, export the policy + boundary helpers instead.
if (require.main === module) {
  startServer();
}

module.exports = {
  FORBIDDEN_META,
  FORBIDDEN_PIPE_CHAIN,
  FORBIDDEN_META_POWERSHELL,
  ALLOWED_BINS,
  tokenizeCommand,
  isAllowedOrigin,
  WORKSPACE_ROOT,
  resolveWorkspaceRoot,
  validateConnectorCwd,
  findCommandPathViolation,
  extractPathCandidates,
  isInsideRoot,
  isUNCPath,
  isAbsolutePath,
  realpathAllowingMissing,
  resolveSimpleArgPath,
  // Ollama install/startup helpers — exported for the unit test suite only.
  // The HTTP surface above is the only way the browser can reach them.
  detectOllamaInstalled,
  findOllamaExecutable,
  ensureOllamaRunning,
};
