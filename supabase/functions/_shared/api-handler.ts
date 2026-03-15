import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") || "").trim().replace(/\/+$/g, "");
const SUPABASE_ANON_KEY = (Deno.env.get("SUPABASE_ANON_KEY") || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "").trim();
const DEFAULT_ORG_ID = (Deno.env.get("DEFAULT_ORG_ID") || "").trim();
const RESEND_API_KEY = (Deno.env.get("RESEND_API_KEY") || "").trim();
const RESEND_FROM_EMAIL = (Deno.env.get("RESEND_FROM_EMAIL") || "").trim();
const CACHE_TTL_MS = Number(Deno.env.get("CACHE_TTL_MS") || "30000");
const MAX_CACHE_ENTRIES = Number(Deno.env.get("MAX_CACHE_ENTRIES") || "500");
const CORS_ALLOWED_ORIGINS = (Deno.env.get("CORS_ALLOWED_ORIGINS") || "*")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const READ_PATHS = new Set([
  "/health",
  "/auth/context",
  "/boxes/search",
  "/boxes/get",
  "/audit/list",
  "/audit/by-box",
  "/allocations/by-box",
  "/allocations/jobs",
  "/allocations/by-job",
  "/allocations/preview",
  "/jobs/list",
  "/jobs/search",
  "/jobs/get",
  "/film-orders/list",
  "/film-data/catalog",
  "/roll-history/by-box",
  "/reports/summary",
  "/warehouses/list",
  "/admin/access/requests",
  "/admin/username-requests",
  "/admin/member-permissions",
  "/admin/user-permissions",
  "/owner/admin-permissions",
  "/owner/notification-preferences",
]);

type CacheEntry = {
  expiresAt: number;
  status: number;
  contentType: string;
  body: string;
};

type AuthIdentity = {
  userId: string;
  email: string;
  name: string;
  token: string;
  orgId: string;
  actor: string;
  role: "owner" | "admin" | "member" | "";
  accessStatus: "approved" | "pending" | "denied";
  permissions: Record<string, { read: boolean; write: boolean }>;
  isAdminConsoleAllowed: boolean;
  pendingCount: number;
  receivesInAppNotifications: boolean;
  pendingRequestCreated: boolean;
};

const cache = new Map<string, CacheEntry>();
const authIdentityCache = new Map<string, { expiresAt: number; identity: AuthIdentity }>();
const authUserProfileCache = new Map<string, { expiresAt: number; profile: { email: string; name: string } }>();

class HttpError extends Error {
  statusCode: number;
  warnings: string[];

  constructor(statusCode: number, message: string, warnings: string[] = []) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.warnings = warnings;
  }
}

function ok(data: unknown, warnings: string[] = []) {
  return {
    ok: true,
    data,
    warnings,
  };
}

function asTrimmedString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function requireString(value: unknown, fieldName: string): string {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    throw new HttpError(400, `${fieldName} is required.`);
  }
  return trimmed;
}

function normalizeDateString(value: unknown, fieldName: string, allowBlank: boolean): string {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    if (allowBlank) {
      return "";
    }
    throw new HttpError(400, `${fieldName} is required.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new HttpError(400, `${fieldName} must use yyyy-mm-dd.`);
  }
  return trimmed;
}

function coerceFeetValue(
  value: unknown,
  fieldName: string,
  warnings: string[],
  allowNegativeClamp: boolean,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, `${fieldName} must be numeric.`);
  }
  const floored = Math.floor(parsed);
  if (floored !== parsed) {
    warnings.push(`${fieldName} was rounded down to ${floored}.`);
  }
  if (floored < 0) {
    if (allowNegativeClamp) {
      warnings.push(`${fieldName} was clamped to 0.`);
      return 0;
    }
    throw new HttpError(400, `${fieldName} must be zero or greater.`);
  }
  return floored;
}

function formatTimestamp(value: unknown): string {
  if (!value) {
    return "";
  }
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function formatDateValue(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const iso = value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  return iso.slice(0, 10);
}

function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrZero(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function createLogId(): string {
  const now = new Date();
  const timestamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
    String(now.getUTCMilliseconds()).padStart(3, "0"),
  ].join("");
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  const suffix = String(((bytes[0] << 8) | bytes[1]) % 1000).padStart(3, "0");
  return `${timestamp}-${suffix}`;
}

function normalizeCollapsedCatalogLabel(value: unknown): string {
  return asTrimmedString(value).replace(/\s+/g, " ");
}

function normalizeCatalogLookupKey(value: unknown): string {
  return normalizeCollapsedCatalogLabel(value).toLowerCase();
}

function compareCatalogStrings(left: unknown, right: unknown): number {
  const leftValue = asTrimmedString(left).toLowerCase();
  const rightValue = asTrimmedString(right).toLowerCase();
  if (leftValue < rightValue) {
    return -1;
  }
  if (leftValue > rightValue) {
    return 1;
  }
  return 0;
}

function normalizeRequirementWidthKey(value: unknown): string {
  return String(roundToDecimals(Number(value), 4));
}

function normalizeJobRequirementLookupKey(
  manufacturer: unknown,
  filmName: unknown,
  widthIn: unknown,
): string {
  return [
    normalizeCatalogLookupKey(manufacturer),
    normalizeCatalogLookupKey(filmName),
    normalizeRequirementWidthKey(widthIn),
  ].join("|");
}

function normalizeJobNumberKey(jobNumber: unknown): string {
  return asTrimmedString(jobNumber).toUpperCase();
}

function normalizeCrewLeaderKey(crewLeader: unknown): string {
  return asTrimmedString(crewLeader).toUpperCase();
}

function normalizeJobLifecycleStatus(value: unknown): "ACTIVE" | "COMPLETED" | "CANCELLED" {
  const normalized = asTrimmedString(value).toUpperCase();
  if (normalized === "CANCELLED") {
    return "CANCELLED";
  }
  if (normalized === "COMPLETED") {
    return "COMPLETED";
  }
  return "ACTIVE";
}

function compareBoxesByOldestStock(left: any, right: any): number {
  const leftDate = left.receivedDate || left.orderDate || "9999-12-31";
  const rightDate = right.receivedDate || right.orderDate || "9999-12-31";
  if (leftDate !== rightDate) {
    return leftDate < rightDate ? -1 : 1;
  }
  return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
}

function compareAllocationJobSummaries(left: any, right: any): number {
  if (left.jobDate && right.jobDate && left.jobDate !== right.jobDate) {
    return left.jobDate < right.jobDate ? -1 : 1;
  }
  if (left.jobDate && !right.jobDate) {
    return -1;
  }
  if (!left.jobDate && right.jobDate) {
    return 1;
  }
  return left.jobNumber < right.jobNumber ? -1 : left.jobNumber > right.jobNumber ? 1 : 0;
}

function compareJobsListEntries(left: any, right: any): number {
  if (left.dueDate && right.dueDate && left.dueDate !== right.dueDate) {
    return left.dueDate > right.dueDate ? -1 : 1;
  }
  if (left.dueDate && !right.dueDate) {
    return -1;
  }
  if (!left.dueDate && right.dueDate) {
    return 1;
  }
  if (left.updatedAt && right.updatedAt && left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? -1 : 1;
  }
  if (left.updatedAt && !right.updatedAt) {
    return -1;
  }
  if (!left.updatedAt && right.updatedAt) {
    return 1;
  }
  return left.jobNumber > right.jobNumber ? -1 : left.jobNumber < right.jobNumber ? 1 : 0;
}

function normalizeJobNumberDigits(value: unknown): string {
  return asTrimmedString(value).replace(/[^0-9]/g, "");
}

function canonicalizeNumericDigits(digits: string): string {
  const withoutLeadingZeros = digits.replace(/^0+/, "");
  return withoutLeadingZeros || "0";
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function absoluteBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function normalizePath(value: string | null | undefined): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseBodyJson(bodyText: string): Record<string, unknown> | null {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function sha1Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function shouldUseCache(method: string, logicalPath: string): boolean {
  if (!Number.isFinite(CACHE_TTL_MS) || CACHE_TTL_MS <= 0) {
    return false;
  }
  if (logicalPath === "/auth/context") {
    return false;
  }
  if (method === "GET") {
    return true;
  }
  if (method === "POST") {
    return READ_PATHS.has(logicalPath);
  }
  return false;
}

function isMutation(method: string, logicalPath: string): boolean {
  return method === "POST" && logicalPath !== "" && !READ_PATHS.has(logicalPath);
}

function getCorsOrigin(request: Request): string {
  const origin = request.headers.get("origin");
  if (!origin || CORS_ALLOWED_ORIGINS.includes("*")) {
    return "*";
  }
  if (CORS_ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  return CORS_ALLOWED_ORIGINS[0] || "*";
}

function buildCorsHeaders(request: Request): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", getCorsOrigin(request));
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey, x-client-info");
  headers.set("Vary", "Origin");
  return headers;
}

function jsonResponse(request: Request, status: number, payload: unknown): Response {
  const headers = buildCorsHeaders(request);
  headers.set("Content-Type", "application/json; charset=utf-8");
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

function pruneAuthIdentityCache(): void {
  const now = Date.now();
  for (const [key, entry] of authIdentityCache.entries()) {
    if (entry.expiresAt <= now) {
      authIdentityCache.delete(key);
    }
  }
}

function resolveLogicalPath(requestUrl: URL, bodyJson: Record<string, unknown> | null, canonicalName: string): string {
  const fromQuery = normalizePath(requestUrl.searchParams.get("path"));
  if (fromQuery) {
    return fromQuery;
  }
  const fromBody = normalizePath(bodyJson && typeof bodyJson.path === "string" ? bodyJson.path : "");
  if (fromBody) {
    return fromBody;
  }
  if (requestUrl.pathname === "/" || requestUrl.pathname.endsWith(`/${canonicalName}`)) {
    return "";
  }
  if (requestUrl.pathname.endsWith("/health")) {
    return "/health";
  }
  return normalizePath(requestUrl.pathname);
}

function deriveNameFromEmail(email: string): string {
  const localPart = email.split("@")[0] || "";
  const sanitized = localPart.replace(/[._-]+/g, " ").trim();
  return sanitized || "Inventory User";
}

function createUserScopedClient(token: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}

function createServiceRoleClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function parseFeaturePermissions(value: unknown): Record<string, { read: boolean; write: boolean }> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const source = value as Record<string, unknown>;
  const next: Record<string, { read: boolean; write: boolean }> = {};
  for (const [feature, raw] of Object.entries(source)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const featureMap = raw as Record<string, unknown>;
    next[feature] = {
      read: featureMap.read === true || String(featureMap.read).toLowerCase() === "true",
      write: featureMap.write === true || String(featureMap.write).toLowerCase() === "true",
    };
  }

  return next;
}

async function fetchUserEmailById(userId: string): Promise<string> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !userId) {
    return "";
  }

  const now = Date.now();
  const cached = authUserProfileCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.profile.email;
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
  });

  if (!response.ok) {
    return "";
  }

  const payload = await response.json();
  const source =
    payload && typeof payload === "object" && payload.user && typeof payload.user === "object"
      ? (payload.user as Record<string, unknown>)
      : (payload as Record<string, unknown>);
  const email = asTrimmedString(source?.email);
  const metadata = source?.user_metadata && typeof source.user_metadata === "object"
    ? (source.user_metadata as Record<string, unknown>)
    : {};
  const name =
    asTrimmedString(metadata.full_name) ||
    asTrimmedString(metadata.name) ||
    (email ? deriveNameFromEmail(email) : "");

  authUserProfileCache.set(userId, {
    expiresAt: Date.now() + 5 * 60_000,
    profile: {
      email,
      name,
    },
  });

  return email;
}

async function fetchUserProfileById(userId: string): Promise<{ email: string; name: string }> {
  const cached = authUserProfileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.profile;
  }

  const email = await fetchUserEmailById(userId);
  const profile = authUserProfileCache.get(userId);
  if (profile && profile.expiresAt > Date.now()) {
    return profile.profile;
  }

  return {
    email,
    name: email ? deriveNameFromEmail(email) : "",
  };
}

async function enrichAdminPermissionEntries(entriesRaw: unknown[]): Promise<Record<string, unknown>[]> {
  const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
  const response: Record<string, unknown>[] = [];

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }

    const entry = rawEntry as Record<string, unknown>;
    const userId = asTrimmedString(entry.userId);
    if (!userId) {
      continue;
    }

    let email = asTrimmedString(entry.email);
    let name = asTrimmedString(entry.name);
    if (!email || !name) {
      const profile = await fetchUserProfileById(userId);
      if (!email) {
        email = profile.email;
      }
      if (!name) {
        name = profile.name;
      }
    }

    if (!name) {
      name = email ? deriveNameFromEmail(email) : userId;
    }

    response.push({
      ...entry,
      userId,
      role: "admin",
      email,
      name,
    });
  }

  return response;
}

async function sendNewAccessRequestNotification(params: {
  orgId: string;
  requestedEmail: string;
  requestedUserId: string;
}): Promise<void> {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    return;
  }

  const serviceClient = createServiceRoleClient();
  if (!serviceClient) {
    return;
  }

  const { data, error } = await serviceClient.rpc("api_list_access_notification_recipients", {
    p_org_id: params.orgId,
  });
  if (error) {
    return;
  }

  const recipientsRaw = Array.isArray(data) ? data : [];
  const recipientEmails = new Set<string>();
  for (const entry of recipientsRaw) {
    const userId = asTrimmedString((entry as Record<string, unknown>)?.user_id);
    if (!userId) {
      continue;
    }
    const email = await fetchUserEmailById(userId);
    if (email) {
      recipientEmails.add(email);
    }
  }

  if (!recipientEmails.size) {
    return;
  }

  const to = [...recipientEmails];
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to,
      subject: "New inventory access request pending approval",
      text:
        `A new user is waiting for approval.\n\n` +
        `Email: ${params.requestedEmail || "(unknown)"}\n` +
        `User ID: ${params.requestedUserId}\n` +
        `Organization ID: ${params.orgId}`,
    }),
  });
}

function statusFromRpcError(error: any, fallback = 500) {
  const detail = asTrimmedString(error?.details);
  const match = detail.match(/status=(\d+)/i);
  return match ? Number(match[1]) : fallback;
}

function mapBackendBootstrapError(message: string): string {
  const normalized = asTrimmedString(message).toLowerCase();
  if (
    normalized.includes('relation "app.general_feature_permissions" does not exist') ||
    normalized.includes('relation "app.admin_feature_permissions" does not exist') ||
    normalized.includes('relation "app.access_requests" does not exist') ||
    normalized.includes('relation "app.username_change_requests" does not exist') ||
    normalized.includes('column "requested_by_name" does not exist') ||
    (normalized.includes('function public.api_get_auth_context') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_request_username_change') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_get_user_feature_permissions') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_update_user_feature_permissions') && normalized.includes('does not exist'))
  ) {
    return 'Database migrations 0006_access_control_and_approvals.sql, 0007_access_request_display_name.sql, 0008_username_change_requests.sql, and 0009_user_feature_overrides.sql are required. Run all four, then retry.';
  }
  return message;
}

async function rpcOrThrow<T>(client: any, fn: string, params: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, params);
  if (error) {
    const rawMessage = asTrimmedString(error.message) || "Unexpected database error.";
    throw new HttpError(statusFromRpcError(error), mapBackendBootstrapError(rawMessage));
  }
  return data as T;
}

function mapDbBoxRow(row: any) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    orgId: row.org_id,
    boxId: asTrimmedString(row.box_id),
    warehouse: asTrimmedString(row.warehouse),
    manufacturer: asTrimmedString(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    initialFeet: integerOrZero(row.initial_feet),
    feetAvailable: integerOrZero(row.feet_available),
    lotRun: asTrimmedString(row.lot_run),
    status: asTrimmedString(row.status) || "ORDERED",
    orderDate: formatDateValue(row.order_date),
    receivedDate: formatDateValue(row.received_date),
    initialWeightLbs: numericOrNull(row.initial_weight_lbs),
    lastRollWeightLbs: numericOrNull(row.last_roll_weight_lbs),
    lastWeighedDate: formatDateValue(row.last_weighed_date),
    filmKey: asTrimmedString(row.film_key).toUpperCase(),
    coreType: asTrimmedString(row.core_type),
    coreWeightLbs: numericOrNull(row.core_weight_lbs),
    lfWeightLbsPerFt: numericOrNull(row.lf_weight_lbs_per_ft),
    purchaseCost: numericOrNull(row.purchase_cost),
    notes: asTrimmedString(row.notes),
    hasEverBeenCheckedOut: Boolean(row.has_ever_been_checked_out),
    lastCheckoutJob: asTrimmedString(row.last_checkout_job),
    lastCheckoutDate: formatDateValue(row.last_checkout_date),
    zeroedDate: formatDateValue(row.zeroed_date),
    zeroedReason: asTrimmedString(row.zeroed_reason),
    zeroedBy: asTrimmedString(row.zeroed_by),
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at),
  };
}

function toPublicBox(box: any) {
  return {
    boxId: box.boxId,
    warehouse: box.warehouse,
    manufacturer: box.manufacturer,
    filmName: box.filmName,
    widthIn: box.widthIn,
    initialFeet: box.initialFeet,
    feetAvailable: box.feetAvailable,
    lotRun: box.lotRun,
    status: box.status,
    orderDate: box.orderDate,
    receivedDate: box.receivedDate,
    initialWeightLbs: box.initialWeightLbs,
    lastRollWeightLbs: box.lastRollWeightLbs,
    lastWeighedDate: box.lastWeighedDate,
    filmKey: box.filmKey,
    coreType: box.coreType,
    coreWeightLbs: box.coreWeightLbs,
    lfWeightLbsPerFt: box.lfWeightLbsPerFt,
    purchaseCost: box.purchaseCost,
    notes: box.notes,
    hasEverBeenCheckedOut: box.hasEverBeenCheckedOut,
    lastCheckoutJob: box.lastCheckoutJob,
    lastCheckoutDate: box.lastCheckoutDate,
    zeroedDate: box.zeroedDate,
    zeroedReason: box.zeroedReason,
    zeroedBy: box.zeroedBy,
  };
}

function mapDbFilmCatalogRow(row: any) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    orgId: row.org_id,
    filmKey: asTrimmedString(row.film_key).toUpperCase(),
    manufacturer: asTrimmedString(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    sqFtWeightLbsPerSqFt: numericOrNull(row.sq_ft_weight_lbs_per_sq_ft),
    defaultCoreType: asTrimmedString(row.default_core_type),
    sourceWidthIn: numericOrNull(row.source_width_in),
    sourceInitialFeet: integerOrNull(row.source_initial_feet),
    sourceInitialWeightLbs: numericOrNull(row.source_initial_weight_lbs),
    sourceBoxId: asTrimmedString(row.source_box_id),
    notes: asTrimmedString(row.notes),
    updatedAt: formatTimestamp(row.updated_at),
  };
}

function mapDbAllocationRow(row: any) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    orgId: row.org_id,
    allocationId: asTrimmedString(row.allocation_id),
    boxId: asTrimmedString(row.box_id),
    warehouse: asTrimmedString(row.warehouse),
    jobId: row.job_id || null,
    jobNumber: asTrimmedString(row.job_number),
    jobDate: formatDateValue(row.job_date),
    allocatedFeet: integerOrZero(row.allocated_feet),
    status: asTrimmedString(row.status) || "ACTIVE",
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    resolvedAt: formatTimestamp(row.resolved_at),
    resolvedBy: asTrimmedString(row.resolved_by),
    notes: asTrimmedString(row.notes),
    crewLeader: asTrimmedString(row.crew_leader),
    filmOrderId: asTrimmedString(row.film_order_id),
  };
}

function toPublicAllocation(entry: any) {
  return {
    allocationId: entry.allocationId,
    boxId: entry.boxId,
    warehouse: entry.warehouse,
    jobNumber: entry.jobNumber,
    jobDate: entry.jobDate,
    crewLeader: entry.crewLeader,
    allocatedFeet: entry.allocatedFeet,
    status: entry.status,
    createdAt: entry.createdAt,
    createdBy: entry.createdBy,
    resolvedAt: entry.resolvedAt,
    resolvedBy: entry.resolvedBy,
    filmOrderId: entry.filmOrderId,
    notes: entry.notes,
  };
}

function mapDbFilmOrderRow(row: any) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    orgId: row.org_id,
    filmOrderId: asTrimmedString(row.film_order_id),
    jobId: row.job_id || null,
    jobNumber: asTrimmedString(row.job_number),
    warehouse: asTrimmedString(row.warehouse),
    manufacturer: asTrimmedString(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    requestedFeet: integerOrZero(row.requested_feet),
    coveredFeet: integerOrZero(row.covered_feet),
    orderedFeet: integerOrZero(row.ordered_feet),
    remainingToOrderFeet: integerOrZero(row.remaining_to_order_feet),
    jobDate: formatDateValue(row.job_date),
    crewLeader: asTrimmedString(row.crew_leader),
    status: asTrimmedString(row.status) || "FILM_ORDER",
    sourceBoxId: asTrimmedString(row.source_box_id),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    resolvedAt: formatTimestamp(row.resolved_at),
    resolvedBy: asTrimmedString(row.resolved_by),
    notes: asTrimmedString(row.notes),
  };
}

function toPublicFilmOrder(entry: any, linkedBoxes: any[]) {
  return {
    filmOrderId: entry.filmOrderId,
    jobNumber: entry.jobNumber,
    warehouse: entry.warehouse,
    manufacturer: entry.manufacturer,
    filmName: entry.filmName,
    widthIn: entry.widthIn,
    requestedFeet: entry.requestedFeet,
    coveredFeet: entry.coveredFeet,
    orderedFeet: entry.orderedFeet,
    remainingToOrderFeet: entry.remainingToOrderFeet,
    jobDate: entry.jobDate,
    crewLeader: entry.crewLeader,
    status: entry.status,
    sourceBoxId: entry.sourceBoxId,
    createdAt: entry.createdAt,
    createdBy: entry.createdBy,
    resolvedAt: entry.resolvedAt,
    resolvedBy: entry.resolvedBy,
    notes: entry.notes,
    linkedBoxes,
  };
}

function mapDbJobRow(row: any) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    orgId: row.org_id,
    jobNumber: asTrimmedString(row.job_number),
    warehouse: asTrimmedString(row.warehouse),
    sections: asTrimmedString(row.sections) || null,
    dueDate: formatDateValue(row.due_date),
    crewLeader: asTrimmedString(row.crew_leader),
    lifecycleStatus: asTrimmedString(row.lifecycle_status) || "ACTIVE",
    notes: asTrimmedString(row.notes),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by),
  };
}

function mapDbRequirementRow(row: any) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    orgId: row.org_id,
    jobId: row.job_id,
    jobNumber: asTrimmedString(row.job_number),
    manufacturer: asTrimmedString(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    requiredFeet: integerOrZero(row.required_feet),
    notes: asTrimmedString(row.notes),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by),
  };
}

function mapDbAuditRow(row: any) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    orgId: row.org_id,
    logId: asTrimmedString(row.log_id),
    date: formatTimestamp(row.created_at),
    action: asTrimmedString(row.action),
    boxId: asTrimmedString(row.box_id),
    before: row.before_state || null,
    after: row.after_state || null,
    user: asTrimmedString(row.actor),
    notes: asTrimmedString(row.notes),
  };
}

function mapDbRollHistoryRow(row: any) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    orgId: row.org_id,
    logId: asTrimmedString(row.log_id),
    boxId: asTrimmedString(row.box_id),
    warehouse: asTrimmedString(row.warehouse),
    manufacturer: asTrimmedString(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    jobNumber: asTrimmedString(row.job_number),
    checkedOutAt: formatTimestamp(row.checked_out_at),
    checkedOutBy: asTrimmedString(row.checked_out_by),
    checkedOutWeightLbs: numericOrNull(row.checked_out_weight_lbs),
    checkedInAt: formatTimestamp(row.checked_in_at),
    checkedInBy: asTrimmedString(row.checked_in_by),
    checkedInWeightLbs: numericOrNull(row.checked_in_weight_lbs),
    weightDeltaLbs: numericOrNull(row.weight_delta_lbs),
    feetBefore: integerOrZero(row.feet_before),
    feetAfter: integerOrZero(row.feet_after),
    notes: asTrimmedString(row.notes),
  };
}

async function fetchAuthIdentity(token: string): Promise<{ userId: string; email: string; name: string; token: string } | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return null;
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
  });
  if (!response.ok) {
    return null;
  }
  const payload = await response.json();
  const email = asTrimmedString(payload.email);
  const metadata = payload.user_metadata && typeof payload.user_metadata === "object" ? payload.user_metadata : {};
  const name =
    asTrimmedString(metadata.full_name) ||
    asTrimmedString(metadata.name) ||
    deriveNameFromEmail(email);
  return {
    userId: asTrimmedString(payload.id),
    email,
    name,
    token,
  };
}

async function resolveAuthContext(request: Request): Promise<{ identity: AuthIdentity; client: any }> {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    throw new HttpError(401, "Authenticated session is required.");
  }

  pruneAuthIdentityCache();
  const cached = authIdentityCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      identity: cached.identity,
      client: createUserScopedClient(token),
    };
  }

  const user = await fetchAuthIdentity(token);
  if (!user || !user.userId || !user.email) {
    throw new HttpError(401, "Authenticated session is required.");
  }

  const client = createUserScopedClient(token);

  let orgId = DEFAULT_ORG_ID;
  if (!orgId) {
    const memberships = await rpcOrThrow<Array<{ org_id: string }>>(client, "api_list_memberships");
    if (!memberships.length) {
      throw new HttpError(
        500,
        "DEFAULT_ORG_ID must be configured before handling pending approvals.",
      );
    }

    if (memberships.length === 1) {
      orgId = memberships[0].org_id;
    } else {
      throw new HttpError(
        500,
        "DEFAULT_ORG_ID is required because this user belongs to multiple organizations.",
      );
    }
  }

  const accessContext = await rpcOrThrow<Record<string, unknown>>(client, "api_get_auth_context", {
    p_org_id: orgId,
  });

  const accessStatusRaw = asTrimmedString(accessContext.accessStatus || "pending").toLowerCase();
  const roleRaw = asTrimmedString(accessContext.role).toLowerCase();
  const identity: AuthIdentity = {
    ...user,
    orgId,
    actor: `${user.name} <${user.email}>`,
    accessStatus:
      accessStatusRaw === "approved" || accessStatusRaw === "denied"
        ? (accessStatusRaw as "approved" | "denied")
        : "pending",
    role:
      roleRaw === "owner" || roleRaw === "admin" || roleRaw === "member"
        ? (roleRaw as "owner" | "admin" | "member")
        : "",
    permissions: parseFeaturePermissions(accessContext.permissions),
    isAdminConsoleAllowed:
      accessContext.isAdminConsoleAllowed === true ||
      String(accessContext.isAdminConsoleAllowed).toLowerCase() === "true",
    pendingCount: Number(accessContext.pendingCount || 0) || 0,
    receivesInAppNotifications:
      accessContext.receivesInAppNotifications === true ||
      String(accessContext.receivesInAppNotifications).toLowerCase() === "true",
    pendingRequestCreated:
      accessContext.pendingRequestCreated === true ||
      String(accessContext.pendingRequestCreated).toLowerCase() === "true",
  };

  if (identity.accessStatus === "pending" && identity.pendingRequestCreated) {
    try {
      await sendNewAccessRequestNotification({
        orgId,
        requestedEmail: user.email,
        requestedUserId: user.userId,
      });
    } catch {
      // Non-fatal: pending state is still persisted in DB.
    }
  }

  authIdentityCache.set(token, {
    identity,
    expiresAt: Date.now() + 60_000,
  });

  return { identity, client };
}

function routeParams(method: string, requestUrl: URL, bodyJson: Record<string, unknown> | null) {
  if (method === "GET") {
    const params: Record<string, unknown> = {};
    for (const [key, value] of requestUrl.searchParams.entries()) {
      if (key === "path") {
        continue;
      }
      params[key] = value;
    }
    return params;
  }

  const next = bodyJson && typeof bodyJson === "object" ? { ...bodyJson } : {};
  delete next.path;
  delete next.authToken;
  delete next.authUser;
  return next;
}

async function listBoxes(client: any, orgId: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_boxes", { p_org_id: orgId });
  return rows.map(mapDbBoxRow);
}

async function findBoxById(client: any, orgId: string, boxId: string) {
  const row = await rpcOrThrow<any | null>(client, "api_acl_find_box_by_id", {
    p_org_id: orgId,
    p_box_id: boxId,
  });
  return mapDbBoxRow(row);
}

async function listFilmCatalog(client: any, orgId: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_film_catalog", { p_org_id: orgId });
  return rows.map(mapDbFilmCatalogRow);
}

async function listAllocations(client: any, orgId: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_allocations", { p_org_id: orgId });
  return rows.map(mapDbAllocationRow);
}

async function listAllocationsByBox(client: any, orgId: string, boxId: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_allocations_by_box", {
    p_org_id: orgId,
    p_box_id: boxId,
  });
  return rows.map(mapDbAllocationRow);
}

async function listAllocationsByJob(client: any, orgId: string, jobNumber: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_allocations_by_job", {
    p_org_id: orgId,
    p_job_number: jobNumber,
  });
  return rows.map(mapDbAllocationRow);
}

async function listAllocationsByFilmOrderId(client: any, orgId: string, filmOrderId: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_allocations_by_film_order_id", {
    p_org_id: orgId,
    p_film_order_id: filmOrderId,
  });
  return rows.map(mapDbAllocationRow);
}

async function listAllocationsByIds(client: any, orgId: string, allocationIds: string[]) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_allocations_by_ids", {
    p_org_id: orgId,
    p_allocation_ids: allocationIds,
  });
  return rows.map(mapDbAllocationRow);
}

async function listActiveAllocations(client: any, orgId: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_active_allocations", { p_org_id: orgId });
  return rows.map(mapDbAllocationRow);
}

async function listFilmOrders(client: any, orgId: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_film_orders", { p_org_id: orgId });
  return rows.map(mapDbFilmOrderRow);
}

async function listFilmOrdersByJob(client: any, orgId: string, jobNumber: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_film_orders_by_job", {
    p_org_id: orgId,
    p_job_number: jobNumber,
  });
  return rows.map(mapDbFilmOrderRow);
}

async function findFilmOrderById(client: any, orgId: string, filmOrderId: string) {
  const row = await rpcOrThrow<any | null>(client, "api_acl_find_film_order_by_id", {
    p_org_id: orgId,
    p_film_order_id: filmOrderId,
  });
  return mapDbFilmOrderRow(row);
}

async function listFilmOrderLinksByFilmOrderId(client: any, orgId: string, filmOrderId: string) {
  return await rpcOrThrow<any[]>(client, "api_acl_list_film_order_links_by_film_order_id", {
    p_org_id: orgId,
    p_film_order_id: filmOrderId,
  });
}

async function listJobs(client: any, orgId: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_jobs", { p_org_id: orgId });
  return rows.map(mapDbJobRow);
}

async function findJobByNumber(client: any, orgId: string, jobNumber: string) {
  const row = await rpcOrThrow<any | null>(client, "api_acl_find_job_by_number", {
    p_org_id: orgId,
    p_job_number: jobNumber,
  });
  return mapDbJobRow(row);
}

async function listJobRequirements(client: any, orgId: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_job_requirements", { p_org_id: orgId });
  return rows.map(mapDbRequirementRow);
}

async function listJobRequirementsByJob(client: any, orgId: string, jobNumber: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_job_requirements_by_job", {
    p_org_id: orgId,
    p_job_number: jobNumber,
  });
  return rows.map(mapDbRequirementRow);
}

async function listAuditEntries(client: any, orgId: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_audit_entries", { p_org_id: orgId });
  return rows.map(mapDbAuditRow);
}

async function listAuditEntriesByBox(client: any, orgId: string, boxId: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_audit_entries_by_box", {
    p_org_id: orgId,
    p_box_id: boxId,
  });
  return rows.map(mapDbAuditRow);
}

async function listRollHistoryByBox(client: any, orgId: string, boxId: string) {
  const rows = await rpcOrThrow<any[]>(client, "api_acl_list_roll_history_by_box", {
    p_org_id: orgId,
    p_box_id: boxId,
  });
  return rows.map(mapDbRollHistoryRow);
}

function isUnknownJobNumber(value: unknown): boolean {
  const normalized = normalizeJobNumberKey(value);
  return !normalized || normalized === "UNKNOWN";
}

function toTimestampMs(value: unknown): number | null {
  const timestamp = asTrimmedString(value);
  if (!timestamp) {
    return null;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function getRollHistoryActivityTimestamp(entry: any): string {
  return asTrimmedString(entry.checkedInAt) || asTrimmedString(entry.checkedOutAt) || "";
}

function buildRollHistoryAllocationWindowsByBox(allocations: any[]) {
  const grouped: Record<string, Array<{ startMs: number | null; endMs: number | null }>> = {};
  const entries = Array.isArray(allocations) ? allocations : [];
  for (const allocation of entries) {
    const boxId = asTrimmedString(allocation && allocation.boxId);
    if (!boxId) {
      continue;
    }
    if (!grouped[boxId]) {
      grouped[boxId] = [];
    }
    grouped[boxId].push({
      startMs: toTimestampMs(allocation && allocation.createdAt),
      endMs: toTimestampMs(allocation && allocation.resolvedAt),
    });
  }
  return grouped;
}

function isTimestampInAllocationWindow(
  timestampMs: number | null,
  window: { startMs: number | null; endMs: number | null },
): boolean {
  if (timestampMs === null) {
    return false;
  }
  if (window.startMs !== null && timestampMs < window.startMs) {
    return false;
  }
  if (window.endMs !== null && timestampMs > window.endMs) {
    return false;
  }
  return true;
}

function isRollHistoryEntryInAllocationWindow(entry: any, windows: Array<{ startMs: number | null; endMs: number | null }>) {
  if (!Array.isArray(windows) || !windows.length) {
    return false;
  }
  const activityTimestampMs = toTimestampMs(getRollHistoryActivityTimestamp(entry));
  return windows.some((window) => isTimestampInAllocationWindow(activityTimestampMs, window));
}

function buildRollHistoryEntryDedupeKey(entry: any): string {
  return `${asTrimmedString(entry && entry.logId)}|${asTrimmedString(entry && entry.boxId)}`;
}

function dedupeRollHistoryEntries(entries: any[]) {
  const deduped: Record<string, any> = {};
  const source = Array.isArray(entries) ? entries : [];
  for (const entry of source) {
    if (!entry || !entry.boxId) {
      continue;
    }
    const key = buildRollHistoryEntryDedupeKey(entry);
    if (!deduped[key]) {
      deduped[key] = entry;
    }
  }
  return Object.values(deduped);
}

function shouldIncludeRollHistoryEntryForJob(
  entry: any,
  normalizedJobNumberKey: string,
  allocationWindowsByBox: Record<string, Array<{ startMs: number | null; endMs: number | null }>>,
) {
  if (!entry || !entry.boxId) {
    return false;
  }
  if (normalizeJobNumberKey(entry.jobNumber) === normalizedJobNumberKey) {
    return true;
  }
  if (!isUnknownJobNumber(entry.jobNumber)) {
    return false;
  }
  return isRollHistoryEntryInAllocationWindow(entry, allocationWindowsByBox[entry.boxId] || []);
}

function finalizeRollHistoryEntriesForJob(
  entries: any[],
  normalizedJobNumberKey: string,
  allocationWindowsByBox: Record<string, Array<{ startMs: number | null; endMs: number | null }>>,
) {
  const deduped = dedupeRollHistoryEntries(entries);
  const filtered = deduped.filter((entry) =>
    shouldIncludeRollHistoryEntryForJob(entry, normalizedJobNumberKey, allocationWindowsByBox)
  );
  filtered.sort((left, right) => {
    const leftDate = getRollHistoryActivityTimestamp(left);
    const rightDate = getRollHistoryActivityTimestamp(right);
    if (leftDate !== rightDate) {
      return leftDate > rightDate ? -1 : 1;
    }
    const leftLogId = asTrimmedString(left.logId);
    const rightLogId = asTrimmedString(right.logId);
    return leftLogId < rightLogId ? 1 : leftLogId > rightLogId ? -1 : 0;
  });
  return filtered;
}

function chunkStringValues(values: string[], size: number): string[][] {
  const source = Array.isArray(values) ? values : [];
  const chunkSize = Number.isFinite(size) && size > 0 ? Math.floor(size) : 100;
  const chunks: string[][] = [];
  for (let index = 0; index < source.length; index += chunkSize) {
    chunks.push(source.slice(index, index + chunkSize));
  }
  return chunks;
}

async function listRollHistoryByJob(client: any, orgId: string, jobNumber: string, allocations: any[] = []) {
  const normalizedJobNumber = asTrimmedString(jobNumber);
  if (!normalizedJobNumber) {
    return [];
  }
  const normalizedJobNumberKey = normalizeJobNumberKey(normalizedJobNumber);
  const allocationWindowsByBox = buildRollHistoryAllocationWindowsByBox(allocations);
  const allocatedBoxIds = Object.keys(allocationWindowsByBox);

  const serviceClient = createServiceRoleClient();
  if (serviceClient) {
    const directQuery = await serviceClient
      .schema("app")
      .from("roll_weight_log")
      .select("*")
      .eq("org_id", orgId)
      .eq("job_number", normalizedJobNumber)
      .order("checked_in_at", { ascending: false, nullsFirst: false })
      .order("checked_out_at", { ascending: false, nullsFirst: false })
      .order("log_id", { ascending: false });

    if (!directQuery.error) {
      const mergedEntries = (Array.isArray(directQuery.data) ? directQuery.data : []).map(mapDbRollHistoryRow);
      let canUseServiceRoleResults = true;
      for (const boxIdChunk of chunkStringValues(allocatedBoxIds, 100)) {
        if (!boxIdChunk.length) {
          continue;
        }
        const allocatedQuery = await serviceClient
          .schema("app")
          .from("roll_weight_log")
          .select("*")
          .eq("org_id", orgId)
          .in("box_id", boxIdChunk)
          .order("checked_in_at", { ascending: false, nullsFirst: false })
          .order("checked_out_at", { ascending: false, nullsFirst: false })
          .order("log_id", { ascending: false });
        if (allocatedQuery.error) {
          canUseServiceRoleResults = false;
          break;
        }
        mergedEntries.push(...(Array.isArray(allocatedQuery.data) ? allocatedQuery.data : []).map(mapDbRollHistoryRow));
      }
      if (canUseServiceRoleResults) {
        return finalizeRollHistoryEntriesForJob(mergedEntries, normalizedJobNumberKey, allocationWindowsByBox);
      }
    }
  }

  const entries: any[] = [];
  const boxes = await listBoxes(client, orgId);
  for (const box of boxes) {
    const boxEntries = await listRollHistoryByBox(client, orgId, box.boxId);
    for (const entry of boxEntries) {
      entries.push(entry);
    }
  }
  return finalizeRollHistoryEntriesForJob(entries, normalizedJobNumberKey, allocationWindowsByBox);
}

function toUsageTimestampSortValue(entry: any) {
  return getRollHistoryActivityTimestamp(entry);
}

function buildPublicJobUsageEntries(rollHistoryEntries: any[], boxById: Record<string, any>) {
  const grouped: Record<string, any> = {};
  const entries = Array.isArray(rollHistoryEntries) ? rollHistoryEntries : [];

  for (const entry of entries) {
    if (!entry || !entry.boxId) {
      continue;
    }

    const usedFeet = Math.max(integerOrZero(entry.feetBefore) - integerOrZero(entry.feetAfter), 0);
    const timestampSortValue = toUsageTimestampSortValue(entry);
    const box = boxById[entry.boxId] || null;

    if (!grouped[entry.boxId]) {
      grouped[entry.boxId] = {
        boxId: entry.boxId,
        manufacturer: box ? box.manufacturer : asTrimmedString(entry.manufacturer),
        filmName: box ? box.filmName : asTrimmedString(entry.filmName),
        widthIn: box ? box.widthIn : numericOrNull(entry.widthIn) ?? 0,
        usedFeet: 0,
        usageEventCount: 0,
        latestCheckedInAt: "",
        latestCheckedOutAt: "",
        lastActivityAt: "",
      };
    }

    grouped[entry.boxId].usedFeet += usedFeet;
    grouped[entry.boxId].usageEventCount += 1;

    if (asTrimmedString(entry.checkedInAt) > grouped[entry.boxId].latestCheckedInAt) {
      grouped[entry.boxId].latestCheckedInAt = asTrimmedString(entry.checkedInAt);
    }
    if (asTrimmedString(entry.checkedOutAt) > grouped[entry.boxId].latestCheckedOutAt) {
      grouped[entry.boxId].latestCheckedOutAt = asTrimmedString(entry.checkedOutAt);
    }
    if (timestampSortValue > grouped[entry.boxId].lastActivityAt) {
      grouped[entry.boxId].lastActivityAt = timestampSortValue;
    }
  }

  const response = Object.values(grouped);
  response.sort((left: any, right: any) => {
    if (left.lastActivityAt !== right.lastActivityAt) {
      return left.lastActivityAt > right.lastActivityAt ? -1 : 1;
    }
    return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
  });
  return response;
}

function buildActiveAllocationsByBoxIndex(entries: any[]) {
  const grouped: Record<string, any[]> = {};
  for (const entry of entries) {
    if (entry.status !== "ACTIVE") {
      continue;
    }
    if (!grouped[entry.boxId]) {
      grouped[entry.boxId] = [];
    }
    grouped[entry.boxId].push(entry);
  }
  return grouped;
}

function getActiveAllocationsForBox(boxId: string, activeAllocationsByBox: Record<string, any[]>) {
  return activeAllocationsByBox && activeAllocationsByBox[boxId] ? activeAllocationsByBox[boxId] : [];
}

function buildAllocationCoverageByRequirementKey(allocations: any[], boxById: Record<string, any>) {
  const totals: Record<string, number> = {};
  for (const allocation of allocations) {
    if (allocation.status === "CANCELLED" || allocation.allocatedFeet <= 0) {
      continue;
    }
    const box = boxById[allocation.boxId];
    if (!box) {
      continue;
    }
    const key = normalizeJobRequirementLookupKey(box.manufacturer, box.filmName, box.widthIn);
    totals[key] = (totals[key] || 0) + allocation.allocatedFeet;
  }
  return totals;
}

function buildPublicJobRequirementEntries(requirements: any[], allocations: any[], boxById: Record<string, any>) {
  const coverage = buildAllocationCoverageByRequirementKey(allocations, boxById);
  const response = requirements.map((requirement) => {
    const key = normalizeJobRequirementLookupKey(
      requirement.manufacturer,
      requirement.filmName,
      requirement.widthIn,
    );
    const allocatedFeet = Math.max(0, Number(coverage[key] || 0));
    const requiredFeet = Math.max(0, Number(requirement.requiredFeet || 0));
    const remainingFeet = Math.max(0, requiredFeet - allocatedFeet);
    return {
      requirementId: requirement.id || createLogId(),
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: requirement.widthIn,
      requiredFeet,
      allocatedFeet: requiredFeet - remainingFeet,
      remainingFeet,
    };
  });
  response.sort((left, right) => {
    const manufacturerCompare = compareCatalogStrings(left.manufacturer, right.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }
    const filmCompare = compareCatalogStrings(left.filmName, right.filmName);
    if (filmCompare !== 0) {
      return filmCompare;
    }
    if (left.widthIn !== right.widthIn) {
      return left.widthIn < right.widthIn ? -1 : 1;
    }
    return compareCatalogStrings(left.requirementId, right.requirementId);
  });
  return response;
}

function resolveAllocationJobMetadata(allocations: any[], filmOrders: any[]) {
  let jobDate = "";
  let crewLeader = "";
  for (const allocation of allocations) {
    if (!jobDate && allocation.jobDate) {
      jobDate = allocation.jobDate;
    }
    if (!crewLeader && allocation.crewLeader) {
      crewLeader = allocation.crewLeader;
    }
  }
  for (const filmOrder of filmOrders) {
    if (!jobDate && filmOrder.jobDate) {
      jobDate = filmOrder.jobDate;
    }
    if (!crewLeader && filmOrder.crewLeader) {
      crewLeader = filmOrder.crewLeader;
    }
  }
  return { jobDate, crewLeader };
}

function buildAllocationJobSummary(jobNumber: string, allocations: any[], filmOrders: any[]) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let hasFilmOrder = false;
  let hasFilmOnTheWay = false;
  let hasActiveAllocation = false;
  let hasCancelledRecord = false;
  let hasFulfilledRecord = false;
  let activeAllocatedFeet = 0;
  let fulfilledAllocatedFeet = 0;
  let openFilmOrderCount = 0;
  const distinctBoxes: Record<string, boolean> = {};

  for (const allocation of allocations) {
    if (allocation.boxId) {
      distinctBoxes[allocation.boxId] = true;
    }
    if (allocation.status === "ACTIVE") {
      hasActiveAllocation = true;
      activeAllocatedFeet += allocation.allocatedFeet;
    } else if (allocation.status === "FULFILLED") {
      hasFulfilledRecord = true;
      fulfilledAllocatedFeet += allocation.allocatedFeet;
    } else if (allocation.status === "CANCELLED") {
      hasCancelledRecord = true;
    }
  }

  for (const filmOrder of filmOrders) {
    if (filmOrder.status === "FILM_ORDER") {
      hasFilmOrder = true;
      openFilmOrderCount += 1;
    } else if (filmOrder.status === "FILM_ON_THE_WAY") {
      hasFilmOnTheWay = true;
      openFilmOrderCount += 1;
    } else if (filmOrder.status === "FULFILLED") {
      hasFulfilledRecord = true;
    } else if (filmOrder.status === "CANCELLED") {
      hasCancelledRecord = true;
    }
  }

  let status = "READY";
  if (hasFilmOrder) {
    status = "FILM_ORDER";
  } else if (hasFilmOnTheWay) {
    status = "ON_ORDER";
  } else if (hasActiveAllocation) {
    status = "READY";
  } else if (hasCancelledRecord) {
    status = "CANCELLED";
  } else if (hasFulfilledRecord) {
    status = "COMPLETED";
  }

  return {
    jobNumber,
    jobDate: metadata.jobDate,
    crewLeader: metadata.crewLeader,
    status,
    activeAllocatedFeet,
    fulfilledAllocatedFeet,
    openFilmOrderCount,
    boxCount: Object.keys(distinctBoxes).length,
  };
}

function buildLegacyJobHeaderFromData(jobNumber: string, allocations: any[], filmOrders: any[]) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let warehouse = "";
  let createdAt = "";
  let updatedAt = "";

  for (const allocation of allocations) {
    if (!warehouse && allocation.warehouse) {
      warehouse = allocation.warehouse;
    }
    if (!createdAt || (allocation.createdAt && allocation.createdAt < createdAt)) {
      createdAt = allocation.createdAt || createdAt;
    }
    if (!updatedAt || (allocation.createdAt && allocation.createdAt > updatedAt)) {
      updatedAt = allocation.createdAt || updatedAt;
    }
  }

  for (const filmOrder of filmOrders) {
    if (!warehouse && filmOrder.warehouse) {
      warehouse = filmOrder.warehouse;
    }
    if (!createdAt || (filmOrder.createdAt && filmOrder.createdAt < createdAt)) {
      createdAt = filmOrder.createdAt || createdAt;
    }
    const filmUpdatedAt = filmOrder.resolvedAt || filmOrder.createdAt;
    if (!updatedAt || (filmUpdatedAt && filmUpdatedAt > updatedAt)) {
      updatedAt = filmUpdatedAt || updatedAt;
    }
  }

  return {
    id: "",
    orgId: "",
    jobNumber,
    warehouse: warehouse || "",
    sections: null,
    dueDate: metadata.jobDate,
    crewLeader: metadata.crewLeader,
    lifecycleStatus: "ACTIVE",
    notes: "",
    createdAt,
    createdBy: "",
    updatedAt,
    updatedBy: "",
  };
}

function deriveJobStatusFromLegacyAllocationData(allocations: any[], filmOrders: any[]) {
  const legacySummary = buildAllocationJobSummary("", allocations || [], filmOrders || []);
  if (legacySummary.status === "CANCELLED") {
    return "CANCELLED";
  }
  if (legacySummary.status === "READY" || legacySummary.status === "COMPLETED") {
    return "READY";
  }
  return "ALLOCATE";
}

function computeJobStatusFromRequirements(
  lifecycleStatus: string,
  requirements: any[],
  allocations: any[],
  filmOrders: any[],
) {
  const normalizedLifecycleStatus = normalizeJobLifecycleStatus(lifecycleStatus);
  if (normalizedLifecycleStatus === "CANCELLED") {
    return "CANCELLED";
  }
  if (normalizedLifecycleStatus === "COMPLETED") {
    return "COMPLETED";
  }
  if (!requirements.length) {
    if (!allocations.length && !filmOrders.length) {
      return "ALLOCATE";
    }
    return deriveJobStatusFromLegacyAllocationData(allocations, filmOrders);
  }
  for (const requirement of requirements) {
    if (requirement.remainingFeet > 0) {
      return "ALLOCATE";
    }
  }
  return "READY";
}

function buildJobListEntry(jobHeader: any, requirements: any[], allocations: any[], filmOrders: any[]) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let dueDate = jobHeader.dueDate;
  if (!dueDate) {
    dueDate = metadata.jobDate;
  }
  const crewLeader = asTrimmedString(jobHeader.crewLeader) || metadata.crewLeader;
  let requiredFeet = 0;
  let allocatedFeet = 0;
  let remainingFeet = 0;
  for (const requirement of requirements) {
    requiredFeet += requirement.requiredFeet;
    allocatedFeet += requirement.allocatedFeet;
    remainingFeet += requirement.remainingFeet;
  }
  return {
    jobNumber: jobHeader.jobNumber,
    warehouse: jobHeader.warehouse || "",
    sections: jobHeader.sections,
    dueDate,
    crewLeader,
    status: computeJobStatusFromRequirements(jobHeader.lifecycleStatus, requirements, allocations, filmOrders),
    lifecycleStatus: normalizeJobLifecycleStatus(jobHeader.lifecycleStatus),
    requiredFeet,
    allocatedFeet,
    remainingFeet,
    requirementCount: requirements.length,
    allocationCount: allocations.length,
    filmOrderCount: filmOrders.length,
    updatedAt: jobHeader.updatedAt || "",
    notes: jobHeader.notes || "",
  };
}

function buildPublicAllocationEntriesForJob(allocations: any[], boxById: Record<string, any>) {
  return allocations
    .slice()
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === "ACTIVE"
          ? -1
          : right.status === "ACTIVE"
          ? 1
          : left.status < right.status
          ? -1
          : 1;
      }
      if (left.jobDate !== right.jobDate) {
        if (left.jobDate && right.jobDate) {
          return left.jobDate < right.jobDate ? -1 : 1;
        }
        if (left.jobDate) {
          return -1;
        }
        if (right.jobDate) {
          return 1;
        }
      }
      return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    })
    .map((entry) => {
      const box = boxById[entry.boxId];
      const checkedOutOnThisJob = Boolean(
        box &&
          box.status === "CHECKED_OUT" &&
          normalizeJobNumberKey(box.lastCheckoutJob) === normalizeJobNumberKey(entry.jobNumber),
      );
      return {
        ...toPublicAllocation(entry),
        manufacturer: box ? box.manufacturer : "",
        filmName: box ? box.filmName : "",
        widthIn: box ? box.widthIn : 0,
        boxStatus: box ? box.status : "",
        checkedOutOnThisJob,
      };
    });
}

function parseCrossWarehouseFlag(value: unknown): boolean {
  return value === true || String(value).toLowerCase() === "true";
}

function getDateConflictJobsForBox(
  boxId: string,
  jobContext: { jobNumber: string; jobDate: string; crewLeader: string },
  activeAllocationsByBox: Record<string, any[]>,
) {
  if (!jobContext.jobDate) {
    return [];
  }
  const active = getActiveAllocationsForBox(boxId, activeAllocationsByBox);
  const conflicts: string[] = [];
  const seen: Record<string, boolean> = {};
  for (const entry of active) {
    if (
      entry.jobDate !== jobContext.jobDate ||
      normalizeJobNumberKey(entry.jobNumber) === normalizeJobNumberKey(jobContext.jobNumber)
    ) {
      continue;
    }
    if (normalizeCrewLeaderKey(entry.crewLeader) === normalizeCrewLeaderKey(jobContext.crewLeader)) {
      continue;
    }
    if (!seen[entry.jobNumber]) {
      seen[entry.jobNumber] = true;
      conflicts.push(entry.jobNumber);
    }
  }
  return conflicts;
}

async function buildPublicFilmOrderLinkedBoxes(client: any, orgId: string, filmOrderId: string) {
  const links = await listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  const response: Array<{ boxId: string; orderedFeet: number; autoAllocatedFeet: number }> = [];
  for (const link of links) {
    const box = await findBoxById(client, orgId, asTrimmedString(link.box_id));
    if (!box) {
      continue;
    }
    response.push({
      boxId: asTrimmedString(link.box_id),
      orderedFeet: integerOrZero(link.ordered_feet),
      autoAllocatedFeet: integerOrZero(link.auto_allocated_feet),
    });
  }
  response.sort((left, right) => left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0);
  return response;
}

async function buildPublicFilmOrdersForJob(client: any, orgId: string, filmOrders: any[]) {
  const response = [];
  const sorted = filmOrders.slice().sort((left, right) =>
    compareAllocationJobSummaries(
      { jobDate: left.createdAt, jobNumber: left.filmOrderId },
      { jobDate: right.createdAt, jobNumber: right.filmOrderId },
    )
  );
  for (const entry of sorted) {
    const linkedBoxes = await buildPublicFilmOrderLinkedBoxes(client, orgId, entry.filmOrderId);
    response.push(toPublicFilmOrder(entry, linkedBoxes));
  }
  return response;
}

async function resolveJobContext(client: any, orgId: string, jobNumber: unknown, jobDate: unknown, crewLeader: unknown) {
  const normalizedJobNumber = requireString(jobNumber, "JobNumber");
  const normalizedJobDate = normalizeDateString(jobDate, "JobDate", true);
  const normalizedCrewLeader = asTrimmedString(crewLeader);
  const existingHeader = await findJobByNumber(client, orgId, normalizedJobNumber);
  if (existingHeader && normalizeJobLifecycleStatus(existingHeader.lifecycleStatus) !== "ACTIVE") {
    throw new HttpError(400, `Job ${normalizedJobNumber} is closed and cannot receive allocations.`);
  }
  const existingAllocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const existingFilmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  let existingJobDate = existingHeader?.dueDate || "";
  let existingCrewLeader = existingHeader?.crewLeader || "";

  for (const entry of existingAllocations) {
    if (!existingJobDate && entry.jobDate) {
      existingJobDate = entry.jobDate;
    }
    if (!existingCrewLeader && entry.crewLeader) {
      existingCrewLeader = entry.crewLeader;
    }
  }
  for (const entry of existingFilmOrders) {
    if (!existingJobDate && entry.jobDate) {
      existingJobDate = entry.jobDate;
    }
    if (!existingCrewLeader && entry.crewLeader) {
      existingCrewLeader = entry.crewLeader;
    }
  }

  if (existingJobDate && normalizedJobDate && existingJobDate !== normalizedJobDate) {
    throw new HttpError(400, "JobDate must stay the same for an existing Job Number.");
  }
  if (
    existingCrewLeader &&
    normalizedCrewLeader &&
    normalizeCrewLeaderKey(existingCrewLeader) !== normalizeCrewLeaderKey(normalizedCrewLeader)
  ) {
    throw new HttpError(400, "CrewLeader must stay the same for an existing Job Number.");
  }

  const resolvedJobDate = normalizedJobDate || existingJobDate;
  const resolvedCrewLeader = normalizedCrewLeader || existingCrewLeader;
  if (resolvedJobDate && !resolvedCrewLeader) {
    throw new HttpError(400, "CrewLeader is required when JobDate is set.");
  }

  return {
    jobNumber: normalizedJobNumber,
    jobDate: resolvedJobDate,
    crewLeader: resolvedCrewLeader,
  };
}

function buildAllocationPreviewPlan(
  sourceBox: any,
  requestedFeet: unknown,
  jobContext: { jobNumber: string; jobDate: string; crewLeader: string },
  options: {
    crossWarehouse: boolean;
    minimumWidthIn?: unknown;
    allBoxes: any[];
    activeAllocationsByBox: Record<string, any[]>;
  },
) {
  const requested = coerceFeetValue(requestedFeet, "RequestedFeet", [], true);
  if (requested <= 0) {
    throw new HttpError(400, "RequestedFeet must be greater than zero.");
  }
  const minimumWidthValue = Number(options.minimumWidthIn);
  const minimumWidthIn =
    Number.isFinite(minimumWidthValue) && minimumWidthValue > 0 ? minimumWidthValue : sourceBox.widthIn;
  if (sourceBox.widthIn < minimumWidthIn) {
    throw new HttpError(400, "Source box width must meet or exceed the requested width.");
  }
  const sourceConflicts = getDateConflictJobsForBox(sourceBox.boxId, jobContext, options.activeAllocationsByBox);
  const sourceSuggestedFeet = sourceConflicts.length ? 0 : Math.min(sourceBox.feetAvailable, requested);
  let remaining = requested - sourceSuggestedFeet;
  const candidateBoxes = options.crossWarehouse
    ? options.allBoxes
    : options.allBoxes.filter((box) => box.warehouse === sourceBox.warehouse);
  const filteredCandidates = candidateBoxes.filter((candidate) =>
    candidate.boxId !== sourceBox.boxId &&
    candidate.status === "IN_STOCK" &&
    candidate.feetAvailable > 0 &&
    candidate.manufacturer === sourceBox.manufacturer &&
    candidate.filmName === sourceBox.filmName &&
    candidate.widthIn >= minimumWidthIn
  );
  filteredCandidates.sort((left, right) => {
    const leftWidthDelta = left.widthIn - minimumWidthIn;
    const rightWidthDelta = right.widthIn - minimumWidthIn;
    if (leftWidthDelta !== rightWidthDelta) {
      return leftWidthDelta - rightWidthDelta;
    }

    return compareBoxesByOldestStock(left, right);
  });

  const suggestions: any[] = [];
  for (const candidate of filteredCandidates) {
    const conflicts = getDateConflictJobsForBox(candidate.boxId, jobContext, options.activeAllocationsByBox);
    if (conflicts.length) {
      continue;
    }
    const suggestedFeet = remaining > 0 ? Math.min(candidate.feetAvailable, remaining) : 0;
    suggestions.push({
      boxId: candidate.boxId,
      warehouse: candidate.warehouse,
      widthIn: candidate.widthIn,
      availableFeet: candidate.feetAvailable,
      suggestedFeet,
      receivedDate: candidate.receivedDate,
      orderDate: candidate.orderDate,
    });
    if (remaining > 0) {
      remaining -= Math.min(candidate.feetAvailable, remaining);
    }
  }

  return {
    jobNumber: jobContext.jobNumber,
    jobDate: jobContext.jobDate,
    crewLeader: jobContext.crewLeader,
    requestedFeet: requested,
    sourceBoxId: sourceBox.boxId,
    sourceWarehouse: sourceBox.warehouse,
    sourceBoxFeetAvailable: sourceBox.feetAvailable,
    sourceSuggestedFeet,
    sourceConflicts,
    suggestions,
    defaultCoveredFeet: requested - remaining,
    defaultRemainingFeet: remaining,
  };
}

function boxMatchesReportFilters(box: any, filters: any) {
  if (filters.warehouse && box.warehouse !== filters.warehouse) {
    return false;
  }
  if (
    filters.manufacturer &&
    box.manufacturer.toLowerCase().indexOf(filters.manufacturer.toLowerCase()) === -1
  ) {
    return false;
  }
  if (
    filters.film &&
    box.filmName.toLowerCase().indexOf(filters.film.toLowerCase()) === -1 &&
    box.filmKey.toLowerCase().indexOf(filters.film.toLowerCase()) === -1 &&
    box.manufacturer.toLowerCase().indexOf(filters.film.toLowerCase()) === -1
  ) {
    return false;
  }
  if (filters.width && String(box.widthIn) !== filters.width) {
    return false;
  }
  return true;
}

function extractClosedDate(updatedAt: unknown): string {
  const timestamp = asTrimmedString(updatedAt);
  if (!timestamp) {
    return "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(timestamp)) {
    return timestamp;
  }
  return timestamp.slice(0, 10);
}

function matchesClosedJobReportFilters(jobEntry: any, filters: any): boolean {
  if (filters.warehouse && jobEntry.warehouse !== filters.warehouse) {
    return false;
  }

  const closedDate = extractClosedDate(jobEntry.updatedAt);
  if (!closedDate) {
    return false;
  }
  if (filters.from && closedDate < filters.from) {
    return false;
  }
  if (filters.to && closedDate > filters.to) {
    return false;
  }
  return true;
}

async function buildSearchBoxes(client: any, orgId: string, params: Record<string, unknown>) {
  const warehouse = requireString(params.warehouse, "warehouse").toUpperCase();
  const warehouseRows = await rpcOrThrow<any[]>(client, "api_acl_list_warehouses", {
    p_org_id: orgId,
  });
  const isConfiguredWarehouse = (warehouseRows || []).some((row) =>
    asTrimmedString(row.code).toUpperCase() === warehouse
  );
  if (!isConfiguredWarehouse) {
    throw new HttpError(400, "warehouse is not configured.");
  }
  const query = asTrimmedString(params.q).toLowerCase();
  const status = asTrimmedString(params.status).toUpperCase();
  const film = asTrimmedString(params.film).toLowerCase();
  const width = asTrimmedString(params.width);
  const showRetired = String(params.showRetired) === "true";
  const boxes = (await listBoxes(client, orgId)).filter((box) => box.warehouse === warehouse);
  let filtered = boxes.filter((box) => {
    if (!showRetired && !status && (box.status === "ZEROED" || box.status === "RETIRED")) {
      return false;
    }
    if (status && box.status !== status) {
      return false;
    }
    if (width && String(box.widthIn) !== width) {
      return false;
    }
    if (
      film &&
      box.filmName.toLowerCase().indexOf(film) === -1 &&
      box.manufacturer.toLowerCase().indexOf(film) === -1 &&
      box.filmKey.toLowerCase().indexOf(film) === -1
    ) {
      return false;
    }
    if (query) {
      const haystack = [box.boxId, box.manufacturer, box.filmName, box.lotRun, box.filmKey].join(" ").toLowerCase();
      if (haystack.indexOf(query) === -1) {
        return false;
      }
    }
    return true;
  }).map(toPublicBox);

  if (film) {
    const lowStock = filtered.filter((box) =>
      box.status === "IN_STOCK" && box.feetAvailable > 0 && box.feetAvailable < 10
    );
    const remaining = filtered.filter((box) => !lowStock.includes(box));
    lowStock.sort((left, right) =>
      left.feetAvailable !== right.feetAvailable
        ? left.feetAvailable - right.feetAvailable
        : left.boxId < right.boxId
        ? -1
        : left.boxId > right.boxId
        ? 1
        : 0
    );
    filtered = lowStock.concat(remaining);
  }

  return filtered;
}

async function buildAllocationJobList(client: any, orgId: string) {
  const allAllocations = await listAllocations(client, orgId);
  const allFilmOrders = await listFilmOrders(client, orgId);
  const groupedAllocations: Record<string, any[]> = {};
  const groupedFilmOrders: Record<string, any[]> = {};
  const jobNumbers: Record<string, boolean> = {};

  for (const allocation of allAllocations) {
    if (allocation.jobNumber) {
      jobNumbers[allocation.jobNumber] = true;
      if (!groupedAllocations[allocation.jobNumber]) {
        groupedAllocations[allocation.jobNumber] = [];
      }
      groupedAllocations[allocation.jobNumber].push(allocation);
    }
  }

  for (const filmOrder of allFilmOrders) {
    if (filmOrder.jobNumber) {
      jobNumbers[filmOrder.jobNumber] = true;
      if (!groupedFilmOrders[filmOrder.jobNumber]) {
        groupedFilmOrders[filmOrder.jobNumber] = [];
      }
      groupedFilmOrders[filmOrder.jobNumber].push(filmOrder);
    }
  }

  const response = Object.keys(jobNumbers).map((jobNumber) =>
    buildAllocationJobSummary(jobNumber, groupedAllocations[jobNumber] || [], groupedFilmOrders[jobNumber] || [])
  );
  response.sort(compareAllocationJobSummaries);
  return response;
}

async function buildAllocationJobDetail(client: any, orgId: string, jobNumber: unknown) {
  const normalizedJobNumber = requireString(jobNumber, "jobNumber");
  const allocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  const rollHistory = await listRollHistoryByJob(client, orgId, normalizedJobNumber, allocations);
  if (!allocations.length && !filmOrders.length) {
    throw new HttpError(404, "Job not found.");
  }
  const boxes = await listBoxes(client, orgId);
  const boxById = Object.fromEntries(boxes.map((box) => [box.boxId, box]));
  return {
    summary: buildAllocationJobSummary(normalizedJobNumber, allocations, filmOrders),
    allocations: buildPublicAllocationEntriesForJob(allocations, boxById),
    usage: buildPublicJobUsageEntries(rollHistory, boxById),
    filmOrders: await buildPublicFilmOrdersForJob(client, orgId, filmOrders),
  };
}

async function buildJobsList(client: any, orgId: string, limit: number) {
  const jobs = await listJobs(client, orgId);
  const allAllocations = await listAllocations(client, orgId);
  const allFilmOrders = await listFilmOrders(client, orgId);
  const allRequirements = await listJobRequirements(client, orgId);
  const allBoxes = await listBoxes(client, orgId);
  const groupedAllocations: Record<string, any[]> = {};
  const groupedFilmOrders: Record<string, any[]> = {};
  const groupedRequirements: Record<string, any[]> = {};
  const byJobNumber: Record<string, any> = {};
  const boxById = Object.fromEntries(allBoxes.map((box) => [box.boxId, box]));

  for (const job of jobs) {
    byJobNumber[job.jobNumber] = job;
  }
  for (const allocation of allAllocations) {
    if (allocation.jobNumber) {
      byJobNumber[allocation.jobNumber] = byJobNumber[allocation.jobNumber] || null;
      if (!groupedAllocations[allocation.jobNumber]) {
        groupedAllocations[allocation.jobNumber] = [];
      }
      groupedAllocations[allocation.jobNumber].push(allocation);
    }
  }
  for (const filmOrder of allFilmOrders) {
    if (filmOrder.jobNumber) {
      byJobNumber[filmOrder.jobNumber] = byJobNumber[filmOrder.jobNumber] || null;
      if (!groupedFilmOrders[filmOrder.jobNumber]) {
        groupedFilmOrders[filmOrder.jobNumber] = [];
      }
      groupedFilmOrders[filmOrder.jobNumber].push(filmOrder);
    }
  }
  for (const requirement of allRequirements) {
    if (!groupedRequirements[requirement.jobNumber]) {
      groupedRequirements[requirement.jobNumber] = [];
    }
    groupedRequirements[requirement.jobNumber].push(requirement);
  }

  const response = Object.keys(byJobNumber).map((jobNumber) => {
    const allocations = groupedAllocations[jobNumber] || [];
    const filmOrders = groupedFilmOrders[jobNumber] || [];
    const requirements = buildPublicJobRequirementEntries(
      groupedRequirements[jobNumber] || [],
      allocations,
      boxById,
    );
    const header = byJobNumber[jobNumber] || buildLegacyJobHeaderFromData(jobNumber, allocations, filmOrders);
    return buildJobListEntry(header, requirements, allocations, filmOrders);
  });

  response.sort(compareJobsListEntries);
  return limit > 0 && response.length > limit ? response.slice(0, limit) : response;
}

async function buildJobsSearchResults(client: any, orgId: string, query: unknown, limit: number) {
  const normalizedQueryDigits = normalizeJobNumberDigits(query);
  if (!normalizedQueryDigits) {
    return [];
  }

  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 25;
  const queryCanonical = canonicalizeNumericDigits(normalizedQueryDigits);
  const queryValue = BigInt(queryCanonical);
  const ranked: Array<{
    entry: any;
    isPrefixMatch: boolean;
    isExactMatch: boolean;
    distance: bigint;
    lengthDelta: number;
  }> = [];
  const entries = await buildJobsList(client, orgId, 0);

  for (const entry of entries) {
    const lifecycle = asTrimmedString((entry as Record<string, unknown>).lifecycleStatus || "ACTIVE").toUpperCase();
    if (lifecycle !== "ACTIVE") {
      continue;
    }

    const jobDigits = normalizeJobNumberDigits((entry as Record<string, unknown>).jobNumber);
    if (!jobDigits) {
      continue;
    }

    const jobCanonical = canonicalizeNumericDigits(jobDigits);
    const jobValue = BigInt(jobCanonical);
    const isPrefixMatch = jobCanonical.startsWith(queryCanonical);
    ranked.push({
      entry,
      isPrefixMatch,
      isExactMatch: jobCanonical === queryCanonical,
      distance: absoluteBigInt(jobValue - queryValue),
      lengthDelta: Math.abs(jobCanonical.length - queryCanonical.length),
    });
  }

  ranked.sort((left, right) => {
    if (left.isPrefixMatch !== right.isPrefixMatch) {
      return left.isPrefixMatch ? -1 : 1;
    }

    if (left.isPrefixMatch && right.isPrefixMatch) {
      if (left.isExactMatch !== right.isExactMatch) {
        return left.isExactMatch ? -1 : 1;
      }

      if (left.lengthDelta !== right.lengthDelta) {
        return left.lengthDelta - right.lengthDelta;
      }
    }

    const distanceOrder = compareBigInt(left.distance, right.distance);
    if (distanceOrder !== 0) {
      return distanceOrder;
    }

    return compareJobsListEntries(left.entry, right.entry);
  });

  return ranked.slice(0, normalizedLimit).map((entry) => entry.entry);
}

async function buildJobDetail(client: any, orgId: string, jobNumber: unknown) {
  const normalizedJobNumber = requireString(jobNumber, "jobNumber");
  let header = await findJobByNumber(client, orgId, normalizedJobNumber);
  const allocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  const requirements = await listJobRequirementsByJob(client, orgId, normalizedJobNumber);
  const rollHistory = await listRollHistoryByJob(client, orgId, normalizedJobNumber, allocations);

  if (!header && !allocations.length && !filmOrders.length && !requirements.length) {
    throw new HttpError(404, "Job not found.");
  }
  if (!header) {
    header = buildLegacyJobHeaderFromData(normalizedJobNumber, allocations, filmOrders);
  }
  const boxes = await listBoxes(client, orgId);
  const boxById = Object.fromEntries(boxes.map((box) => [box.boxId, box]));
  const publicRequirements = buildPublicJobRequirementEntries(requirements, allocations, boxById);
  return {
    summary: buildJobListEntry(header, publicRequirements, allocations, filmOrders),
    requirements: publicRequirements,
    allocations: buildPublicAllocationEntriesForJob(allocations, boxById),
    usage: buildPublicJobUsageEntries(rollHistory, boxById),
    filmOrders: await buildPublicFilmOrdersForJob(client, orgId, filmOrders),
  };
}

async function buildReportsSummary(client: any, orgId: string, params: Record<string, unknown>) {
  const filters = {
    warehouse: asTrimmedString(params.warehouse).toUpperCase(),
    manufacturer: asTrimmedString(params.manufacturer),
    film: asTrimmedString(params.film),
    width: asTrimmedString(params.width),
    from: asTrimmedString(params.from),
    to: asTrimmedString(params.to),
  };
  const allBoxes = await listBoxes(client, orgId);
  const activeBoxes = allBoxes.filter((box) => box.status !== "ZEROED" && box.status !== "RETIRED");
  const widthGroups: Record<string, { widthIn: number; totalFeetAvailable: number; boxCount: number }> = {};
  const neverCheckedOut: any[] = [];
  const zeroedByMonthMap: Record<string, number> = {};
  const zeroedBoxes: any[] = [];
  const completedJobs: any[] = [];
  const cancelledJobs: any[] = [];

  for (const activeBox of activeBoxes) {
    if (!boxMatchesReportFilters(activeBox, filters)) {
      continue;
    }
    const widthKey = String(activeBox.widthIn);
    if (!widthGroups[widthKey]) {
      widthGroups[widthKey] = {
        widthIn: activeBox.widthIn,
        totalFeetAvailable: 0,
        boxCount: 0,
      };
    }
    widthGroups[widthKey].totalFeetAvailable += activeBox.feetAvailable;
    widthGroups[widthKey].boxCount += 1;
  }

  for (const box of allBoxes) {
    if (!boxMatchesReportFilters(box, filters)) {
      continue;
    }
    if (box.receivedDate && !box.hasEverBeenCheckedOut) {
      if (filters.from && box.receivedDate < filters.from) {
        continue;
      }
      if (filters.to && box.receivedDate > filters.to) {
        continue;
      }
      neverCheckedOut.push({
        boxId: box.boxId,
        warehouse: box.warehouse,
        manufacturer: box.manufacturer,
        filmName: box.filmName,
        widthIn: box.widthIn,
        receivedDate: box.receivedDate,
        status: box.status,
        feetAvailable: box.feetAvailable,
      });
    }
    if (box.status === "ZEROED" && box.zeroedDate) {
      if (filters.from && box.zeroedDate < filters.from) {
        continue;
      }
      if (filters.to && box.zeroedDate > filters.to) {
        continue;
      }
      zeroedBoxes.push({
        boxId: box.boxId,
        warehouse: box.warehouse,
        manufacturer: box.manufacturer,
        filmName: box.filmName,
        widthIn: box.widthIn,
        zeroedDate: box.zeroedDate,
      });
      const monthKey = box.zeroedDate.slice(0, 7);
      zeroedByMonthMap[monthKey] = (zeroedByMonthMap[monthKey] || 0) + 1;
    }
  }

  neverCheckedOut.sort((left, right) =>
    left.receivedDate !== right.receivedDate
      ? left.receivedDate < right.receivedDate
        ? -1
        : 1
      : left.boxId < right.boxId
      ? -1
      : left.boxId > right.boxId
      ? 1
      : 0
  );

  const availableFeetByWidth = Object.values(widthGroups).sort((left, right) => left.widthIn - right.widthIn);
  const zeroedByMonth = Object.keys(zeroedByMonthMap)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((month) => ({ month, zeroedCount: zeroedByMonthMap[month] }));
  zeroedBoxes.sort((left, right) => {
    if (left.zeroedDate !== right.zeroedDate) {
      return left.zeroedDate > right.zeroedDate ? -1 : 1;
    }
    return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
  });

  const allJobEntries = await buildJobsList(client, orgId, 0);
  for (const jobEntry of allJobEntries) {
    const lifecycleStatus = normalizeJobLifecycleStatus(jobEntry.lifecycleStatus);
    if (lifecycleStatus !== "COMPLETED" && lifecycleStatus !== "CANCELLED") {
      continue;
    }
    if (!matchesClosedJobReportFilters(jobEntry, filters)) {
      continue;
    }

    const reportEntry = {
      jobNumber: jobEntry.jobNumber,
      warehouse: jobEntry.warehouse,
      dueDate: jobEntry.dueDate,
      crewLeader: jobEntry.crewLeader,
      status: jobEntry.status,
      lifecycleStatus,
      requiredFeet: jobEntry.requiredFeet,
      allocatedFeet: jobEntry.allocatedFeet,
      remainingFeet: jobEntry.remainingFeet,
      closedAt: asTrimmedString(jobEntry.updatedAt),
    };

    if (lifecycleStatus === "COMPLETED") {
      completedJobs.push(reportEntry);
    } else {
      cancelledJobs.push(reportEntry);
    }
  }

  const compareClosedJobs = (left: any, right: any) => {
    if (left.closedAt !== right.closedAt) {
      return left.closedAt > right.closedAt ? -1 : 1;
    }
    return left.jobNumber > right.jobNumber ? -1 : left.jobNumber < right.jobNumber ? 1 : 0;
  };
  completedJobs.sort(compareClosedJobs);
  cancelledJobs.sort(compareClosedJobs);

  return {
    availableFeetByWidth,
    neverCheckedOut,
    zeroedByMonth,
    zeroedBoxes,
    completedJobs,
    cancelledJobs,
  };
}

async function listAudit(client: any, orgId: string, params: Record<string, unknown>) {
  const from = asTrimmedString(params.from);
  const to = asTrimmedString(params.to);
  const user = asTrimmedString(params.user).toLowerCase();
  const action = asTrimmedString(params.action).toLowerCase();
  const entries = await listAuditEntries(client, orgId);
  return entries.filter((entry) => {
    const entryDate = entry.date.slice(0, 10);
    if (from && entryDate < from) {
      return false;
    }
    if (to && entryDate > to) {
      return false;
    }
    if (user && entry.user.toLowerCase().indexOf(user) === -1) {
      return false;
    }
    if (action && entry.action.toLowerCase().indexOf(action) === -1) {
      return false;
    }
    return true;
  });
}

async function buildFilmOrdersList(client: any, orgId: string) {
  const entries = await listFilmOrders(client, orgId);
  const sorted = entries.slice().sort((left, right) => {
    const leftOpen = left.status === "FILM_ORDER" || left.status === "FILM_ON_THE_WAY";
    const rightOpen = right.status === "FILM_ORDER" || right.status === "FILM_ON_THE_WAY";
    if (leftOpen !== rightOpen) {
      return leftOpen ? -1 : 1;
    }
    if (leftOpen) {
      return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    }
    const leftResolved = left.resolvedAt || left.createdAt;
    const rightResolved = right.resolvedAt || right.createdAt;
    return leftResolved < rightResolved ? -1 : leftResolved > rightResolved ? 1 : 0;
  });
  const response = [];
  for (const entry of sorted) {
    response.push(
      toPublicFilmOrder(entry, await buildPublicFilmOrderLinkedBoxes(client, orgId, entry.filmOrderId)),
    );
  }
  return response;
}

async function buildFilmCatalog(client: any, orgId: string) {
  const entries = await listFilmCatalog(client, orgId);
  const dedupedByKey: Record<string, any> = {};
  for (const entry of entries) {
    const manufacturer = normalizeCollapsedCatalogLabel(entry.manufacturer);
    const filmName = normalizeCollapsedCatalogLabel(entry.filmName);
    const manufacturerKey = normalizeCatalogLookupKey(manufacturer);
    const filmNameKey = normalizeCatalogLookupKey(filmName);
    if (!manufacturerKey || !filmNameKey) {
      continue;
    }
    dedupedByKey[`${manufacturerKey}|${filmNameKey}`] = {
      filmKey: asTrimmedString(entry.filmKey).toUpperCase(),
      manufacturer,
      filmName,
      updatedAt: asTrimmedString(entry.updatedAt),
    };
  }
  const response = Object.values(dedupedByKey);
  response.sort((left: any, right: any) => {
    const manufacturerCompare = compareCatalogStrings(left.manufacturer, right.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }
    const filmCompare = compareCatalogStrings(left.filmName, right.filmName);
    if (filmCompare !== 0) {
      return filmCompare;
    }
    return compareCatalogStrings(left.filmKey, right.filmKey);
  });
  return response;
}

function throwOnSupabaseError(error: any, messagePrefix: string): void {
  if (!error) {
    return;
  }
  throw new HttpError(500, `${messagePrefix}: ${asTrimmedString(error.message) || "Unexpected database error."}`);
}

function requireServiceRoleClientForJobs() {
  const serviceClient = createServiceRoleClient();
  if (!serviceClient) {
    throw new HttpError(500, "SUPABASE_SERVICE_ROLE_KEY is required for job lifecycle close-out operations.");
  }
  return serviceClient;
}

async function completeJob(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  const warnings: string[] = [];
  const orgId = identity.orgId;
  const actor = identity.actor;
  const jobNumber = requireString(payload.jobNumber, "JobNumber");
  const serviceClient = requireServiceRoleClientForJobs();

  const { data: jobRow, error: jobError } = await serviceClient
    .schema("app")
    .from("jobs")
    .select("id, org_id, job_number, lifecycle_status")
    .eq("org_id", orgId)
    .eq("job_number", jobNumber)
    .maybeSingle();
  throwOnSupabaseError(jobError, "Unable to load job");
  if (!jobRow) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const lifecycleStatus = normalizeJobLifecycleStatus((jobRow as Record<string, unknown>).lifecycle_status);
  if (lifecycleStatus === "COMPLETED") {
    throw new HttpError(400, `Job ${jobNumber} is already completed.`);
  }
  if (lifecycleStatus === "CANCELLED") {
    throw new HttpError(400, `Job ${jobNumber} is cancelled and cannot be completed.`);
  }

  const { data: checkedOutRows, error: checkedOutError } = await serviceClient
    .schema("app")
    .from("boxes")
    .select("box_id, last_checkout_job")
    .eq("org_id", orgId)
    .eq("status", "CHECKED_OUT");
  throwOnSupabaseError(checkedOutError, "Unable to load checked-out boxes");
  const matchingCheckedOutRows = (Array.isArray(checkedOutRows) ? checkedOutRows : []).filter((row) =>
    normalizeJobNumberKey((row as Record<string, unknown>).last_checkout_job) === normalizeJobNumberKey(jobNumber)
  );
  if (matchingCheckedOutRows.length) {
    const listedBoxes = matchingCheckedOutRows
      .slice(0, 5)
      .map((row) => asTrimmedString((row as Record<string, unknown>).box_id))
      .join(", ");
    const suffix = matchingCheckedOutRows.length > 5 ? ", ..." : "";
    throw new HttpError(
      400,
      `Job ${jobNumber} cannot be completed while boxes are still checked out: ${listedBoxes}${suffix}.`,
    );
  }

  const nowIso = new Date().toISOString();
  const cancelNote = asTrimmedString(payload.reason) || `Cancelled because job ${jobNumber} was marked completed.`;
  const { data: activeAllocations, error: activeAllocationsError } = await serviceClient
    .schema("app")
    .from("allocations")
    .select("id, box_id, allocated_feet")
    .eq("org_id", orgId)
    .eq("job_number", jobNumber)
    .eq("status", "ACTIVE");
  throwOnSupabaseError(activeAllocationsError, "Unable to load active allocations");

  const releasedFeetByBox: Record<string, number> = {};
  let cancelledAllocationCount = 0;
  for (const row of Array.isArray(activeAllocations) ? activeAllocations : []) {
    const allocationId = (row as Record<string, unknown>).id;
    const boxId = asTrimmedString((row as Record<string, unknown>).box_id);
    const allocatedFeet = integerOrZero((row as Record<string, unknown>).allocated_feet);
    if (!allocationId || !boxId) {
      continue;
    }

    const { error: updateAllocationError } = await serviceClient
      .schema("app")
      .from("allocations")
      .update({
        status: "CANCELLED",
        resolved_at: nowIso,
        resolved_by: actor,
        notes: cancelNote,
      })
      .eq("org_id", orgId)
      .eq("id", allocationId);
    throwOnSupabaseError(updateAllocationError, `Unable to cancel allocation ${asTrimmedString(allocationId)}`);

    releasedFeetByBox[boxId] = integerOrZero(releasedFeetByBox[boxId]) + allocatedFeet;
    cancelledAllocationCount += 1;
  }

  for (const [boxId, releasedFeet] of Object.entries(releasedFeetByBox)) {
    const { data: boxRow, error: boxError } = await serviceClient
      .schema("app")
      .from("boxes")
      .select("id, status, feet_available")
      .eq("org_id", orgId)
      .eq("box_id", boxId)
      .maybeSingle();
    throwOnSupabaseError(boxError, `Unable to load box ${boxId}`);
    if (!boxRow) {
      continue;
    }

    const boxStatus = asTrimmedString((boxRow as Record<string, unknown>).status);
    if (boxStatus === "ZEROED" || boxStatus === "RETIRED") {
      continue;
    }

    const nextFeetAvailable = Math.max(0, integerOrZero((boxRow as Record<string, unknown>).feet_available) + releasedFeet);
    const { error: updateBoxError } = await serviceClient
      .schema("app")
      .from("boxes")
      .update({ feet_available: nextFeetAvailable })
      .eq("org_id", orgId)
      .eq("id", (boxRow as Record<string, unknown>).id);
    throwOnSupabaseError(updateBoxError, `Unable to update box ${boxId}`);
  }

  const { data: openFilmOrders, error: openFilmOrdersError } = await serviceClient
    .schema("app")
    .from("film_orders")
    .select("id")
    .eq("org_id", orgId)
    .eq("job_number", jobNumber)
    .in("status", ["FILM_ORDER", "FILM_ON_THE_WAY"]);
  throwOnSupabaseError(openFilmOrdersError, "Unable to load open film orders");

  let cancelledFilmOrderCount = 0;
  for (const row of Array.isArray(openFilmOrders) ? openFilmOrders : []) {
    const filmOrderId = (row as Record<string, unknown>).id;
    if (!filmOrderId) {
      continue;
    }
    const { error: updateFilmOrderError } = await serviceClient
      .schema("app")
      .from("film_orders")
      .update({
        status: "CANCELLED",
        resolved_at: nowIso,
        resolved_by: actor,
        notes: cancelNote,
      })
      .eq("org_id", orgId)
      .eq("id", filmOrderId);
    throwOnSupabaseError(updateFilmOrderError, "Unable to cancel open film order");
    cancelledFilmOrderCount += 1;
  }

  const { error: completeJobError } = await serviceClient
    .schema("app")
    .from("jobs")
    .update({
      lifecycle_status: "COMPLETED",
      updated_at: nowIso,
      updated_by: actor,
    })
    .eq("org_id", orgId)
    .eq("id", (jobRow as Record<string, unknown>).id);
  throwOnSupabaseError(completeJobError, "Unable to mark job completed");

  warnings.push(
    `Marked job ${jobNumber} completed. Cancelled ${cancelledAllocationCount} active allocation${cancelledAllocationCount === 1 ? "" : "s"} and ${cancelledFilmOrderCount} open film order${cancelledFilmOrderCount === 1 ? "" : "s"}.`,
  );

  return ok(await buildJobDetail(client, orgId, jobNumber), warnings);
}

async function recalculateFilmOrderAfterAllocationMutation(
  client: any,
  serviceClient: any,
  orgId: string,
  filmOrderId: string,
  actor: string,
) {
  const existing = await findFilmOrderById(client, orgId, filmOrderId);
  if (!existing) {
    return;
  }

  const allocations = await listAllocationsByFilmOrderId(client, orgId, filmOrderId);
  let coveredFeet = 0;
  for (const allocation of allocations) {
    if (allocation.status !== "CANCELLED") {
      coveredFeet += integerOrZero(allocation.allocatedFeet);
    }
  }

  const links = await listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  let orderedFeet = 0;
  for (const link of links) {
    const linkRecord = link as Record<string, unknown>;
    const boxId = asTrimmedString(linkRecord.box_id);
    if (!boxId) {
      continue;
    }

    const box = await findBoxById(client, orgId, boxId);
    if (!box) {
      continue;
    }
    orderedFeet += integerOrZero(linkRecord.ordered_feet);
  }

  const requestedFeet = integerOrZero(existing.requestedFeet);
  const remainingToOrderFeet = Math.max(requestedFeet - orderedFeet, 0);
  let nextStatus = asTrimmedString(existing.status) || "FILM_ORDER";
  let resolvedAt: string | null = existing.resolvedAt || null;
  let resolvedBy: string | null = existing.resolvedBy || null;

  if (nextStatus !== "CANCELLED") {
    if (coveredFeet >= requestedFeet) {
      nextStatus = "FULFILLED";
      if (!resolvedAt) {
        resolvedAt = new Date().toISOString();
        resolvedBy = actor;
      }
    } else if (orderedFeet >= requestedFeet) {
      nextStatus = "FILM_ON_THE_WAY";
      resolvedAt = null;
      resolvedBy = null;
    } else {
      nextStatus = "FILM_ORDER";
      resolvedAt = null;
      resolvedBy = null;
    }
  }

  const { error: updateFilmOrderError } = await serviceClient
    .schema("app")
    .from("film_orders")
    .update({
      covered_feet: coveredFeet,
      ordered_feet: orderedFeet,
      remaining_to_order_feet: remainingToOrderFeet,
      status: nextStatus,
      resolved_at: resolvedAt,
      resolved_by: resolvedBy,
    })
    .eq("org_id", orgId)
    .eq("id", existing.id);
  throwOnSupabaseError(updateFilmOrderError, `Unable to recalculate film order ${filmOrderId}`);
}

async function removeJobBoxAllocation(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  const warnings: string[] = [];
  const orgId = identity.orgId;
  const actor = identity.actor;
  const jobNumber = requireString(payload.jobNumber, "JobNumber");
  const allocationId = requireString(payload.allocationId, "AllocationID");
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  const serviceClient = requireServiceRoleClientForJobs();

  const existingJob = await findJobByNumber(client, orgId, jobNumber);
  if (existingJob && normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== "ACTIVE") {
    throw new HttpError(400, `Job ${jobNumber} is closed and allocation rows cannot be removed.`);
  }

  const allocations = await listAllocationsByJob(client, orgId, jobNumber);
  const target = allocations.find((entry) => asTrimmedString(entry.allocationId) === allocationId);
  if (!target) {
    throw new HttpError(404, `Allocation ${allocationId} was not found for job ${jobNumber}.`);
  }

  if (target.status === "CANCELLED") {
    warnings.push(`Allocation ${allocationId} was already cancelled for job ${jobNumber}.`);
    return ok({
      jobNumber,
      allocationId: target.allocationId,
      boxId: target.boxId,
      removedAllocationCount: 0,
      releasedFeet: 0,
    }, warnings);
  }

  const box = await findBoxById(client, orgId, target.boxId);
  if (
    box &&
    box.status === "CHECKED_OUT" &&
    normalizeJobNumberKey(box.lastCheckoutJob) === normalizedJobNumber
  ) {
    throw new HttpError(
      400,
      `Box ${target.boxId} is checked out on job ${jobNumber} and cannot be removed until the box is checked in.`,
    );
  }

  const note = asTrimmedString(payload.reason) ||
    `Removed allocation ${target.allocationId} for box ${target.boxId} from job ${jobNumber} on allocation detail page.`;
  const releasedFeet =
    target.status === "ACTIVE" || target.status === "FULFILLED" ? integerOrZero(target.allocatedFeet) : 0;
  const nowIso = new Date().toISOString();

  const { error: updateAllocationError } = await serviceClient
    .schema("app")
    .from("allocations")
    .update({
      status: "CANCELLED",
      resolved_at: nowIso,
      resolved_by: actor,
      notes: note,
    })
    .eq("org_id", orgId)
    .eq("id", target.id);
  throwOnSupabaseError(updateAllocationError, `Unable to remove allocation ${target.allocationId}`);

  if (releasedFeet > 0 && box && box.status !== "ZEROED" && box.status !== "RETIRED") {
    const nextFeetAvailable = Math.max(0, integerOrZero(box.feetAvailable) + releasedFeet);
    const { error: updateBoxError } = await serviceClient
      .schema("app")
      .from("boxes")
      .update({
        feet_available: nextFeetAvailable,
      })
      .eq("org_id", orgId)
      .eq("id", box.id);
    throwOnSupabaseError(updateBoxError, `Unable to update box ${target.boxId}`);
  }

  const filmOrderId = asTrimmedString(target.filmOrderId);
  if (filmOrderId) {
    await recalculateFilmOrderAfterAllocationMutation(client, serviceClient, orgId, filmOrderId, actor);
  }

  warnings.push(
    `Removed allocation ${target.allocationId} for box ${target.boxId} on job ${jobNumber}. Released ${releasedFeet} LF back to box availability.`,
  );

  return ok({
    jobNumber,
    allocationId: target.allocationId,
    boxId: target.boxId,
    removedAllocationCount: 1,
    releasedFeet,
  }, warnings);
}

async function reopenJob(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  if (identity.role !== "owner") {
    throw new HttpError(403, "Owner access is required to reopen jobs.");
  }

  const warnings: string[] = [];
  const orgId = identity.orgId;
  const actor = identity.actor;
  const jobNumber = requireString(payload.jobNumber, "JobNumber");
  const serviceClient = requireServiceRoleClientForJobs();

  const { data: jobRow, error: jobError } = await serviceClient
    .schema("app")
    .from("jobs")
    .select("id, lifecycle_status")
    .eq("org_id", orgId)
    .eq("job_number", jobNumber)
    .maybeSingle();
  throwOnSupabaseError(jobError, "Unable to load job");
  if (!jobRow) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const lifecycleStatus = normalizeJobLifecycleStatus((jobRow as Record<string, unknown>).lifecycle_status);
  if (lifecycleStatus !== "COMPLETED" && lifecycleStatus !== "CANCELLED") {
    throw new HttpError(400, `Job ${jobNumber} is already active.`);
  }

  const { error: reopenError } = await serviceClient
    .schema("app")
    .from("jobs")
    .update({
      lifecycle_status: "ACTIVE",
      updated_at: new Date().toISOString(),
      updated_by: actor,
    })
    .eq("org_id", orgId)
    .eq("id", (jobRow as Record<string, unknown>).id);
  throwOnSupabaseError(reopenError, "Unable to reopen job");

  warnings.push(`Reopened job ${jobNumber}. Previously cancelled allocations and film orders remain cancelled.`);
  return ok(await buildJobDetail(client, orgId, jobNumber), warnings);
}

async function callMutationRpc(client: any, fn: string, orgId: string, actor: string, payload: Record<string, unknown>) {
  return await rpcOrThrow<any>(client, fn, {
    p_org_id: orgId,
    p_actor: actor,
    p_payload: payload,
  });
}

async function dispatchRead(client: any, orgId: string, logicalPath: string, params: Record<string, unknown>) {
  switch (logicalPath) {
    case "/admin/access/requests": {
      const status = asTrimmedString(params.status);
      const entries = await rpcOrThrow<any[]>(client, "api_list_access_requests", {
        p_org_id: orgId,
        p_status: status,
      });
      return ok({ entries: Array.isArray(entries) ? entries : [] });
    }
    case "/admin/username-requests": {
      const status = asTrimmedString(params.status);
      const entries = await rpcOrThrow<any[]>(client, "api_list_username_change_requests", {
        p_org_id: orgId,
        p_status: status,
      });
      return ok({ entries: Array.isArray(entries) ? entries : [] });
    }
    case "/admin/member-permissions": {
      const permissions = await rpcOrThrow<Record<string, unknown>>(client, "api_get_member_feature_permissions", {
        p_org_id: orgId,
      });
      return ok({ permissions });
    }
    case "/admin/user-permissions": {
      const permissions = await rpcOrThrow<Record<string, unknown>>(client, "api_get_user_feature_permissions", {
        p_org_id: orgId,
        p_user_id: requireString(params.userId, "userId"),
      });
      return ok({ permissions });
    }
    case "/owner/admin-permissions": {
      const entriesRaw = await rpcOrThrow<any[]>(client, "api_get_admin_feature_permissions", {
        p_org_id: orgId,
      });
      const entries = await enrichAdminPermissionEntries(Array.isArray(entriesRaw) ? entriesRaw : []);
      return ok({ entries });
    }
    case "/owner/notification-preferences": {
      const preferences = await rpcOrThrow<Record<string, unknown>>(client, "api_get_owner_notification_preferences", {
        p_org_id: orgId,
      });
      return ok(preferences);
    }
    case "/warehouses/list": {
      const entries = await rpcOrThrow<any[]>(client, "api_acl_list_warehouses", {
        p_org_id: orgId,
      });
      return ok({
        entries: (entries || []).map((entry) => ({
          code: asTrimmedString(entry.code).toUpperCase(),
          name: asTrimmedString(entry.name),
          boxIdPrefix: asTrimmedString(entry.box_id_prefix).toUpperCase(),
        })),
      });
    }
    case "/boxes/search":
      return ok(await buildSearchBoxes(client, orgId, params));
    case "/boxes/get": {
      const found = await findBoxById(client, orgId, requireString(params.boxId, "boxId"));
      if (!found) {
        throw new HttpError(404, "Box not found.");
      }
      return ok(toPublicBox(found));
    }
    case "/audit/list":
      return ok({ entries: await listAudit(client, orgId, params) });
    case "/audit/by-box":
      return ok({ entries: await listAuditEntriesByBox(client, orgId, requireString(params.boxId, "boxId")) });
    case "/allocations/by-box":
      return ok({
        entries: (await listAllocationsByBox(client, orgId, requireString(params.boxId, "boxId"))).map(toPublicAllocation),
      });
    case "/allocations/jobs":
      return ok({ entries: await buildAllocationJobList(client, orgId) });
    case "/allocations/by-job":
      return ok(await buildAllocationJobDetail(client, orgId, params.jobNumber));
    case "/allocations/preview": {
      const source = await findBoxById(client, orgId, requireString(params.boxId, "BoxID"));
      if (!source) {
        throw new HttpError(404, "Box not found.");
      }
      if (source.status !== "IN_STOCK") {
        throw new HttpError(400, "Only in-stock boxes can be allocated.");
      }
      return ok(buildAllocationPreviewPlan(
        source,
        params.requestedFeet,
        await resolveJobContext(client, orgId, params.jobNumber, params.jobDate, params.crewLeader),
        {
          crossWarehouse: parseCrossWarehouseFlag(params.crossWarehouse),
          minimumWidthIn: params.requestedWidthIn,
          allBoxes: await listBoxes(client, orgId),
          activeAllocationsByBox: buildActiveAllocationsByBoxIndex(await listActiveAllocations(client, orgId)),
        },
      ));
    }
    case "/jobs/list": {
      const limitValue = Number(params.limit);
      const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.floor(limitValue) : 25;
      return ok({ entries: await buildJobsList(client, orgId, limit) });
    }
    case "/jobs/search": {
      const limitValue = Number(params.limit);
      const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.floor(limitValue) : 25;
      return ok({ entries: await buildJobsSearchResults(client, orgId, params.query, limit) });
    }
    case "/jobs/get":
      return ok(await buildJobDetail(client, orgId, params.jobNumber));
    case "/film-orders/list":
      return ok({ entries: await buildFilmOrdersList(client, orgId) });
    case "/film-data/catalog":
      return ok({ entries: await buildFilmCatalog(client, orgId) });
    case "/roll-history/by-box":
      return ok({ entries: await listRollHistoryByBox(client, orgId, requireString(params.boxId, "boxId")) });
    case "/reports/summary":
      return ok(await buildReportsSummary(client, orgId, params));
    default:
      throw new HttpError(404, `Route not found: ${logicalPath || "/"}`);
  }
}

async function dispatchMutation(
  client: any,
  identity: AuthIdentity,
  logicalPath: string,
  payload: Record<string, unknown>,
) {
  const orgId = identity.orgId;
  const actor = identity.actor;
  switch (logicalPath) {
    case "/profile/username": {
      const result = await callMutationRpc(client, "api_request_username_change", orgId, actor, payload);
      return ok(result);
    }
    case "/admin/access/requests/approve": {
      const result = await callMutationRpc(client, "api_approve_access_request", orgId, actor, payload);
      return ok(result);
    }
    case "/admin/access/requests/deny": {
      const result = await callMutationRpc(client, "api_deny_access_request", orgId, actor, payload);
      return ok(result);
    }
    case "/admin/username-requests/approve": {
      const result = await callMutationRpc(client, "api_approve_username_change_request", orgId, actor, payload);
      return ok(result);
    }
    case "/admin/username-requests/deny": {
      const result = await callMutationRpc(client, "api_deny_username_change_request", orgId, actor, payload);
      return ok(result);
    }
    case "/admin/member-permissions": {
      const permissions = await callMutationRpc(client, "api_update_member_feature_permissions", orgId, actor, payload);
      return ok({ permissions });
    }
    case "/admin/user-permissions": {
      const permissions = await callMutationRpc(client, "api_update_user_feature_permissions", orgId, actor, payload);
      return ok({ permissions });
    }
    case "/owner/admin-permissions": {
      const permissions = await callMutationRpc(client, "api_update_admin_feature_permissions", orgId, actor, payload);
      return ok({ permissions });
    }
    case "/admin/roles/promote-member-to-admin": {
      const result = await callMutationRpc(client, "api_promote_member_to_admin", orgId, actor, payload);
      return ok(result);
    }
    case "/owner/roles/demote-admin-to-member": {
      const result = await callMutationRpc(client, "api_demote_admin_to_member", orgId, actor, payload);
      return ok(result);
    }
    case "/owner/roles/promote-admin-to-owner": {
      const result = await callMutationRpc(client, "api_promote_admin_to_owner", orgId, actor, payload);
      return ok(result);
    }
    case "/owner/notification-preferences": {
      const result = await callMutationRpc(client, "api_update_owner_notification_preferences", orgId, actor, payload);
      return ok(result);
    }
    case "/owner/warehouses/add": {
      const result = await callMutationRpc(client, "api_acl_add_warehouse", orgId, actor, payload);
      return ok(result);
    }
    case "/boxes/add": {
      const result = await callMutationRpc(client, "api_acl_boxes_add", orgId, actor, payload);
      const box = await findBoxById(client, orgId, asTrimmedString(result.boxId));
      if (!box) {
        throw new HttpError(500, "Box mutation completed but the updated box could not be reloaded.");
      }
      return ok({ box: toPublicBox(box), logId: asTrimmedString(result.logId) }, result.warnings || []);
    }
    case "/boxes/update": {
      const result = await callMutationRpc(client, "api_acl_boxes_update", orgId, actor, payload);
      const box = await findBoxById(client, orgId, asTrimmedString(result.boxId));
      if (!box) {
        throw new HttpError(500, "Box mutation completed but the updated box could not be reloaded.");
      }
      return ok({ box: toPublicBox(box), logId: asTrimmedString(result.logId) }, result.warnings || []);
    }
    case "/boxes/set-status": {
      const result = await callMutationRpc(client, "api_acl_boxes_set_status", orgId, actor, payload);
      const box = await findBoxById(client, orgId, asTrimmedString(result.boxId));
      if (!box) {
        throw new HttpError(500, "Box mutation completed but the updated box could not be reloaded.");
      }
      return ok({ box: toPublicBox(box), logId: asTrimmedString(result.logId) }, result.warnings || []);
    }
    case "/boxes/delete": {
      const result = await callMutationRpc(client, "api_acl_boxes_delete", orgId, actor, payload);
      return ok(
        {
          boxId: asTrimmedString(result.boxId),
          logId: asTrimmedString(result.logId),
        },
        result.warnings || [],
      );
    }
    case "/allocations/add":
    case "/allocations/apply": {
      const jobNumber = requireString(payload.jobNumber, "JobNumber");
      const existingJob = await findJobByNumber(client, orgId, jobNumber);
      if (existingJob && normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== "ACTIVE") {
        throw new HttpError(400, `Job ${jobNumber} is closed and cannot receive allocations.`);
      }

      const result = await callMutationRpc(client, "api_acl_allocations_apply", orgId, actor, payload);
      const allocationIds = Array.isArray(result.allocationIds)
        ? result.allocationIds.map((value: unknown) => asTrimmedString(value)).filter(Boolean)
        : [];
      const allocations = allocationIds.length
        ? (await listAllocationsByIds(client, orgId, allocationIds)).map(toPublicAllocation)
        : [];
      const filmOrderId = asTrimmedString(result.filmOrderId);
      let filmOrder = null;
      if (filmOrderId) {
        const found = await findFilmOrderById(client, orgId, filmOrderId);
        if (found) {
          filmOrder = toPublicFilmOrder(found, await buildPublicFilmOrderLinkedBoxes(client, orgId, filmOrderId));
        }
      }
      return ok({
        allocations,
        filmOrder,
        remainingUncoveredFeet: integerOrZero(result.remainingUncoveredFeet),
      }, result.warnings || []);
    }
    case "/allocations/remove-box":
      return removeJobBoxAllocation(client, identity, payload);
    case "/jobs/create": {
      const result = await callMutationRpc(client, "api_acl_jobs_create", orgId, actor, payload);
      return ok(await buildJobDetail(client, orgId, result.jobNumber), result.warnings || []);
    }
    case "/jobs/update": {
      const jobNumber = requireString(payload.jobNumber, "JobNumber");
      if (
        payload.lifecycleStatus !== undefined &&
        normalizeJobLifecycleStatus(payload.lifecycleStatus) !== "ACTIVE"
      ) {
        throw new HttpError(400, `Closed lifecycle changes are not allowed here. Use complete/reopen actions for job ${jobNumber}.`);
      }
      const existingJob = await findJobByNumber(client, orgId, jobNumber);
      if (existingJob && normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== "ACTIVE") {
        throw new HttpError(400, `Job ${jobNumber} is closed. Reopen it before editing.`);
      }

      const result = await callMutationRpc(client, "api_acl_jobs_update", orgId, actor, payload);
      return ok(await buildJobDetail(client, orgId, result.jobNumber), result.warnings || []);
    }
    case "/jobs/complete":
      return completeJob(client, identity, payload);
    case "/jobs/reopen":
      return reopenJob(client, identity, payload);
    case "/film-orders/create": {
      const jobNumber = requireString(payload.jobNumber, "JobNumber");
      const existingJob = await findJobByNumber(client, orgId, jobNumber);
      if (existingJob && normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== "ACTIVE") {
        throw new HttpError(400, `Job ${jobNumber} is closed and cannot receive film orders.`);
      }

      const result = await callMutationRpc(client, "api_acl_film_orders_create", orgId, actor, payload);
      const filmOrder = await findFilmOrderById(client, orgId, result.filmOrderId);
      if (!filmOrder) {
        throw new HttpError(500, "Film order was created but could not be reloaded.");
      }
      return ok(
        toPublicFilmOrder(filmOrder, await buildPublicFilmOrderLinkedBoxes(client, orgId, filmOrder.filmOrderId)),
        result.warnings || [],
      );
    }
    case "/film-orders/cancel": {
      const result = await callMutationRpc(client, "api_acl_film_orders_cancel", orgId, actor, payload);
      return ok({ jobNumber: asTrimmedString(result.jobNumber) }, result.warnings || []);
    }
    case "/film-orders/delete": {
      const result = await callMutationRpc(client, "api_acl_film_orders_delete", orgId, actor, payload);
      return ok(result.filmOrder || null, result.warnings || []);
    }
    case "/audit/undo": {
      const result = await callMutationRpc(client, "api_acl_audit_undo", orgId, actor, payload);
      const boxId = asTrimmedString(result.boxId);
      const box = result.boxDeleted || !boxId ? null : await findBoxById(client, orgId, boxId);
      return ok({ box: box ? toPublicBox(box) : null, logId: asTrimmedString(result.logId) }, result.warnings || []);
    }
    default:
      throw new HttpError(404, `Route not found: ${logicalPath || "/"}`);
  }
}

export async function handleApiRequest(request: Request, canonicalName = "api"): Promise<Response> {
  const corsHeaders = buildCorsHeaders(request);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse(request, 405, {
      ok: false,
      error: `Unsupported method: ${request.method}`,
    });
  }

  const requestUrl = new URL(request.url);
  const requestBody = request.method === "POST" ? await request.text() : "";
  const bodyJson = request.method === "POST" ? parseBodyJson(requestBody) : null;
  const logicalPath = resolveLogicalPath(requestUrl, bodyJson, canonicalName);

  if (logicalPath === "/health" || requestUrl.pathname.endsWith("/health")) {
    return jsonResponse(request, 200, {
      ok: true,
      data: {
        status: "ok",
        mode: "supabase",
        timestamp: new Date().toISOString(),
        sheets: [],
      },
      warnings: [],
    });
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return jsonResponse(request, 500, {
      ok: false,
      error: "SUPABASE_URL and SUPABASE_ANON_KEY must be configured for the Edge API.",
    });
  }

  const useCache = shouldUseCache(request.method, logicalPath);
  const authorization = request.headers.get("authorization") || "";
  const authKey = await sha1Hex(authorization);
  const cacheRouteKey = request.method === "POST" ? `${logicalPath}|${requestUrl.search}` : requestUrl.toString();
  const cacheKey = request.method === "POST"
    ? `${request.method}|${cacheRouteKey}|${await sha1Hex(requestBody)}|${authKey}`
    : `${request.method}|${cacheRouteKey}|${authKey}`;

  if (useCache) {
    pruneCache();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      const headers = buildCorsHeaders(request);
      headers.set("Content-Type", cached.contentType);
      return new Response(cached.body, { status: cached.status, headers });
    }
  }

  try {
    const { identity, client } = await resolveAuthContext(request);
    if (logicalPath === "/auth/context") {
      const payload = ok({
        orgId: identity.orgId,
        accessStatus: identity.accessStatus,
        role: identity.role,
        permissions: identity.permissions,
        isAdminConsoleAllowed: identity.isAdminConsoleAllowed,
        pendingCount: identity.pendingCount,
        receivesInAppNotifications: identity.receivesInAppNotifications,
      });
      const responseBody = JSON.stringify(payload);
      const headers = buildCorsHeaders(request);
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(responseBody, { status: 200, headers });
    }

    if (identity.accessStatus !== "approved" && logicalPath !== "/profile/username") {
      throw new HttpError(
        403,
        identity.accessStatus === "denied"
          ? "Your access request was denied. Contact an owner for help."
          : "Your account is awaiting approval from an admin or owner.",
      );
    }

    const params = routeParams(request.method, requestUrl, bodyJson);
    const payload = (request.method === "GET" || (request.method === "POST" && READ_PATHS.has(logicalPath)))
      ? await dispatchRead(client, identity.orgId, logicalPath, params)
      : await dispatchMutation(client, identity, logicalPath, params);

    const responseBody = JSON.stringify(payload);
    if (useCache) {
      cache.set(cacheKey, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: responseBody,
      });
    }
    if (isMutation(request.method, logicalPath)) {
      cache.clear();
      authIdentityCache.clear();
    }

    const headers = buildCorsHeaders(request);
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(responseBody, { status: 200, headers });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(request, error.statusCode, {
        ok: false,
        error: error.message,
        warnings: error.warnings || [],
      });
    }
    return jsonResponse(request, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unexpected server error.",
      warnings: [],
    });
  }
}

