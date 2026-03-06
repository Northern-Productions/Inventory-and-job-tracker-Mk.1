const APPS_SCRIPT_URL = Deno.env.get('APPS_SCRIPT_URL')?.trim() || '';
const CACHE_TTL_MS = Number(Deno.env.get('CACHE_TTL_MS') || '30000');
const MAX_CACHE_ENTRIES = Number(Deno.env.get('MAX_CACHE_ENTRIES') || '500');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')?.trim() || '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')?.trim() || '';
const CORS_ALLOWED_ORIGINS = (Deno.env.get('CORS_ALLOWED_ORIGINS') || '*')
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

type CacheEntry = {
  expiresAt: number;
  status: number;
  contentType: string;
  body: string;
};

const cache = new Map<string, CacheEntry>();
const authIdentityCache = new Map<string, { expiresAt: number; identity: AuthIdentity }>();

function normalizePath(value: string | null | undefined): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function parseBodyJson(bodyText: string): Record<string, unknown> | null {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    return null;
  }
}

async function sha1Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function shouldUseCache(method: string, logicalPath: string): boolean {
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

function isMutation(method: string, logicalPath: string): boolean {
  return method === 'POST' && logicalPath !== '' && !READ_PATHS.has(logicalPath);
}

function getCorsOrigin(request: Request): string {
  const origin = request.headers.get('origin');
  if (!origin || CORS_ALLOWED_ORIGINS.includes('*')) {
    return '*';
  }

  if (CORS_ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }

  return CORS_ALLOWED_ORIGINS[0] || '*';
}

function buildCorsHeaders(request: Request): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', getCorsOrigin(request));
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey, x-client-info');
  headers.set('Vary', 'Origin');
  return headers;
}

function jsonResponse(request: Request, status: number, payload: unknown): Response {
  const headers = buildCorsHeaders(request);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), { status, headers });
}

function pruneCache(): void {
  const now = Date.now();

  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
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

function resolveLogicalPath(requestUrl: URL, bodyJson: Record<string, unknown> | null): string {
  const fromQuery = normalizePath(requestUrl.searchParams.get('path'));
  if (fromQuery) {
    return fromQuery;
  }

  const fromBody = normalizePath(
    bodyJson && typeof bodyJson.path === 'string' ? bodyJson.path : ''
  );
  if (fromBody) {
    return fromBody;
  }

  if (requestUrl.pathname === '/' || requestUrl.pathname.endsWith('/api-proxy')) {
    return '';
  }

  if (requestUrl.pathname.endsWith('/health')) {
    return '/health';
  }

  return normalizePath(requestUrl.pathname);
}

type AuthIdentity = { email: string; name: string; token: string };

function deriveNameFromEmail(email: string): string {
  const localPart = email.split('@')[0] || '';
  const sanitized = localPart.replace(/[._-]+/g, ' ').trim();
  return sanitized || 'Inventory User';
}

function pruneAuthIdentityCache(): void {
  const now = Date.now();
  for (const [key, entry] of authIdentityCache.entries()) {
    if (entry.expiresAt <= now) {
      authIdentityCache.delete(key);
    }
  }
}

async function validateTokenWithSupabase(token: string): Promise<AuthIdentity | null> {
  if (!SUPABASE_URL) {
    return null;
  }

  pruneAuthIdentityCache();
  const cached = authIdentityCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.identity;
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`
    };
    if (SUPABASE_ANON_KEY) {
      headers.apikey = SUPABASE_ANON_KEY;
    }

    const response = await fetch(`${SUPABASE_URL.replace(/\/+$/g, '')}/auth/v1/user`, {
      method: 'GET',
      headers
    });
    if (!response.ok) {
      return null;
    }

    const user = (await response.json()) as Record<string, unknown>;
    const email = typeof user.email === 'string' ? user.email.trim() : '';
    if (!email) {
      return null;
    }

    const metadata =
      user.user_metadata && typeof user.user_metadata === 'object'
        ? (user.user_metadata as Record<string, unknown>)
        : null;
    const metadataName =
      (metadata && typeof metadata.full_name === 'string' ? metadata.full_name.trim() : '') ||
      (metadata && typeof metadata.name === 'string' ? metadata.name.trim() : '');
    const name = metadataName || deriveNameFromEmail(email);

    const identity: AuthIdentity = { email, name, token };
    authIdentityCache.set(token, {
      identity,
      expiresAt: Date.now() + 60_000
    });
    return identity;
  } catch (_error) {
    return null;
  }
}

async function parseAuthIdentity(request: Request): Promise<AuthIdentity | null> {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return null;
  }

  return await validateTokenWithSupabase(token);
}

function buildForwardedPostBody(
  requestBody: string,
  bodyJson: Record<string, unknown> | null,
  authIdentity: AuthIdentity | null
): string {
  const baseBody = bodyJson ? { ...bodyJson } : parseBodyJson(requestBody) || {};
  delete baseBody.authToken;
  delete baseBody.authUser;

  if (!authIdentity) {
    return JSON.stringify(baseBody);
  }

  return JSON.stringify({
    ...baseBody,
    authToken: authIdentity.token,
    authUser: {
      email: authIdentity.email,
      name: authIdentity.name
    }
  });
}

function buildUpstreamUrl(requestUrl: URL, logicalPath: string): URL {
  const upstreamUrl = new URL(APPS_SCRIPT_URL);

  for (const [key, value] of requestUrl.searchParams.entries()) {
    upstreamUrl.searchParams.set(key, value);
  }

  if (logicalPath && !upstreamUrl.searchParams.get('path')) {
    upstreamUrl.searchParams.set('path', logicalPath);
  }

  return upstreamUrl;
}

Deno.serve(async (request: Request) => {
  const corsHeaders = buildCorsHeaders(request);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    return jsonResponse(request, 405, {
      ok: false,
      error: `Unsupported method: ${request.method}`
    });
  }

  const requestUrl = new URL(request.url);

  if (requestUrl.pathname.endsWith('/health')) {
    return jsonResponse(request, 200, {
      ok: true,
      data: {
        status: 'ok',
        mode: 'proxy',
        timestamp: new Date().toISOString()
      },
      warnings: []
    });
  }

  if (!APPS_SCRIPT_URL) {
    return jsonResponse(request, 500, {
      ok: false,
      error: 'APPS_SCRIPT_URL secret is not configured.'
    });
  }

  const requestBody = request.method === 'POST' ? await request.text() : '';
  const bodyJson = request.method === 'POST' ? parseBodyJson(requestBody) : null;
  const logicalPath = resolveLogicalPath(requestUrl, bodyJson);
  const authIdentity = logicalPath === '/health' ? null : await parseAuthIdentity(request);
  if (logicalPath !== '/health' && !authIdentity) {
    return jsonResponse(request, 401, {
      ok: false,
      error: 'Authenticated session is required.'
    });
  }

  const forwardedPostBody =
    request.method === 'POST' ? buildForwardedPostBody(requestBody, bodyJson, authIdentity) : '';
  const upstreamUrl = buildUpstreamUrl(requestUrl, logicalPath);
  const useCache = shouldUseCache(request.method, logicalPath);
  const cacheKey =
    request.method === 'POST'
      ? `${request.method}|${upstreamUrl.toString()}|${await sha1Hex(forwardedPostBody)}`
      : `${request.method}|${upstreamUrl.toString()}`;

  if (useCache) {
    pruneCache();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      const headers = buildCorsHeaders(request);
      headers.set('Content-Type', cached.contentType);
      return new Response(cached.body, {
        status: cached.status,
        headers
      });
    }
  }

  try {
    const upstreamResponse = await fetch(upstreamUrl.toString(), {
      method: request.method,
      headers:
        request.method === 'POST'
          ? {
              'Content-Type': request.headers.get('content-type') || 'text/plain;charset=utf-8'
            }
          : undefined,
      body: request.method === 'POST' ? forwardedPostBody : undefined
    });

    const responseBody = await upstreamResponse.text();
    const contentType =
      upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8';

    if (useCache && upstreamResponse.ok) {
      cache.set(cacheKey, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        status: upstreamResponse.status,
        contentType,
        body: responseBody
      });
    }

    if (isMutation(request.method, logicalPath) && upstreamResponse.ok) {
      cache.clear();
    }

    const headers = buildCorsHeaders(request);
    headers.set('Content-Type', contentType);
    return new Response(responseBody, {
      status: upstreamResponse.status,
      headers
    });
  } catch (_error) {
    return jsonResponse(request, 502, {
      ok: false,
      error: 'The upstream Apps Script backend could not be reached.'
    });
  }
});
