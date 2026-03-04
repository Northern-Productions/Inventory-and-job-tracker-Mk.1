import type { ApiEnvelope } from '../domain';
import { getStoredAuthSession } from '../lib/storage';

const CONFIGURED_API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() || '';
const PROXY_TARGET = import.meta.env.VITE_PROXY_TARGET?.trim() || '';
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
  const text = await response.text();

  try {
    return JSON.parse(text) as ApiEnvelope<T>;
  } catch (_error) {
    const trimmed = text.trim();
    if (trimmed.startsWith('<')) {
      throw new APIError(
        'The API returned HTML instead of JSON. This usually means the Apps Script deployment URL is wrong, the deployment needs to be updated, or the local dev proxy needs a restart.'
      );
    }

    throw new APIError(`The server returned an unreadable response: ${trimmed.slice(0, 160)}`);
  }
}

export async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options: RequestOptions = {}
): Promise<{ data: T; warnings: string[] }> {
  let response: Response;

  try {
    const authSession = method === 'POST' ? getStoredAuthSession() : null;
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
      headers:
        method === 'POST'
          ? {
              'Content-Type': 'text/plain;charset=utf-8'
            }
          : undefined,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
    });
  } catch (_error) {
    throw new APIError(
      'The API is unreachable. If you are offline, the app shell still works but data requests need a connection.'
    );
  }

  const envelope = await parseEnvelope<T>(response);
  if (!response.ok || !envelope.ok || envelope.data === undefined) {
    throw new APIError(
      envelope.error || 'The request could not be completed.',
      envelope.warnings ?? []
    );
  }

  return {
    data: envelope.data,
    warnings: envelope.warnings ?? []
  };
}
