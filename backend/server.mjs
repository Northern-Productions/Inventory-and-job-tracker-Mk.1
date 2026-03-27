import './load-env.mjs';
import crypto from 'node:crypto';
import http from 'node:http';
import { handleSupabaseRequest } from './supabase-backend.mjs';

const BACKEND_MODE = String(process.env.BACKEND_MODE || 'supabase').trim().toLowerCase();
const EDGE_API_BASE_URL = resolveEdgeApiBaseUrl_();
const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30000);
const MAX_CACHE_ENTRIES = Number(process.env.MAX_CACHE_ENTRIES || 500);
const CORS_ALLOWED_ORIGINS = String(process.env.CORS_ALLOWED_ORIGINS || '*')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

const cache = new Map();
const LOCAL_FALLBACK_MUTATION_PATHS = new Set([
  '/admin/member-permissions',
  '/admin/user-permissions',
  '/owner/admin-permissions',
  '/owner/notification-preferences',
  '/jobs/set-staged-pickup',
  '/jobs/set-labor-assigned'
]);
const LOCAL_FALLBACK_READ_PATHS = new Set([
  '/owner/reports/asset-total-cost',
  '/jobs/calendar',
  '/jobs/get'
]);

function resolveEdgeApiBaseUrl_() {
  const explicit = String(process.env.EDGE_API_BASE_URL || '').trim();
  if (explicit) {
    return explicit;
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || '')
    .trim()
    .replace(/\/+$/g, '');
  if (!supabaseUrl) {
    return '';
  }

  return `${supabaseUrl}/functions/v1/api`;
}

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

  if (logicalPath === '/auth/context') {
    return false;
  }

  return method === 'GET';
}

function isMutation(method, logicalPath) {
  return method === 'POST' && Boolean(logicalPath);
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

function copyHeader(sourceHeaders, targetHeaders, name) {
  const value = sourceHeaders[name] || sourceHeaders[name.toLowerCase()] || sourceHeaders[name.toUpperCase()];
  if (typeof value === 'string' && value.trim()) {
    targetHeaders[name] = value;
  }
}

function buildEffectiveHeaders(headers, bodyJson) {
  const effectiveHeaders = { ...headers };
  const existingAuthorization =
    effectiveHeaders.authorization || effectiveHeaders.Authorization || '';
  const bodyToken =
    bodyJson && typeof bodyJson.authToken === 'string'
      ? bodyJson.authToken.trim()
      : '';

  if (!existingAuthorization && bodyToken) {
    effectiveHeaders.authorization = `Bearer ${bodyToken}`;
  }

  return effectiveHeaders;
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

function buildUpstreamUrl(requestUrl, logicalPath) {
  const target = new URL(EDGE_API_BASE_URL);
  if (requestUrl.searchParams.has('path')) {
    target.search = requestUrl.search;
  } else {
    const params = new URLSearchParams(requestUrl.search);
    if (logicalPath) {
      params.set('path', logicalPath);
    }
    target.search = params.toString();
  }
  return target;
}

async function forwardToEdgeApi({ method, logicalPath, requestUrl, requestBody, headers }) {
  if (!EDGE_API_BASE_URL) {
    return {
      statusCode: 500,
      payload: {
        ok: false,
        error: 'Set EDGE_API_BASE_URL or SUPABASE_URL when BACKEND_MODE=supabase.'
      }
    };
  }

  const upstreamHeaders = {};
  copyHeader(headers, upstreamHeaders, 'Authorization');
  copyHeader(headers, upstreamHeaders, 'apikey');
  copyHeader(headers, upstreamHeaders, 'x-client-info');
  if (method === 'POST') {
    upstreamHeaders['Content-Type'] = 'text/plain;charset=utf-8';
  }

  let upstreamUrl;
  try {
    upstreamUrl = buildUpstreamUrl(requestUrl, logicalPath);
  } catch (_error) {
    return {
      statusCode: 500,
      payload: {
        ok: false,
        error: 'EDGE_API_BASE_URL must be a valid absolute URL.'
      }
    };
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method,
      headers: upstreamHeaders,
      body: method === 'POST' ? requestBody : undefined
    });
  } catch (_error) {
    return {
      statusCode: 502,
      payload: {
        ok: false,
        error: 'Unable to reach EDGE_API_BASE_URL. Check Supabase URL and network connectivity.'
      }
    };
  }

  const raw = await upstreamResponse.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : { ok: false, error: 'Upstream returned empty response.' };
  } catch (_error) {
    payload = {
      ok: false,
      error: raw ? `Upstream returned non-JSON response: ${raw.slice(0, 160)}` : 'Upstream returned non-JSON response.'
    };
  }

  return {
    statusCode: upstreamResponse.status,
    payload
  };
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
  const effectiveHeaders = buildEffectiveHeaders(req.headers, bodyJson);
  const logicalPath = resolveLogicalPath(requestUrl, bodyJson);
  const authKey = hashBody(String(effectiveHeaders.authorization || effectiveHeaders.Authorization || ''));
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

  const shouldUseLocalFallback =
    (req.method === 'GET' && LOCAL_FALLBACK_READ_PATHS.has(logicalPath)) ||
    (req.method === 'POST' && LOCAL_FALLBACK_MUTATION_PATHS.has(logicalPath));

  const response = shouldUseLocalFallback
    ? await handleSupabaseRequest({
        method: req.method,
        logicalPath,
        requestUrl,
        bodyJson,
        headers: effectiveHeaders
      })
    : await forwardToEdgeApi({
        method: req.method,
        logicalPath,
        requestUrl,
        requestBody,
        headers: effectiveHeaders
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
