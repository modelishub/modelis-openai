#!/usr/bin/env node
// modelis-openai — drop-in OpenAI-compatible proxy for Modelis via RapidAPI.
//
// Point any OpenAI-compatible tool (Aider, Cline, Continue, Cursor, ...) at this
// local proxy. It rewrites `Authorization: Bearer <your-RapidAPI-key>` into the
// RapidAPI gateway headers and forwards to the "Modelis Auto Chat" endpoint,
// which auto-routes every request to the best model (GPT / Claude / Gemini)
// and bills a flat, predictable per-call price — not per token.
//
// Zero dependencies. Node 18+. Single file. MIT licensed.
//
//   node modelis-openai.mjs
//   # then point your tool at:  base_url=http://127.0.0.1:8787/v1
//   #                           api_key=<your RapidAPI key>
//
// Get your key (and confirm the host) on the listing's "Endpoints" tab:
//   https://modelishub.com/pricing

import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

// ---- configuration (env-overridable) ----------------------------------------
export const config = {
  rapidHost: process.env.MODELIS_RAPIDAPI_HOST || 'modelis-auto-chat.p.rapidapi.com',
  upstreamPath: process.env.MODELIS_UPSTREAM_PATH || '/v1/chat/completions',
  // 'https' for the real RapidAPI gateway; 'http' is only for local testing.
  upstreamProtocol: process.env.MODELIS_UPSTREAM_PROTOCOL || 'https',
  upstreamPort: process.env.MODELIS_UPSTREAM_PORT ? Number(process.env.MODELIS_UPSTREAM_PORT) : undefined,
  listenHost: process.env.MODELIS_HOST || '127.0.0.1',
  listenPort: Number(process.env.MODELIS_PORT || 8787),
  // Idle socket timeout for the upstream call (ms). LLM streams send bytes
  // regularly, so this is an inactivity timeout, not a total cap.
  upstreamTimeoutMs: Number(process.env.MODELIS_TIMEOUT_MS || 120000),
  // Optional fallback key, so tools that can't send Authorization still work.
  // Security: if you set this AND bind to a non-loopback address, anyone who can
  // reach the port can spend your RapidAPI quota. Prefer per-client keys.
  envKey: (process.env.MODELIS_RAPIDAPI_KEY || '').trim(),
  // Model sent upstream. Modelis' paid line serves `modelis-auto`; we rewrite
  // whatever model name the tool sends so it "just works". Set MODELIS_MODEL=""
  // to pass the tool's model through untouched.
  forceModel: process.env.MODELIS_MODEL ?? 'modelis-auto',
};

const MODEL_IDS = ['modelis-auto'];

// Hop-by-hop headers must not be forwarded between connections (RFC 7230 §6.1).
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'upgrade',
]);

// ---- pure helpers (unit-tested) ---------------------------------------------

/** Extract the RapidAPI key from an Authorization header, falling back to env. */
export function extractKey(authHeader, envKey = '') {
  if (typeof authHeader === 'string') {
    const m = authHeader.match(/^\s*Bearer\s+(.+?)\s*$/i);
    const token = (m ? m[1] : authHeader).trim();
    if (token) return token;
  }
  const fallback = (envKey || '').trim();
  return fallback || null;
}

/**
 * Rewrite the request body's `model` field to `forceModel`.
 * Returns a Buffer. On any parse error (or empty forceModel) the original
 * bytes are returned untouched, so non-JSON / unexpected payloads still flow.
 */
export function rewriteBody(bodyBuf, forceModel) {
  if (!forceModel) return bodyBuf;
  try {
    const obj = JSON.parse(bodyBuf.toString('utf8'));
    if (obj && typeof obj === 'object' && 'model' in obj) {
      obj.model = forceModel;
      return Buffer.from(JSON.stringify(obj), 'utf8');
    }
    return bodyBuf;
  } catch {
    return bodyBuf;
  }
}

/** Build the header set sent to the RapidAPI gateway. */
export function upstreamHeaders(key, host, contentLength) {
  return {
    'content-type': 'application/json',
    'content-length': String(contentLength),
    'x-rapidapi-key': key,
    'x-rapidapi-host': host,
  };
}

/** Forward upstream response headers, stripping hop-by-hop ones. */
export function filterResponseHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/** OpenAI-style /v1/models payload so tools that probe it on startup don't error. */
export function modelsPayload() {
  return {
    object: 'list',
    data: MODEL_IDS.map((id) => ({ id, object: 'model', owned_by: 'modelis' })),
  };
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

// ---- server -----------------------------------------------------------------

export function createServer(cfg = config) {
  return http.createServer((req, res) => {
    const url = req.url || '/';
    const path = url.split('?')[0];

    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      return sendJson(res, 200, { status: 'ok', service: 'modelis-openai', upstream: cfg.rapidHost });
    }
    if (req.method === 'GET' && path.endsWith('/models')) {
      return sendJson(res, 200, modelsPayload());
    }
    if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
      return sendJson(res, 404, { error: { message: `No route for ${req.method} ${path}`, type: 'not_found' } });
    }

    const key = extractKey(req.headers['authorization'], cfg.envKey);
    if (!key) {
      return sendJson(res, 401, {
        error: {
          message: 'Missing RapidAPI key. Put your RapidAPI key as the API key (Bearer token) in your tool, or set MODELIS_RAPIDAPI_KEY.',
          type: 'invalid_request_error',
        },
      });
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => {
      if (!res.headersSent) sendJson(res, 400, { error: { message: 'request read error', type: 'bad_request' } });
      req.destroy();
    });
    req.on('end', () => {
      const body = rewriteBody(Buffer.concat(chunks), cfg.forceModel);
      const client = cfg.upstreamProtocol === 'http' ? http : https;
      const upstream = client.request(
        {
          host: cfg.rapidHost,
          port: cfg.upstreamPort,
          path: cfg.upstreamPath,
          method: 'POST',
          headers: upstreamHeaders(key, cfg.rapidHost, body.length),
        },
        (up) => {
          // Stream the response straight back (handles SSE `stream: true`),
          // relaying upstream headers (rate-limit, cache-control, ...) intact.
          res.writeHead(up.statusCode || 502, filterResponseHeaders(up.headers));
          up.pipe(res);
        },
      );
      // If the client hangs up mid-stream, stop billing for an upstream nobody
      // is reading anymore.
      res.on('close', () => {
        if (!res.writableFinished) upstream.destroy();
      });
      // Inactivity timeout so a stalled upstream can't pin a socket forever.
      if (cfg.upstreamTimeoutMs > 0) {
        upstream.setTimeout(cfg.upstreamTimeoutMs, () => upstream.destroy(new Error('upstream timeout')));
      }
      upstream.on('error', (e) => {
        if (res.writableEnded || res.destroyed) return; // avoid double-end / write after abort
        if (!res.headersSent) {
          sendJson(res, 502, { error: { message: `upstream error: ${e.message}`, type: 'upstream_error' } });
        } else {
          res.end();
        }
      });
      upstream.end(body);
    });
  });
}

/** True when an env key is exposed on a non-loopback bind (open-relay risk). */
export function isOpenRelay(cfg) {
  const loopback = cfg.listenHost === '127.0.0.1' || cfg.listenHost === 'localhost' || cfg.listenHost === '::1';
  return Boolean(cfg.envKey) && !loopback;
}

export function start(cfg = config) {
  if (isOpenRelay(cfg)) {
    console.warn(
      `WARNING: MODELIS_RAPIDAPI_KEY is set while bound to ${cfg.listenHost} (non-loopback). ` +
        'Anyone who can reach this port can spend your RapidAPI quota. ' +
        'Unset the key (let each client send its own) or restrict network access.',
    );
  }
  const server = createServer(cfg);
  server.listen(cfg.listenPort, cfg.listenHost, () => {
    const base = `http://${cfg.listenHost}:${cfg.listenPort}/v1`;
    console.log(`modelis-openai listening on ${base}`);
    console.log(`  forwarding -> https://${cfg.rapidHost}${cfg.upstreamPath}`);
    console.log(`  point your OpenAI-compatible tool at base_url=${base} and use your RapidAPI key`);
    if (cfg.forceModel) console.log(`  model rewritten to "${cfg.forceModel}" (set MODELIS_MODEL="" to pass through)`);
  });
  return server;
}

// Start only when run directly (so tests can import the helpers safely).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) start();
