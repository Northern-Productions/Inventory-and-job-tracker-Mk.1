import type { ApiEnvelope, AuthUser } from '../domain';
import { getStoredAuthSession } from '../lib/storage';
import { getSupabaseClient } from '../lib/supabase';

const CONFIGURED_API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() || '';
const PROXY_TARGET = import.meta.env.VITE_PROXY_TARGET?.trim() || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || '';
const LOCAL_PROXY_HOSTS = new Set(['localhost', '127.0.0.1']);
const SHOULD_FORWARD_SUPABASE_APIKEY = looksLikeLegacyJwtKey_(SUPABASE_ANON_KEY);

function isLocalProxyEnabled(): boolean {
  return Boolean(PROXY_TARGET) && LOCAL_PROXY_HOSTS.has(window.location.hostname);
}

function resolveApiBaseUrl(): string {
  if (isLocalProxyEnabled()) {
    return '/api';
  }

  return CONFIGURED_API_BASE_URL || '/api';
}

export class APIError extends Error {
  warnings: string[];

  constructor(message: string, warnings: string[] = []) {
    super(message);
    this.name = 'APIError';
    this.warnings = warnings;
  }
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

function buildRequestHeaders(method: 'GET' | 'POST', authToken: string): Record<string, string> | undefined {
  const headers: Record<string, string> = {};

  if (method === 'POST') {
    headers['Content-Type'] = 'text/plain;charset=utf-8';
  }

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  // Supabase publishable keys are not JWTs (e.g. "sb_publishable_*").
  // Sending those in `apikey` can trigger "Invalid JWT" at the edge gateway.
  if (SHOULD_FORWARD_SUPABASE_APIKEY) {
    headers.apikey = SUPABASE_ANON_KEY;
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function buildUrl(path: string, query?: RequestOptions['query']): URL {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(resolveApiBaseUrl(), window.location.origin);
  url.searchParams.set('path', normalizedPath);

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === '') {
        return;
      }

      url.searchParams.set(key, String(value));
    });
  }

  return url;
}

async function parseEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  try {
    return (await response.clone().json()) as ApiEnvelope<T>;
  } catch (_error) {
    const text = await response.text();
    const trimmed = text.trim();

    if (!trimmed) {
      throw new APIError('The server returned an empty response.');
    }

    try {
      return JSON.parse(trimmed) as ApiEnvelope<T>;
    } catch (_parseError) {
      if (trimmed.startsWith('<')) {
        throw new APIError(
          'The API returned HTML instead of JSON. This usually means the Apps Script deployment URL is wrong, the deployment needs to be updated, or the local dev proxy needs a restart.'
        );
      }

      throw new APIError(`The server returned an unreadable response: ${trimmed.slice(0, 160)}`);
    }
  }
}

export async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options: RequestOptions = {}
): Promise<{ data: T; warnings: string[] }> {
  let response: Response;
  const authContext = await resolveAuthContext_();

  try {
    const body =
      method === 'POST' && options.body && typeof options.body === 'object' && !Array.isArray(options.body)
        ? {
            ...(options.body as Record<string, unknown>),
            path,
            ...(authContext.token ? { authToken: authContext.token } : {}),
            ...(authContext.token && authContext.user ? { authUser: authContext.user } : {})
          }
        : options.body;

    response = await fetch(buildUrl(path, options.query), {
      method,
      headers: buildRequestHeaders(method, authContext.token),
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
    });
  } catch (_error) {
    throw new APIError(
      'The API is unreachable. If you are offline, the app shell still works but data requests need a connection.'
    );
  }

  const envelope = await parseEnvelope<T>(response);
  if (import.meta.env.DEV && response.status === 401) {
    const jwtDebug = describeJwt_(authContext.token);
    console.warn('[auth-debug] 401 response', {
      path,
      apiBaseUrl: resolveApiBaseUrl(),
      hasToken: Boolean(authContext.token),
      tokenPrefix: authContext.token ? `${authContext.token.slice(0, 16)}...` : '',
      tokenIssuer: jwtDebug.iss,
      tokenExpIso: jwtDebug.expIso
    });
  }
  const fallbackErrorMessage = extractEnvelopeMessage_(envelope);
  if (!response.ok || !envelope.ok || envelope.data === undefined) {
    throw new APIError(
      envelope.error || fallbackErrorMessage || 'The request could not be completed.',
      envelope.warnings ?? []
    );
  }

  return {
    data: envelope.data,
    warnings: envelope.warnings ?? []
  };
}

function extractEnvelopeMessage_(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '';
  }

  const envelopeLike = value as Record<string, unknown>;
  if (typeof envelopeLike.message === 'string' && envelopeLike.message.trim()) {
    return envelopeLike.message.trim();
  }

  if (typeof envelopeLike.error === 'string' && envelopeLike.error.trim()) {
    return envelopeLike.error.trim();
  }

  return '';
}

function looksLikeLegacyJwtKey_(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  return trimmed.split('.').length === 3;
}

async function resolveAuthContext_(): Promise<{ token: string; user: AuthUser | null }> {
  const stored = getStoredAuthSession();
  const supabase = getSupabaseClient();
  if (!supabase) {
    return {
      token: stored?.token?.trim() || '',
      user: stored?.user || null
    };
  }

  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) {
      return { token: '', user: null };
    }

    let activeSession = data.session;
    const expiresAtMs =
      Number.isFinite(activeSession.expires_at) && activeSession.expires_at
        ? activeSession.expires_at * 1000
        : 0;
    const shouldRefresh = !expiresAtMs || expiresAtMs <= Date.now() + 60_000;

    if (shouldRefresh) {
      const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
      if (!refreshError && refreshed.session) {
        activeSession = refreshed.session;
      }
    }

    const token = activeSession.access_token ? activeSession.access_token.trim() : '';
    const email = activeSession.user?.email ? activeSession.user.email.trim() : '';
    if (!token || !email || !isProjectTokenValid_(token)) {
      return { token: '', user: null };
    }

    const user = activeSession.user;
    if (!user) {
      return { token: '', user: null };
    }

    const metadata =
      user.user_metadata && typeof user.user_metadata === 'object'
        ? (user.user_metadata as Record<string, unknown>)
        : null;
    const profileName =
      readUserMetadataField_(metadata, 'full_name') ||
      readUserMetadataField_(metadata, 'name') ||
      deriveNameFromEmail_(email);
    const avatar = readUserMetadataField_(metadata, 'avatar_url');

    return {
      token,
      user: {
        email,
        hasProfileName: true,
        name: profileName,
        picture: avatar,
        sub: user.id
      }
    };
  } catch (_error) {
    return { token: '', user: null };
  }
}

function isProjectTokenValid_(token: string): boolean {
  const parts = token.split('.');
  if (parts.length < 2) {
    return false;
  }

  const payload = decodeJwtPayload_(parts[1]);
  if (!payload) {
    return false;
  }

  const issuer = typeof payload.iss === 'string' ? payload.iss : '';
  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  if (!issuer || !issuer.startsWith(buildExpectedIssuer_())) {
    return false;
  }

  if (exp > 0 && exp * 1000 <= Date.now()) {
    return false;
  }

  return true;
}

function decodeJwtPayload_(encodedPayload: string): Record<string, unknown> | null {
  try {
    const normalized = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = globalThis.atob(padded);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch (_error) {
    return null;
  }
}

function buildExpectedIssuer_(): string {
  const base = import.meta.env.VITE_SUPABASE_URL?.trim() || '';
  return `${base.replace(/\/+$/g, '')}/auth/v1`;
}

function readUserMetadataField_(
  metadata: Record<string, unknown> | null,
  key: string
): string {
  const value = metadata ? metadata[key] : '';
  return typeof value === 'string' ? value.trim() : '';
}

function deriveNameFromEmail_(email: string): string {
  const localPart = email.split('@')[0] || '';
  const sanitized = localPart.replace(/[._-]+/g, ' ').trim();
  return sanitized || 'Inventory User';
}

function describeJwt_(token: string): { iss: string; expIso: string } {
  if (!token) {
    return { iss: '', expIso: '' };
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return { iss: '', expIso: '' };
  }

  const payload = decodeJwtPayload_(parts[1]);
  if (!payload) {
    return { iss: '', expIso: '' };
  }

  const iss = typeof payload.iss === 'string' ? payload.iss : '';
  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  const expIso = exp > 0 ? new Date(exp * 1000).toISOString() : '';
  return { iss, expIso };
}
