import { randomUUID } from 'node:crypto';

const ROUTE_TIMING_TARGETS = new Set([
  'POST /film-orders/delete',
  'POST /film-orders/cancel',
  'GET /film-orders/list',
  'GET /film-orders/get',
  'POST /jobs/create',
  'POST /jobs/update',
  'GET /jobs/get',
  'GET /jobs/get-by-id',
  'POST /jobs/complete',
  'POST /jobs/delete',
  'POST /jobs/checkout-all',
  'POST /jobs/set-staged-pickup',
  'POST /audit/undo',
  'POST /boxes/receive',
  'POST /boxes/add',
  'POST /boxes/delete',
  'POST /boxes/update',
  'POST /boxes/set-status',
  'POST /allocations/apply',
  'POST /allocations/remove-box',
  'GET /reports/summary',
]);

/**
 * PURPOSE:
 * Emits DEV-only route timing logs for the slow inventory workflows under
 * investigation without recording request bodies, query params, or auth data.
 *
 * AFFECTS:
 * Local backend fallback diagnostics for high-risk lifecycle mutation and read
 * endpoints under timeout investigation.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Supabase Edge route-timing helper, affected route list, and timeout tracing
 * plans before/after planner performance changes.
 *
 * COMMON FAILURE MODES:
 * Logging in production, leaking payload identifiers, or missing a target route
 * and losing before/after timing evidence.
 */

function normalizeMethod(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeRoute(value) {
  const path = String(value || '').split('?')[0].trim();
  if (!path) {
    return '';
  }
  return path.startsWith('/') ? path : `/${path}`;
}

function normalizeCacheState(value) {
  return value === 'hit' || value === 'miss' ? value : 'none';
}

function normalizeRequestId(value) {
  if (Array.isArray(value)) {
    return normalizeRequestId(value[0]);
  }
  const normalized = String(value || '').trim().split(/[\s,]/)[0] || '';
  return normalized.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 128);
}

function isTruthyEnvFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isRouteTimingEnabled(env = process.env) {
  return isTruthyEnvFlag(env.DEV_ROUTE_TIMING_LOGS) || String(env.NODE_ENV || '').trim() === 'development';
}

function isRouteTimingTarget(method, route) {
  return ROUTE_TIMING_TARGETS.has(`${normalizeMethod(method)} ${normalizeRoute(route)}`);
}

function resolveRouteTimingRequestId(headers = {}) {
  return (
    normalizeRequestId(headers['x-request-id']) ||
    normalizeRequestId(headers['X-Request-Id']) ||
    normalizeRequestId(headers['x-vercel-id']) ||
    normalizeRequestId(headers['X-Vercel-Id']) ||
    randomUUID()
  );
}

function classifyDurationBucket(durationMs) {
  const normalized = Number.isFinite(Number(durationMs)) ? Math.max(0, Number(durationMs)) : 0;
  if (normalized < 1000) {
    return 'fast';
  }
  if (normalized <= 5000) {
    return 'slow';
  }
  return 'timeout-risk';
}

function normalizeErrorCategory(value) {
  const normalized = String(value || '').trim().split(/[\s:]/)[0] || '';
  return normalized.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
}

function getRouteTimingErrorCategory(error) {
  if (!error) {
    return '';
  }
  if (error.constructor?.name) {
    return normalizeErrorCategory(error.constructor.name);
  }
  return normalizeErrorCategory(typeof error);
}

function buildRouteTimingLogEntry({
  runtime,
  method,
  route,
  statusCode,
  ok,
  durationMs,
  cache = 'none',
  requestId,
  errorCategory = '',
}) {
  const roundedDurationMs = Math.max(0, Math.round(Number(durationMs) || 0));
  const entry = {
    level: 'info',
    msg: 'route_timing',
    runtime,
    method: normalizeMethod(method),
    route: normalizeRoute(route),
    statusCode: Number.isFinite(Number(statusCode)) ? Number(statusCode) : 500,
    ok: Boolean(ok),
    durationMs: roundedDurationMs,
    durationBucket: classifyDurationBucket(roundedDurationMs),
    cache: normalizeCacheState(cache),
    requestId: normalizeRequestId(requestId) || randomUUID(),
  };
  const normalizedErrorCategory = normalizeErrorCategory(errorCategory);
  return normalizedErrorCategory ? { ...entry, errorCategory: normalizedErrorCategory } : entry;
}

function maybeLogRouteTiming(input, options = {}) {
  const env = options.env || process.env;
  if (!isRouteTimingEnabled(env) || !isRouteTimingTarget(input.method, input.route)) {
    return null;
  }

  const entry = buildRouteTimingLogEntry(input);
  try {
    const logger = options.logger || console.log;
    logger(JSON.stringify(entry));
  } catch (_error) {
    // Diagnostics should never affect API behavior.
  }
  return entry;
}

export {
  buildRouteTimingLogEntry,
  classifyDurationBucket,
  getRouteTimingErrorCategory,
  isRouteTimingEnabled,
  isRouteTimingTarget,
  maybeLogRouteTiming,
  resolveRouteTimingRequestId,
};
