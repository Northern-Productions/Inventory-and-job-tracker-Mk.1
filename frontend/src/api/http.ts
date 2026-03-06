import type { ApiEnvelope, AuthSession, AuthUser } from '../domain';
import { getStoredAuthSession, setStoredAuthSession } from '../lib/storage';
import { getSupabaseClient } from '../lib/supabase';

const CONFIGURED_API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() || '';
const PROXY_TARGET = import.meta.env.VITE_PROXY_TARGET?.trim() || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || '';
const LOCAL_PROXY_HOSTS = new Set(['localhost', '127.0.0.1']);

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

  if (SUPABASE_ANON_KEY) {
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
  let authSession: AuthSession | null = null;

  try {
    authSession = await resolveRequestAuthSession_();
    const body =
      method === 'POST' && options.body && typeof options.body === 'object' && !Array.isArray(options.body)
        ? {
            ...(options.body as Record<string, unknown>),
            path,
            ...(authSession?.token ? { authToken: authSession.token } : {}),
            ...(authSession?.user ? { authUser: authSession.user } : {})
          }
        : options.body;

    response = await fetch(buildUrl(path, options.query), {
      method,
      headers: buildRequestHeaders(method, authSession?.token ?? ''),
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

async function resolveRequestAuthSession_(): Promise<AuthSession | null> {
  const stored = getStoredAuthSession();

  const supabase = getSupabaseClient();
  if (!supabase) {
    return stored;
  }

  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session || !data.session.access_token || !data.session.user?.email) {
      setStoredAuthSession(null);
      return null;
    }

    const email = data.session.user.email.trim();
    if (!email) {
      return stored;
    }

    const mapped = mapSupabaseSessionToAuthSession_(data.session.access_token, data.session.expires_at, {
      email,
      id: data.session.user.id,
      metadata:
        data.session.user.user_metadata && typeof data.session.user.user_metadata === 'object'
          ? (data.session.user.user_metadata as Record<string, unknown>)
          : null
    });

    setStoredAuthSession(mapped);
    return mapped;
  } catch (_error) {
    setStoredAuthSession(null);
    return null;
  }
}

function mapSupabaseSessionToAuthSession_(
  accessToken: string,
  expiresAtSeconds: number | undefined,
  user: { email: string; id: string; metadata: Record<string, unknown> | null }
): AuthSession {
  const userName = readUserMetadataField_(user.metadata, 'full_name') ||
    readUserMetadataField_(user.metadata, 'name') ||
    deriveNameFromEmail_(user.email);
  const picture = readUserMetadataField_(user.metadata, 'avatar_url');

  const authUser: AuthUser = {
    email: user.email,
    hasProfileName: true,
    name: userName,
    picture,
    sub: user.id
  };

  const issuedAt = Date.now();
  const expiresAt =
    Number.isFinite(expiresAtSeconds) && expiresAtSeconds
      ? expiresAtSeconds * 1000
      : issuedAt + 60 * 60 * 1000;

  return {
    token: accessToken,
    user: authUser,
    issuedAt,
    expiresAt
  };
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
