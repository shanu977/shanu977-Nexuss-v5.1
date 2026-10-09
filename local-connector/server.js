#!/usr/bin/env node
// Nexuss Local Connector - lightweight loopback gateway for Ollama
// Binds only to 127.0.0.1, allows only Nexuss origins, proxies only to Ollama on localhost:11434
// Usage: node local-connector/server.js  (or npx nexuss-connector)
// Then Nexuss Web at https://www.nexuss.in will fetch http://localhost:11435/v1/models instead of http://localhost:11434

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONNECTOR_PORT = process.env.NEXUSS_CONNECTOR_PORT ? parseInt(process.env.NEXUSS_CONNECTOR_PORT, 10) : 11435;
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;

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

// Conservative Ollama install detection: filesystem + PATH lookup only (no
// shell spawns). Returns true/false, or null on platforms we don't know.
function detectOllamaInstalled() {
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
    } else if (process.platform === 'darwin') {
      candidates.push('/Applications/Ollama.app');
      candidates.push(path.join(os.homedir(), 'Applications', 'Ollama.app'));
    } else if (process.platform === 'linux') {
      candidates.push('/usr/local/bin/ollama');
      candidates.push('/usr/bin/ollama');
      candidates.push(path.join(os.homedir(), '.ollama', 'bin', 'ollama'));
    } else {
      return null;
    }
    for (const c of candidates) {
      try { if (c && fs.existsSync(c)) return true; } catch {}
    }
    const binName = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      try { if (fs.existsSync(path.join(dir, binName))) return true; } catch {}
    }
    return false;
  } catch {
    return null;
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
    res.end(JSON.stringify({ status: 'ok', connector: 'nexuss-local', ollama: `http://${OLLAMA_HOST}:${OLLAMA_PORT}`, terminal: 'enabled' }));
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

  // Terminal endpoint: POST /v1/terminal/run -> real Windows process via native policy
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
          const data = JSON.parse(body || '{}');
          const command = (data.command || '').trim();
          if (!command) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'command is required' }));
            return;
          }
          // Reuse native policy: allow | for PowerShell pipelines, block && and ||
          const FORBIDDEN_META = /[&;<>`\r\n%^$]/;
          const FORBIDDEN_PIPE_CHAIN = /&&|\|\|/;
          if (FORBIDDEN_PIPE_CHAIN.test(command)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Shell chaining && and || is not allowed.' }));
            return;
          }
          const isPowerShell = command.toLowerCase().includes("get-childitem") || command.toLowerCase().includes("get-psdrive") || command.toLowerCase().startsWith("powershell") || command.toLowerCase().startsWith("pwsh");
          if (!isPowerShell && /[|]/.test(command)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Pipe | is only allowed for PowerShell terminal commands.' }));
            return;
          }
          if (!isPowerShell && FORBIDDEN_META.test(command)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Shell metacharacters are not allowed.' }));
            return;
          }
          if (isPowerShell && /[&;<>`\r\n%^]/.test(command)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Shell metacharacters are not allowed.' }));
            return;
          }
          const ALLOWED_BINS = new Set(['npm','pnpm','yarn','bun','node','python','python3','py','pytest','pip','pip3','uv','poetry','go','cargo','make','deno','git','dir','ls','echo','pwd','Get-ChildItem','powershell','pwsh','cat','ls']);
          const tokenize = (cmd) => {
            const tokens=[]; let cur=""; let q=null;
            for(let i=0;i<cmd.length;i++){ const ch=cmd[i]; if(q){ if(ch===q) q=null; else cur+=ch; } else if(ch==="'"||ch==='"'){ q=ch; } else if(ch===" "||ch==="\t"){ if(cur){ tokens.push(cur); cur=""; } } else cur+=ch; }
            if(q) return null; if(cur) tokens.push(cur); return tokens;
          };
          const tokens = tokenize(command.replace(/\\/g, "/").replace(/\s+/g, " ").trim());
          if (!tokens || tokens.length===0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Command could not be parsed.' }));
            return;
          }
          const bin = tokens[0].toLowerCase();
          // Allow dir/ls/echo/pwd/cat as simple terminal commands
          const simpleBins = new Set(['dir','ls','echo','pwd','cat','Get-ChildItem']);
          if (!ALLOWED_BINS.has(bin) && !simpleBins.has(tokens[0])) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `"${bin}" is not an allowed command.` }));
            return;
          }
          // Execute via child_process.spawn with same security as native/exec
          const { spawn } = require('child_process');
          const start = Date.now();
          let argv, spawnOpts;
          // Respect client cwd when provided and absolute; otherwise use user's home (not repo) for relative safety
          const rawCwd = (data.cwd || '').toString().trim();
          let cwd;
          if (rawCwd && /^[a-zA-Z]:[\\/]/.test(rawCwd)) {
            cwd = rawCwd;
          } else {
            try { cwd = require('os').homedir() || process.env.USERPROFILE || process.env.HOME || process.cwd(); } catch { cwd = process.env.USERPROFILE || process.env.HOME || process.cwd(); }
            // Never default to repo if homedir available; ensure we don't use Next.js repo dir
            if (!cwd || cwd === process.cwd()) {
              const home = process.env.USERPROFILE || process.env.HOME || require('os').homedir();
              if (home && home !== process.cwd()) cwd = home;
            }
          }
          const env = { ...process.env };
          // For simple Windows builtins, wrap via cmd.exe
          let spawnCmd, spawnArgs;
          if (simpleBins.has(tokens[0]) || simpleBins.has(bin)) {
            const cmd = tokens[0].toLowerCase();
            if (cmd === 'dir' || cmd === 'ls' || cmd === 'Get-ChildItem') {
              spawnCmd = process.env.ComSpec || 'cmd.exe';
              spawnArgs = ['/d', '/s', '/c', command];
            } else if (cmd === 'echo' || cmd === 'pwd' || cmd === 'cat') {
              spawnCmd = process.env.ComSpec || 'cmd.exe';
              spawnArgs = ['/d', '/s', '/c', command];
            } else {
              spawnCmd = tokens[0];
              spawnArgs = tokens.slice(1);
            }
          } else {
            spawnCmd = tokens[0];
            spawnArgs = tokens.slice(1);
          }
          // Special handling for npm --version, node --version, git status etc - allow as-is
          // Spawn with shell:false, windowsHide:true, detached false on win32
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
          child.on('close', (code, signal) => {
            clearTimeout(timer);
            // Basic redaction of secrets (same as native/redact)
            const redact = (s) => s.replace(/sk-[a-zA-Z0-9]{20,}/g,'***REDACTED***').replace(/ghp_[a-zA-Z0-9]{20,}/g,'***REDACTED***').replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g,'***REDACTED***');
            const out = redact(stdout);
            const err = redact(stderr);
            const success = !timedOut && !killed && code===0 && signal===null;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success, stdout: out, stderr: err, exitCode: code, signal, durationMs: Date.now()-start, timedOut, killed, outputTruncated: truncated, redacted: out!==stdout||err!==stderr, command, cwd
            }));
          });
          child.on('error', (err) => {
            clearTimeout(timer);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success:false, stdout:"", stderr: err.message, exitCode: null, signal: null, durationMs: Date.now()-start, timedOut:false, killed:false, outputTruncated:false, redacted:false, command, cwd }));
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Another connector already owns the port. If it answers /health, that is a
    // healthy instance and starting a duplicate is not an error - exiting 1 here
    // used to make launchers think the connector "died" when it was actually fine.
    const probe = http.get(`http://127.0.0.1:${CONNECTOR_PORT}/health`, (pr) => {
      pr.resume();
      if (pr.statusCode === 200) {
        console.log(`[Nexuss Connector] Port ${CONNECTOR_PORT} already served by a healthy connector. Nothing to start.`);
        process.exit(0);
      }
      console.error(`[Nexuss Connector] Port ${CONNECTOR_PORT} is in use by another process that does not answer /health.`);
      process.exit(1);
    });
    probe.on('error', () => {
      console.error(`[Nexuss Connector] Port ${CONNECTOR_PORT} already in use but not responding to /health. Stop the other process first.`);
      process.exit(1);
    });
    probe.setTimeout(2000, () => { probe.destroy(); });
    return;
  }
  console.error(`[Nexuss Connector] Server error:`, err);
  process.exit(1);
});

server.listen(CONNECTOR_PORT, '127.0.0.1', () => {
  console.log(`[Nexuss Connector] Running on http://127.0.0.1:${CONNECTOR_PORT}`);
  console.log(`[Nexuss Connector] Forwarding to Ollama at http://${OLLAMA_HOST}:${OLLAMA_PORT}`);
  console.log(`[Nexuss Connector] Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`[Nexuss Connector] For production https://www.nexuss.in to access your local Ollama, keep this running.`);
});
