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
    res.end(JSON.stringify({ status: 'ok', connector: 'nexuss-local', ollama: `http://${OLLAMA_HOST}:${OLLAMA_PORT}` }));
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
