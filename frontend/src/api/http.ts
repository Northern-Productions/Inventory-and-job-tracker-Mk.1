import type { ApiEnvelope } from '../domain';
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
  const authSession = getStoredAuthSession();
  const authToken = await resolveAuthToken_(authSession?.token ?? '');

  try {
    const body =
      method === 'POST' && options.body && typeof options.body === 'object' && !Array.isArray(options.body)
        ? {
            ...(options.body as Record<string, unknown>),
            path,
            ...(authToken ? { authToken } : {}),
            ...(authSession?.user ? { authUser: authSession.user } : {})
          }
        : options.body;

    response = await fetch(buildUrl(path, options.query), {
      method,
      headers: buildRequestHeaders(method, authToken),
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
    });
  } catch (_error) {
    throw new APIError(
      'The API is unreachable. If you are offline, the app shell still works but data requests need a connection.'
    );
  }

  const envelope = await parseEnvelope<T>(response);
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

async function resolveAuthToken_(fallbackToken: string): Promise<string> {
  const fallback = fallbackToken.trim();
  const supabase = getSupabaseClient();
  if (!supabase) {
    return fallback;
  }

  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) {
      return fallback;
    }

    return data.session.access_token.trim() || fallback;
  } catch (_error) {
    return fallback;
  }
}
