import './load-env.mjs';
import crypto from 'node:crypto';
import http from 'node:http';
import { handleSupabaseRequest } from './supabase-backend.mjs';

const BACKEND_MODE = String(process.env.BACKEND_MODE || 'supabase').trim().toLowerCase();
const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30000);
const MAX_CACHE_ENTRIES = Number(process.env.MAX_CACHE_ENTRIES || 500);
const CORS_ALLOWED_ORIGINS = String(process.env.CORS_ALLOWED_ORIGINS || '*')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const READ_PATHS = new Set([
  '/health',
  '/boxes/search',
  '/boxes/get',
  '/audit/list',
  '/audit/by-box',
  '/allocations/by-box',
  '/allocations/jobs',
  '/allocations/by-job',
  '/allocations/preview',
  '/jobs/list',
  '/jobs/get',
  '/film-orders/list',
  '/film-data/catalog',
  '/roll-history/by-box',
  '/reports/summary'
]);

const cache = new Map();

function normalizePath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function parseBodyJson(bodyText) {
  const trimmed = String(bodyText || '').trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    return null;
  }
}

function hashBody(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function shouldUseCache(method, logicalPath) {
  if (!Number.isFinite(CACHE_TTL_MS) || CACHE_TTL_MS <= 0) {
    return false;
  }

  if (method === 'GET') {
    return true;
  }

  if (method === 'POST') {
    return READ_PATHS.has(logicalPath);
  }

  return false;
}

function isMutation(method, logicalPath) {
  return method === 'POST' && logicalPath && !READ_PATHS.has(logicalPath);
}

function getCacheKey(method, routeKey, requestBody, authKey) {
  if (method === 'POST') {
    return `${method}|${routeKey}|${hashBody(requestBody)}|${authKey}`;
  }

  return `${method}|${routeKey}|${authKey}`;
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;

  if (!origin || CORS_ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (CORS_ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  if (!chunks.length) {
    return '';
  }

  return Buffer.concat(chunks).toString('utf8');
}

function pruneCache() {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (value.expiresAt <= now) {
      cache.delete(key);
    }
  }

  if (cache.size <= MAX_CACHE_ENTRIES) {
    return;
  }

  const keys = [...cache.keys()];
  const removeCount = cache.size - MAX_CACHE_ENTRIES;
  for (let index = 0; index < removeCount; index += 1) {
    cache.delete(keys[index]);
  }
}

function resolveLogicalPath(requestUrl, bodyJson) {
  const fromQuery = normalizePath(requestUrl.searchParams.get('path'));
  if (fromQuery) {
    return fromQuery;
  }

  const fromBody = normalizePath(bodyJson && typeof bodyJson.path === 'string' ? bodyJson.path : '');
  if (fromBody) {
    return fromBody;
  }

  if (requestUrl.pathname === '/' || requestUrl.pathname === '/api') {
    return '';
  }

  if (requestUrl.pathname.startsWith('/api/')) {
    return normalizePath(requestUrl.pathname.slice(4));
  }

  return normalizePath(requestUrl.pathname);
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: `Unsupported method: ${req.method}` });
    return;
  }

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (requestUrl.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      data: {
        status: 'ok',
        mode: BACKEND_MODE,
        timestamp: new Date().toISOString(),
        sheets: []
      },
      warnings: []
    });
    return;
  }

  const requestBody = req.method === 'POST' ? await readBody(req) : '';
  const bodyJson = req.method === 'POST' ? parseBodyJson(requestBody) : null;
  const logicalPath = resolveLogicalPath(requestUrl, bodyJson);
  const authKey = hashBody(String(req.headers.authorization || ''));
  const useCache = shouldUseCache(req.method, logicalPath);
  const cacheRouteKey =
    req.method === 'POST' ? `${logicalPath}|${requestUrl.search}` : requestUrl.toString();
  const cacheKey = getCacheKey(req.method, cacheRouteKey, requestBody, authKey);

  if (useCache) {
    pruneCache();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.statusCode = cached.statusCode;
      res.setHeader('Content-Type', cached.contentType);
      res.end(cached.body);
      return;
    }
  }

  if (BACKEND_MODE !== 'supabase') {
    sendJson(res, 500, {
      ok: false,
      error: `Unsupported BACKEND_MODE: ${BACKEND_MODE}`
    });
    return;
  }

  const response = await handleSupabaseRequest({
    method: req.method,
    logicalPath,
    requestUrl,
    bodyJson,
    headers: req.headers
  });
  const responseBody = JSON.stringify(response.payload);
  const contentType = 'application/json; charset=utf-8';

  if (useCache && response.statusCode >= 200 && response.statusCode < 400) {
    cache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      statusCode: response.statusCode,
      contentType,
      body: responseBody
    });
  }

  if (isMutation(req.method, logicalPath) && response.statusCode >= 200 && response.statusCode < 400) {
    cache.clear();
  }

  res.statusCode = response.statusCode;
  res.setHeader('Content-Type', contentType);
  res.end(responseBody);
});

server.listen(PORT, () => {
  console.log(`[backend] listening on port ${PORT} (mode=${BACKEND_MODE})`);
});
