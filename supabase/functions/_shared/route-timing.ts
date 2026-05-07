const ROUTE_TIMING_TARGETS = new Set([
  "POST /film-orders/delete",
  "POST /film-orders/cancel",
  "GET /film-orders/list",
  "POST /jobs/create",
  "POST /jobs/update",
  "GET /jobs/get",
  "POST /jobs/complete",
  "POST /jobs/delete",
  "POST /jobs/checkout-all",
  "POST /jobs/set-staged-pickup",
  "POST /audit/undo",
  "POST /boxes/receive",
  "POST /boxes/add",
  "POST /boxes/delete",
  "POST /boxes/update",
  "POST /boxes/set-status",
  "POST /allocations/apply",
  "POST /allocations/remove-box",
  "GET /reports/summary",
]);

type CacheState = "hit" | "miss" | "none";

type EnvLike = {
  get(name: string): string | undefined | null;
};

type Logger = (message: string) => void;

type RouteTimingInput = {
  runtime: "supabase-edge";
  method: string;
  route: string;
  statusCode: number;
  ok: boolean;
  durationMs: number;
  cache?: CacheState | string;
  requestId?: string;
  errorCategory?: string;
};

type RouteTimingLogEntry = {
  level: "info";
  msg: "route_timing";
  runtime: "supabase-edge";
  method: string;
  route: string;
  statusCode: number;
  ok: boolean;
  durationMs: number;
  durationBucket: "fast" | "slow" | "timeout-risk";
  cache: CacheState;
  requestId: string;
  errorCategory?: string;
};

/**
 * PURPOSE:
 * Emits DEV-only route timing logs for the slow inventory workflows under
 * investigation without recording request bodies, query params, or auth data.
 *
 * AFFECTS:
 * Supabase Edge diagnostics for high-risk lifecycle mutation and read
 * endpoints under timeout investigation.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * Local backend routeTiming helper, affected route list, and timeout tracing
 * plans before/after planner performance changes.
 *
 * COMMON FAILURE MODES:
 * Logging in production, leaking payload identifiers, or missing a target route
 * and losing before/after timing evidence.
 */

function normalizeMethod(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

function normalizeRoute(value: unknown): string {
  const path = String(value || "").split("?")[0].trim();
  if (!path) {
    return "";
  }
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizeCacheState(value: unknown): CacheState {
  return value === "hit" || value === "miss" ? value : "none";
}

function normalizeRequestId(value: unknown): string {
  const normalized = String(value || "").trim().split(/[\s,]/)[0] || "";
  return normalized.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 128);
}

function isTruthyEnvFlag(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function defaultEnv(): EnvLike | null {
  return typeof Deno !== "undefined" ? Deno.env : null;
}

function readEnvValue(env: EnvLike | null, name: string): string {
  try {
    return String(env?.get(name) || "");
  } catch (_error) {
    return "";
  }
}

function isRouteTimingEnabled(env: EnvLike | null = defaultEnv()): boolean {
  return isTruthyEnvFlag(readEnvValue(env, "DEV_ROUTE_TIMING_LOGS"));
}

function isRouteTimingTarget(method: string, route: string): boolean {
  return ROUTE_TIMING_TARGETS.has(`${normalizeMethod(method)} ${normalizeRoute(route)}`);
}

function resolveRouteTimingRequestId(headers: Headers): string {
  return (
    normalizeRequestId(headers.get("x-request-id")) ||
    normalizeRequestId(headers.get("x-vercel-id")) ||
    crypto.randomUUID()
  );
}

function classifyDurationBucket(durationMs: number): "fast" | "slow" | "timeout-risk" {
  const normalized = Number.isFinite(Number(durationMs)) ? Math.max(0, Number(durationMs)) : 0;
  if (normalized < 1000) {
    return "fast";
  }
  if (normalized <= 5000) {
    return "slow";
  }
  return "timeout-risk";
}

function normalizeErrorCategory(value: unknown): string {
  const normalized = String(value || "").trim().split(/[\s:]/)[0] || "";
  return normalized.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80);
}

function getRouteTimingErrorCategory(error: unknown): string {
  if (!error) {
    return "";
  }
  if (error instanceof Error) {
    return normalizeErrorCategory(error.name || error.constructor.name);
  }
  return normalizeErrorCategory(typeof error);
}

function buildRouteTimingLogEntry(input: RouteTimingInput): RouteTimingLogEntry {
  const roundedDurationMs = Math.max(0, Math.round(Number(input.durationMs) || 0));
  const entry: RouteTimingLogEntry = {
    level: "info",
    msg: "route_timing",
    runtime: input.runtime,
    method: normalizeMethod(input.method),
    route: normalizeRoute(input.route),
    statusCode: Number.isFinite(Number(input.statusCode)) ? Number(input.statusCode) : 500,
    ok: Boolean(input.ok),
    durationMs: roundedDurationMs,
    durationBucket: classifyDurationBucket(roundedDurationMs),
    cache: normalizeCacheState(input.cache),
    requestId: normalizeRequestId(input.requestId) || crypto.randomUUID(),
  };
  const errorCategory = normalizeErrorCategory(input.errorCategory);
  return errorCategory ? { ...entry, errorCategory } : entry;
}

function maybeLogRouteTiming(
  input: RouteTimingInput,
  options: { env?: EnvLike | null; logger?: Logger } = {},
): RouteTimingLogEntry | null {
  if (!isRouteTimingEnabled(options.env ?? defaultEnv()) || !isRouteTimingTarget(input.method, input.route)) {
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

export type { EnvLike, RouteTimingLogEntry };
