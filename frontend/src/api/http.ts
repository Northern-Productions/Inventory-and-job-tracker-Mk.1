import type { ApiEnvelope, AuthUser, JobNumberAmbiguityCandidate } from '../domain';
import { getStoredAuthSession } from '../lib/storage';
import { getSupabaseClient } from '../lib/supabase';

const CONFIGURED_API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() || '';
const PROXY_TARGET = import.meta.env.VITE_PROXY_TARGET?.trim() || '';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL?.trim() || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() || '';
const LOCAL_PROXY_HOSTS = new Set(['localhost', '127.0.0.1']);
const SHOULD_FORWARD_SUPABASE_APIKEY = looksLikeLegacyJwtKey_(SUPABASE_ANON_KEY);
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const AUTH_CONTEXT_TIMEOUT_MS = 10_000;
const SUPABASE_AUTH_TIMEOUT_MS = 10_000;
const AUTH_CONTEXT_BURST_CACHE_MS = 250;

type ResolvedAuthContext = { token: string; user: AuthUser | null };

const authContextBurstCache_ = new Map<
  string,
  { context: ResolvedAuthContext; expiresAt: number }
>();
const authContextInFlight_ = new Map<string, Promise<ResolvedAuthContext>>();

function trimTrailingSlashes_(value: string): string {
  return value.replace(/\/+$/g, '');
}

export function resolveApiBaseUrlFromConfig(options: {
  configuredApiBaseUrl?: string;
  proxyTarget?: string;
  supabaseUrl?: string;
  hostname?: string;
  isDev?: boolean;
}): string {
  const hostname = String(options.hostname || '').trim().toLowerCase();
  if (options.proxyTarget?.trim() && (options.isDev || LOCAL_PROXY_HOSTS.has(hostname))) {
    return '/api';
  }

  const configuredApiBaseUrl = trimTrailingSlashes_(String(options.configuredApiBaseUrl || '').trim());
  const supabaseUrl = trimTrailingSlashes_(String(options.supabaseUrl || '').trim());
  if (configuredApiBaseUrl && configuredApiBaseUrl !== '/api') {
    return configuredApiBaseUrl;
  }

  if (supabaseUrl) {
    return `${supabaseUrl}/functions/v1/api`;
  }

  return configuredApiBaseUrl || '/api';
}

function resolveApiBaseUrl(): string {
  return resolveApiBaseUrlFromConfig({
    configuredApiBaseUrl: CONFIGURED_API_BASE_URL,
    proxyTarget: PROXY_TARGET,
    supabaseUrl: SUPABASE_URL,
    hostname: window.location.hostname,
    isDev: import.meta.env.DEV
  });
}

export class APIError extends Error {
  warnings: string[];
  code?: string;
  jobNumber?: string;
  candidates?: JobNumberAmbiguityCandidate[];

  constructor(
    message: string,
    warnings: string[] = [],
    details: { code?: string; jobNumber?: string; candidates?: JobNumberAmbiguityCandidate[] } = {}
  ) {
    super(message);
    this.name = 'APIError';
    this.warnings = warnings;
    this.code = typeof details.code === 'string' && details.code.trim() ? details.code.trim() : undefined;
    this.jobNumber =
      typeof details.jobNumber === 'string' && details.jobNumber.trim() ? details.jobNumber.trim() : undefined;
    this.candidates = Array.isArray(details.candidates) ? details.candidates : undefined;
  }
}

interface RequestOptions {
  query?: Record<string, string | number | boolean | readonly string[] | string[] | undefined>;
  body?: unknown;
  timeoutMs?: number;
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

      if (Array.isArray(value)) {
        value.forEach((entry) => {
          const normalized = String(entry || '').trim();
          if (!normalized) {
            return;
          }

          url.searchParams.append(key, normalized);
        });
        return;
      }

      url.searchParams.set(key, String(value));
    });
  }

  return url;
}

async function fetchWithTimeout_(input: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new APIError('The API timed out while waiting for a response.');
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

function withTimeout_<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise
      .then((result) => {
        globalThis.clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((error: unknown) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      });
  });
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
          'The API returned HTML instead of JSON. This usually means the frontend API base URL is wrong, the deployment is stale, or the local dev proxy needs a restart.'
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
  const timeoutMs = options.timeoutMs ?? (path === '/auth/context' ? AUTH_CONTEXT_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS);

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

    response = await fetchWithTimeout_(
      buildUrl(path, options.query),
      {
        method,
        headers: buildRequestHeaders(method, authContext.token),
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
      },
      timeoutMs
    );
  } catch (error) {
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError(
      'The API is unreachable. If you are offline, the app shell still works but data requests need a connection.'
    );
  }

  const envelope = await parseEnvelope<T>(response);
  const fallbackErrorMessage = extractEnvelopeMessage_(envelope);
  if (!response.ok || !envelope.ok || envelope.data === undefined) {
    throw new APIError(
      envelope.error || fallbackErrorMessage || 'The request could not be completed.',
      envelope.warnings ?? [],
      {
        code: envelope.code,
        jobNumber: envelope.jobNumber,
        candidates: envelope.candidates
      }
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

function getStoredAuthContext_(
  storedSession: ReturnType<typeof getStoredAuthSession>
): ResolvedAuthContext {
  const token = storedSession?.token?.trim() || '';
  const email = storedSession?.user?.email ? storedSession.user.email.trim() : '';
  if (!token || !email || !storedSession?.user || !isProjectTokenValid_(token)) {
    return { token: '', user: null };
  }

  return {
    token,
    user: {
      ...storedSession.user,
      email
    }
  };
}

function buildAuthContextCacheKey_(token: string): string {
  return token.trim() || '__anonymous__';
}

function readCachedAuthContext_(key: string): ResolvedAuthContext | null {
  const cached = authContextBurstCache_.get(key);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    authContextBurstCache_.delete(key);
    return null;
  }

  return cached.context;
}

function cacheAuthContext_(key: string, context: ResolvedAuthContext): void {
  authContextBurstCache_.set(key, {
    context,
    expiresAt: Date.now() + AUTH_CONTEXT_BURST_CACHE_MS
  });
}

function invalidateAuthContextCache_(key?: string): void {
  if (key) {
    authContextBurstCache_.delete(key);
    authContextInFlight_.delete(key);
    return;
  }

  authContextBurstCache_.clear();
  authContextInFlight_.clear();
}

export function __resetRequestAuthContextCacheForTests(): void {
  invalidateAuthContextCache_();
}

async function resolveFreshAuthContext_(
  storedContext: ResolvedAuthContext
): Promise<{ context: ResolvedAuthContext; shouldCache: boolean }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { context: storedContext, shouldCache: true };
  }

  try {
    const { data, error } = await withTimeout_(
      supabase.auth.getSession(),
      SUPABASE_AUTH_TIMEOUT_MS,
      'Authentication session lookup timed out.'
    );
    if (error || !data.session) {
      return { context: storedContext, shouldCache: false };
    }

    let activeSession = data.session;
    const expiresAtMs =
      Number.isFinite(activeSession.expires_at) && activeSession.expires_at
        ? activeSession.expires_at * 1000
        : 0;
    const shouldRefresh = !expiresAtMs || expiresAtMs <= Date.now() + 60_000;

    if (shouldRefresh) {
      try {
        const { data: refreshed, error: refreshError } = await withTimeout_(
          supabase.auth.refreshSession(),
          SUPABASE_AUTH_TIMEOUT_MS,
          'Authentication session refresh timed out.'
        );
        if (!refreshError && refreshed.session) {
          activeSession = refreshed.session;
        } else {
          return { context: storedContext, shouldCache: false };
        }
      } catch (_error) {
        return { context: storedContext, shouldCache: false };
      }
    }

    const token = activeSession.access_token ? activeSession.access_token.trim() : '';
    const email = activeSession.user?.email ? activeSession.user.email.trim() : '';
    if (!token || !email || !isProjectTokenValid_(token)) {
      return { context: storedContext, shouldCache: false };
    }

    const user = activeSession.user;
    if (!user) {
      return { context: storedContext, shouldCache: false };
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
      context: {
        token,
        user: {
          email,
          hasProfileName: true,
          name: profileName,
          picture: avatar,
          sub: user.id
        }
      },
      shouldCache: true
    };
  } catch (_error) {
    return { context: storedContext, shouldCache: false };
  }
}

async function resolveAuthContext_(): Promise<ResolvedAuthContext> {
  const stored = getStoredAuthSession();
  const storedContext = getStoredAuthContext_(stored);
  const requestKey = buildAuthContextCacheKey_(storedContext.token);
  const cachedContext = readCachedAuthContext_(requestKey);
  if (cachedContext) {
    return cachedContext;
  }

  const inFlightContext = authContextInFlight_.get(requestKey);
  if (inFlightContext) {
    return inFlightContext;
  }

  const promise = resolveFreshAuthContext_(storedContext)
    .then(({ context, shouldCache }) => {
      if (!shouldCache) {
        invalidateAuthContextCache_(requestKey);
        return context;
      }

      const resolvedKey = buildAuthContextCacheKey_(context.token);
      if (resolvedKey !== requestKey) {
        invalidateAuthContextCache_(requestKey);
      }
      cacheAuthContext_(resolvedKey, context);
      return context;
    })
    .finally(() => {
      authContextInFlight_.delete(requestKey);
    });

  authContextInFlight_.set(requestKey, promise);
  return promise;
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
