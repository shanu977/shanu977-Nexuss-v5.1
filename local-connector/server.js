#!/usr/bin/env node
// Nexuss Local Connector - lightweight loopback gateway for Ollama
// Binds only to 127.0.0.1, allows only Nexuss origins, proxies only to Ollama on localhost:11434
// Usage: node local-connector/server.js  (or npx nexuss-connector)
// Then Nexuss Web at https://www.nexuss.in will fetch http://localhost:11435/v1/models instead of http://localhost:11434

const http = require('http');
const https = require('https');
const url = require('url');

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

  // Only allow /v1/models and /v1/chat/completions and /api/tags
  const allowedPaths = ['/v1/models', '/v1/chat/completions', '/api/tags', '/health'];
  const isAllowedPath = allowedPaths.some(p => pathname === p || pathname.startsWith(p + '/') || pathname === p.replace('/v1',''));
  // For Ollama, we allow /v1/models, /v1/chat/completions, /api/tags, and also / (for health)
  if (!isAllowedPath && pathname !== '/' && pathname !== '/v1/models' && !pathname.startsWith('/v1/') && !pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Only /v1/models, /v1/chat/completions, /api/tags allowed.' }));
    return;
  }

  // Validate origin
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Origin ${origin} not allowed.` }));
    return;
  }

  // Proxy to Ollama
  const targetPath = pathname + (parsed.search || '');
  const options = {
    hostname: OLLAMA_HOST,
    port: OLLAMA_PORT,
    path: targetPath,
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  // Forward Authorization if present
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

  // Pipe body for POST
  if (req.method === 'POST' || req.method === 'PUT') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Nexuss Connector] Port ${CONNECTOR_PORT} already in use. Is another connector running?`);
  } else {
    console.error(`[Nexuss Connector] Server error:`, err);
  }
  process.exit(1);
});

server.listen(CONNECTOR_PORT, '127.0.0.1', () => {
  console.log(`[Nexuss Connector] Running on http://127.0.0.1:${CONNECTOR_PORT}`);
  console.log(`[Nexuss Connector] Forwarding to Ollama at http://${OLLAMA_HOST}:${OLLAMA_PORT}`);
  console.log(`[Nexuss Connector] Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`[Nexuss Connector] For production https://www.nexuss.in to access your local Ollama, keep this running.`);
});
