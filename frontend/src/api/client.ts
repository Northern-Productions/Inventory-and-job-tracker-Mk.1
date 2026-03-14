import type {
  AllocationEntry,
  AllocationJobDetail,
  AllocationJobDetailResponse,
  AllocationJobListResponse,
  AllocationJobSummary,
  CreateJobPayload,
  AllocationListResponse,
  AllocationPreview,
  AllocateBoxPayload,
  ApplyAllocationPlanPayload,
  ApplyAllocationPlanResult,
  RemoveJobBoxAllocationsPayload,
  RemoveJobBoxAllocationsResult,
  AddBoxPayload,
  AddWarehousePayload,
  AuditEntry,
  AuditListParams,
  AuditListResponse,
  Box,
  BoxHistoryResponse,
  BoxMutationResult,
  CreateFilmOrderPayload,
  FilmOrderEntry,
  FilmCatalogEntry,
  FilmCatalogResponse,
  FilmOrderListResponse,
  HealthResponse,
  JobDetail,
  JobDetailResponse,
  JobListEntry,
  JobListResponse,
  DeleteBoxPayload,
  DeleteBoxResult,
  AccessRequestEntry,
  AccessStatus,
  AdminPermissionEntry,
  FeatureAccessMap,
  FeatureArea,
  FeatureAccessMode,
  EffectiveAccessContext,
  OwnerNotificationPreferences,
  Role,
  ReportsSummary,
  ReportsSummaryFilters,
  RollHistoryResponse,
  RollHistoryEntry,
  SearchBoxesParams,
  SetBoxStatusPayload,
  UndoAuditPayload,
  UndoMutationResult,
  UpdateJobPayload,
  UpdateBoxPayload,
  WarehouseEntry,
  UsernameChangeRequestEntry,
  UsernameChangeResult,
  Warehouse
} from '../domain';
import { WAREHOUSE_CODES, createDefaultFeatureAccessMap } from '../domain';
import {
  getOfflineBox,
  replaceOfflineInventoryBoxes,
  searchOfflineBoxes,
  type OfflineInventorySyncMeta
} from '../lib/offlineInventory';
import { rankActiveJobsByNumericCloseness } from '../lib/jobNumberSearch';
import { APIError, request } from './http';

type JobsApiAvailability = 'unknown' | 'available' | 'missing';
let jobsApiAvailability: JobsApiAvailability = 'unknown';
type JobsSearchApiAvailability = 'unknown' | 'available' | 'missing';
let jobsSearchApiAvailability: JobsSearchApiAvailability = 'unknown';
let cachedAccessContext: EffectiveAccessContext | null = null;

export function __resetJobsApiAvailabilityForTests() {
  jobsApiAvailability = 'unknown';
  jobsSearchApiAvailability = 'unknown';
  cachedAccessContext = null;
}

export function setClientAccessContext(context: EffectiveAccessContext | null) {
  cachedAccessContext = context;
}

function ensureRole(value: unknown): Role {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'owner' || normalized === 'admin' || normalized === 'member') {
    return normalized;
  }
  return '';
}

function ensureAccessStatus(value: unknown): AccessStatus {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'approved' || normalized === 'pending' || normalized === 'denied') {
    return normalized;
  }
  return 'pending';
}

function mapFeaturePermissions(value: unknown): FeatureAccessMap {
  const defaults = createDefaultFeatureAccessMap();
  if (!value || typeof value !== 'object') {
    return defaults;
  }

  const source = value as Record<string, unknown>;
  (Object.keys(defaults) as FeatureArea[]).forEach((feature) => {
    const entry = source[feature];
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const next = entry as Record<string, unknown>;
    defaults[feature] = {
      read: next.read === true || String(next.read).toLowerCase() === 'true',
      write: next.write === true || String(next.write).toLowerCase() === 'true'
    };
  });

  return defaults;
}

function mapAdminPermissionEntry(value: unknown): AdminPermissionEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const userId = String(source.userId || '').trim();
  if (!userId) {
    return null;
  }

  return {
    userId,
    name: String(source.name || '').trim(),
    email: String(source.email || '').trim(),
    role: 'admin',
    permissions: mapFeaturePermissions(source.permissions)
  };
}

function mapAccessRequestEntry(value: unknown): AccessRequestEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const userId = String(source.userId || '').trim();
  if (!userId) {
    return null;
  }

  const status = String(source.status || '').trim().toLowerCase();

  return {
    userId,
    name: String(source.name || '').trim(),
    email: String(source.email || '').trim(),
    status: status === 'approved' || status === 'denied' ? status : 'pending',
    requestedAt: String(source.requestedAt || '').trim(),
    decidedAt: String(source.decidedAt || '').trim(),
    decidedByActor: String(source.decidedByActor || '').trim(),
    decisionNote: String(source.decisionNote || '').trim(),
    currentRole: ensureRole(source.currentRole)
  };
}

function mapUsernameChangeRequestEntry(value: unknown): UsernameChangeRequestEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const userId = String(source.userId || '').trim();
  if (!userId) {
    return null;
  }

  const status = String(source.status || '').trim().toLowerCase();

  return {
    userId,
    email: String(source.email || '').trim(),
    currentName: String(source.currentName || '').trim(),
    requestedName: String(source.requestedName || '').trim(),
    status: status === 'approved' || status === 'denied' ? status : 'pending',
    requestedAt: String(source.requestedAt || '').trim(),
    decidedAt: String(source.decidedAt || '').trim(),
    decidedByActor: String(source.decidedByActor || '').trim(),
    decisionNote: String(source.decisionNote || '').trim(),
    currentRole: ensureRole(source.currentRole)
  };
}

function mapWarehouseEntry(value: unknown): WarehouseEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const code = String(source.code || '').trim().toUpperCase();
  if (!code) {
    return null;
  }

  return {
    code,
    name: String(source.name || '').trim() || code,
    boxIdPrefix: String(source.boxIdPrefix || '').trim().toUpperCase()
  };
}

function assertFeatureAccess(feature: FeatureArea, mode: FeatureAccessMode) {
  const context = cachedAccessContext;
  if (!context || context.accessStatus !== 'approved') {
    return;
  }

  if (context.role === 'owner') {
    return;
  }

  const allowed = context.permissions[feature]?.[mode];
  if (!allowed) {
    throw new APIError('You do not have permission to perform this action.');
  }
}

export async function getHealth(): Promise<HealthResponse> {
  const { data } = await request<HealthResponse>('GET', '/health');
  return data;
}

export async function getAuthContext(): Promise<EffectiveAccessContext> {
  const { data } = await request<{
    orgId: string;
    accessStatus: AccessStatus;
    role: Role;
    permissions: unknown;
    isAdminConsoleAllowed: unknown;
    pendingCount: unknown;
    receivesInAppNotifications: unknown;
  }>('GET', '/auth/context');

  const context: EffectiveAccessContext = {
    orgId: String(data.orgId || '').trim(),
    accessStatus: ensureAccessStatus(data.accessStatus),
    role: ensureRole(data.role),
    permissions: mapFeaturePermissions(data.permissions),
    isAdminConsoleAllowed:
      data.isAdminConsoleAllowed === true ||
      String(data.isAdminConsoleAllowed).toLowerCase() === 'true',
    pendingCount: Number(data.pendingCount || 0) || 0,
    receivesInAppNotifications:
      data.receivesInAppNotifications === true ||
      String(data.receivesInAppNotifications).toLowerCase() === 'true'
  };

  return context;
}

export async function listAccessRequests(
  status: '' | 'pending' | 'approved' | 'denied' = ''
): Promise<AccessRequestEntry[]> {
  assertFeatureAccess('access_management', 'read');
  const body = status ? { status } : {};
  const query = status ? { status } : {};
  const data = await requestReadWithFallback<{ entries: unknown[] }>(
    '/admin/access/requests',
    body,
    query
  );
  if (!Array.isArray(data.entries)) {
    return [];
  }

  return data.entries
    .map((entry) => mapAccessRequestEntry(entry))
    .filter((entry): entry is AccessRequestEntry => Boolean(entry));
}

export async function approveAccessRequest(payload: {
  userId: string;
  note?: string;
}): Promise<{ userId: string; status: 'approved'; role: Role }> {
  assertFeatureAccess('access_management', 'write');
  const { data } = await request<{ userId: string; status: 'approved'; role: Role }>(
    'POST',
    '/admin/access/requests/approve',
    { body: payload }
  );
  return data;
}

export async function denyAccessRequest(payload: {
  userId: string;
  note?: string;
}): Promise<{ userId: string; status: 'denied' }> {
  assertFeatureAccess('access_management', 'write');
  const { data } = await request<{ userId: string; status: 'denied' }>(
    'POST',
    '/admin/access/requests/deny',
    { body: payload }
  );
  return data;
}

export async function requestUsernameChange(payload: { username: string }): Promise<UsernameChangeResult> {
  const { data } = await request<UsernameChangeResult>('POST', '/profile/username', { body: payload });
  return {
    status: data.status === 'approved' ? 'approved' : 'pending',
    requiresApproval: Boolean(data.requiresApproval),
    username: String(data.username || '').trim()
  };
}

export async function listUsernameChangeRequests(
  status: '' | 'pending' | 'approved' | 'denied' = ''
): Promise<UsernameChangeRequestEntry[]> {
  assertFeatureAccess('access_management', 'read');
  const body = status ? { status } : {};
  const query = status ? { status } : {};
  const data = await requestReadWithFallback<{ entries: unknown[] }>(
    '/admin/username-requests',
    body,
    query
  );
  if (!Array.isArray(data.entries)) {
    return [];
  }

  return data.entries
    .map((entry) => mapUsernameChangeRequestEntry(entry))
    .filter((entry): entry is UsernameChangeRequestEntry => Boolean(entry));
}

export async function approveUsernameChangeRequest(payload: {
  userId: string;
  note?: string;
}): Promise<{ userId: string; status: 'approved'; username: string }> {
  assertFeatureAccess('access_management', 'write');
  const { data } = await request<{ userId: string; status: 'approved'; username: string }>(
    'POST',
    '/admin/username-requests/approve',
    { body: payload }
  );
  return data;
}

export async function denyUsernameChangeRequest(payload: {
  userId: string;
  note?: string;
}): Promise<{ userId: string; status: 'denied' }> {
  assertFeatureAccess('access_management', 'write');
  const { data } = await request<{ userId: string; status: 'denied' }>(
    'POST',
    '/admin/username-requests/deny',
    { body: payload }
  );
  return data;
}

export async function getMemberFeaturePermissions(): Promise<FeatureAccessMap> {
  assertFeatureAccess('access_management', 'read');
  const data = await requestReadWithFallback<FeatureAccessMap>(
    '/admin/member-permissions',
    {},
    {}
  );
  return mapFeaturePermissions(data);
}

export async function updateMemberFeaturePermissions(payload: {
  permissions: Partial<FeatureAccessMap>;
}): Promise<FeatureAccessMap> {
  assertFeatureAccess('access_management', 'write');
  const { data } = await request<{ permissions: FeatureAccessMap }>(
    'POST',
    '/admin/member-permissions',
    { body: payload }
  );
  return mapFeaturePermissions(data.permissions);
}

export async function getUserFeaturePermissions(userId: string): Promise<FeatureAccessMap> {
  assertFeatureAccess('access_management', 'read');
  const normalizedUserId = String(userId || '').trim();
  const data = await requestReadWithFallback<{ permissions: unknown }>(
    '/admin/user-permissions',
    { userId: normalizedUserId },
    { userId: normalizedUserId }
  );
  return mapFeaturePermissions(data.permissions);
}

export async function updateUserFeaturePermissions(payload: {
  userId: string;
  permissions: Partial<FeatureAccessMap>;
}): Promise<FeatureAccessMap> {
  assertFeatureAccess('access_management', 'write');
  const { data } = await request<{ permissions: unknown }>(
    'POST',
    '/admin/user-permissions',
    { body: payload }
  );
  return mapFeaturePermissions(data.permissions);
}

export async function getAdminFeaturePermissions(): Promise<AdminPermissionEntry[]> {
  const data = await requestReadWithFallback<{ entries: unknown[] }>(
    '/owner/admin-permissions',
    {},
    {}
  );
  if (!Array.isArray(data.entries)) {
    return [];
  }

  return data.entries
    .map((entry) => mapAdminPermissionEntry(entry))
    .filter((entry): entry is AdminPermissionEntry => Boolean(entry));
}

export async function updateAdminFeaturePermissions(payload: {
  userId: string;
  permissions: Partial<FeatureAccessMap>;
}): Promise<FeatureAccessMap> {
  const { data } = await request<{ permissions: FeatureAccessMap }>(
    'POST',
    '/owner/admin-permissions',
    { body: payload }
  );
  return mapFeaturePermissions(data.permissions);
}

export async function promoteMemberToAdmin(payload: {
  userId: string;
}): Promise<{ userId: string; role: 'admin' }> {
  assertFeatureAccess('access_management', 'write');
  const { data } = await request<{ userId: string; role: 'admin' }>(
    'POST',
    '/admin/roles/promote-member-to-admin',
    { body: payload }
  );
  return data;
}

export async function demoteAdminToMember(payload: {
  userId: string;
}): Promise<{ userId: string; role: 'member' }> {
  const { data } = await request<{ userId: string; role: 'member' }>(
    'POST',
    '/owner/roles/demote-admin-to-member',
    { body: payload }
  );
  return data;
}

export async function promoteAdminToOwner(payload: {
  userId: string;
}): Promise<{ userId: string; role: 'owner' }> {
  const { data } = await request<{ userId: string; role: 'owner' }>(
    'POST',
    '/owner/roles/promote-admin-to-owner',
    { body: payload }
  );
  return data;
}

export async function getOwnerNotificationPreferences(): Promise<OwnerNotificationPreferences> {
  const data = await requestReadWithFallback<OwnerNotificationPreferences>(
    '/owner/notification-preferences',
    {},
    {}
  );
  return {
    inAppOptIn: data.inAppOptIn === true || String(data.inAppOptIn).toLowerCase() === 'true',
    emailOptIn: data.emailOptIn === true || String(data.emailOptIn).toLowerCase() === 'true'
  };
}

export async function updateOwnerNotificationPreferences(payload: {
  inAppOptIn: boolean;
  emailOptIn: boolean;
}): Promise<OwnerNotificationPreferences> {
  const { data } = await request<OwnerNotificationPreferences>(
    'POST',
    '/owner/notification-preferences',
    { body: payload }
  );
  return {
    inAppOptIn: data.inAppOptIn === true || String(data.inAppOptIn).toLowerCase() === 'true',
    emailOptIn: data.emailOptIn === true || String(data.emailOptIn).toLowerCase() === 'true'
  };
}

export async function listWarehouses(): Promise<WarehouseEntry[]> {
  assertFeatureAccess('inventory', 'read');
  const data = await requestReadWithFallback<{ entries: unknown[] }>(
    '/warehouses/list',
    {},
    {}
  );
  return (data.entries || [])
    .map((entry) => mapWarehouseEntry(entry))
    .filter((entry): entry is WarehouseEntry => Boolean(entry));
}

export async function addWarehouse(payload: AddWarehousePayload): Promise<WarehouseEntry> {
  const { data } = await request<unknown>('POST', '/owner/warehouses/add', { body: payload });
  const mapped = mapWarehouseEntry(data);
  if (!mapped) {
    throw new APIError('The warehouse was created but the response was invalid.');
  }
  return mapped;
}

function buildSearchBoxFilters(params: SearchBoxesParams) {
  return {
    warehouse: params.warehouse,
    q: params.q,
    status: params.status,
    film: params.film,
    width: params.width,
    showRetired: params.showRetired ?? false
  };
}

function shouldUseOfflineInventoryFallback(error: unknown): error is APIError {
  return error instanceof APIError && error.message.indexOf('The API is unreachable.') === 0;
}

function isRouteNotFoundError(error: unknown, path: string): error is APIError {
  return error instanceof APIError && error.message === `Route not found: ${path}`;
}

function mapLegacyAllocationStatusToJobStatus(
  status: AllocationJobSummary['status']
): JobListEntry['status'] {
  if (status === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (status === 'COMPLETED') {
    return 'COMPLETED';
  }

  if (status === 'READY') {
    return 'READY';
  }

  return 'ALLOCATE';
}

function mapLegacyAllocationSummaryToJobListEntry(
  summary: AllocationJobSummary,
  warehouse: Warehouse = 'IL'
): JobListEntry {
  const allocatedFeet = Math.max(0, summary.activeAllocatedFeet + summary.fulfilledAllocatedFeet);
  const status = mapLegacyAllocationStatusToJobStatus(summary.status);

  return {
    jobNumber: summary.jobNumber,
    warehouse,
    sections: null,
    dueDate: summary.jobDate || '',
    crewLeader: summary.crewLeader || '',
    status,
    lifecycleStatus: status === 'CANCELLED' ? 'CANCELLED' : status === 'COMPLETED' ? 'COMPLETED' : 'ACTIVE',
    requiredFeet: allocatedFeet,
    allocatedFeet,
    remainingFeet: 0,
    requirementCount: 0,
    allocationCount: summary.boxCount,
    filmOrderCount: summary.openFilmOrderCount,
    updatedAt: '',
    notes: ''
  };
}

function mapLegacyAllocationDetailToJobDetail(detail: AllocationJobDetail): JobDetail {
  const fallbackWarehouse = detail.allocations[0]?.warehouse || detail.filmOrders[0]?.warehouse || 'IL';

  return {
    summary: mapLegacyAllocationSummaryToJobListEntry(detail.summary, fallbackWarehouse),
    requirements: [],
    allocations: detail.allocations,
    usage: [],
    filmOrders: detail.filmOrders
  };
}

function normalizeJobDetail(detail: JobDetail): JobDetail {
  return {
    ...detail,
    usage: detail.usage || []
  };
}

async function requestReadWithFallback<T>(
  path: string,
  body: Record<string, unknown>,
  query: Record<string, string | number | boolean | undefined>
): Promise<T> {
  try {
    const { data } = await request<T>('POST', path, { body });
    return data;
  } catch (error) {
    if (
      error instanceof APIError &&
      (error.message === `Route not found: ${path}` || error.message === 'Route not found: /')
    ) {
      const { data } = await request<T>('GET', path, { query });
      return data;
    }

    throw error;
  }
}

export async function searchBoxes(params: SearchBoxesParams): Promise<Box[]> {
  assertFeatureAccess('inventory', 'read');
  try {
    return await fetchRemoteBoxes(params);
  } catch (error) {
    if (shouldUseOfflineInventoryFallback(error)) {
      return searchOfflineBoxes(params);
    }

    throw error;
  }
}

export async function getBox(boxId: string): Promise<Box> {
  assertFeatureAccess('inventory', 'read');
  try {
    return await requestReadWithFallback<Box>(
      '/boxes/get',
      { boxId },
      { boxId }
    );
  } catch (error) {
    if (shouldUseOfflineInventoryFallback(error)) {
      const offlineBox = await getOfflineBox(boxId);

      if (offlineBox) {
        return offlineBox;
      }
    }

    throw error;
  }
}

export async function addBox(
  payload: AddBoxPayload
): Promise<{ result: BoxMutationResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<BoxMutationResult>('POST', '/boxes/add', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function getAllocationsByBox(boxId: string): Promise<AllocationEntry[]> {
  assertFeatureAccess('allocations', 'read');
  const data = await requestReadWithFallback<AllocationListResponse>(
    '/allocations/by-box',
    { boxId },
    { boxId }
  );

  return data.entries;
}

export async function getAllocationJobs(): Promise<AllocationJobSummary[]> {
  assertFeatureAccess('allocations', 'read');
  const data = await requestReadWithFallback<AllocationJobListResponse>('/allocations/jobs', {}, {});

  return data.entries;
}

export async function getAllocationJob(jobNumber: string): Promise<AllocationJobDetail> {
  assertFeatureAccess('allocations', 'read');
  const detail = await requestReadWithFallback<AllocationJobDetailResponse>(
    '/allocations/by-job',
    { jobNumber },
    { jobNumber }
  );
  return {
    ...detail,
    usage: detail.usage || []
  };
}

export async function getJobs(limit = 25): Promise<JobListEntry[]> {
  assertFeatureAccess('jobs', 'read');
  const params = { limit };

  if (jobsApiAvailability === 'missing') {
    const legacyData = await requestReadWithFallback<AllocationJobListResponse>(
      '/allocations/jobs',
      {},
      {}
    );
    return legacyData.entries.slice(0, limit).map((entry) => mapLegacyAllocationSummaryToJobListEntry(entry));
  }

  try {
    const data = await requestReadWithFallback<JobListResponse>('/jobs/list', params, params);
    jobsApiAvailability = 'available';
    return data.entries;
  } catch (error) {
    if (!isRouteNotFoundError(error, '/jobs/list')) {
      throw error;
    }

    jobsApiAvailability = 'missing';
    const legacyData = await requestReadWithFallback<AllocationJobListResponse>(
      '/allocations/jobs',
      {},
      {}
    );

    return legacyData.entries.slice(0, limit).map((entry) => mapLegacyAllocationSummaryToJobListEntry(entry));
  }
}

export async function searchJobsByNumber(query: string, limit = 25): Promise<JobListEntry[]> {
  assertFeatureAccess('jobs', 'read');
  const normalizedQuery = String(query || '').replace(/[^0-9]/g, '');
  if (!normalizedQuery) {
    return [];
  }

  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 25;
  const params = { query: normalizedQuery, limit: normalizedLimit };

  if (jobsSearchApiAvailability === 'missing') {
    return rankActiveJobsByNumericCloseness(await getJobs(normalizedLimit), normalizedQuery, normalizedLimit);
  }

  try {
    const data = await requestReadWithFallback<JobListResponse>('/jobs/search', params, params);
    jobsSearchApiAvailability = 'available';
    return data.entries;
  } catch (error) {
    if (!isRouteNotFoundError(error, '/jobs/search')) {
      throw error;
    }

    jobsSearchApiAvailability = 'missing';
    return rankActiveJobsByNumericCloseness(await getJobs(normalizedLimit), normalizedQuery, normalizedLimit);
  }
}

export async function getJob(jobNumber: string): Promise<JobDetail> {
  assertFeatureAccess('jobs', 'read');
  if (jobsApiAvailability === 'missing') {
    const legacyDetail = await requestReadWithFallback<AllocationJobDetailResponse>(
      '/allocations/by-job',
      { jobNumber },
      { jobNumber }
    );

    return mapLegacyAllocationDetailToJobDetail(legacyDetail);
  }

  try {
    const result = await requestReadWithFallback<JobDetailResponse>(
      '/jobs/get',
      { jobNumber },
      { jobNumber }
    );
    jobsApiAvailability = 'available';
    return normalizeJobDetail(result);
  } catch (error) {
    if (!isRouteNotFoundError(error, '/jobs/get')) {
      throw error;
    }

    jobsApiAvailability = 'missing';
    const legacyDetail = await requestReadWithFallback<AllocationJobDetailResponse>(
      '/allocations/by-job',
      { jobNumber },
      { jobNumber }
    );

    return mapLegacyAllocationDetailToJobDetail(legacyDetail);
  }
}

export async function createJob(
  payload: CreateJobPayload
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  if (jobsApiAvailability === 'missing') {
    throw new APIError(
      'Jobs backend is not deployed yet. Deploy the Supabase Edge API with /jobs/create and try again.'
    );
  }

  let response: Awaited<ReturnType<typeof request<JobDetail>>>;
  try {
    response = await request<JobDetail>('POST', '/jobs/create', {
      body: payload
    });
    jobsApiAvailability = 'available';
  } catch (error) {
    if (isRouteNotFoundError(error, '/jobs/create')) {
      jobsApiAvailability = 'missing';
      throw new APIError(
        'Jobs backend is not deployed yet. Deploy the Supabase Edge API with /jobs/create and try again.'
      );
    }

    throw error;
  }

  return {
    result: normalizeJobDetail(response.data),
    warnings: response.warnings
  };
}

export async function updateJob(
  payload: UpdateJobPayload
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  if (jobsApiAvailability === 'missing') {
    throw new APIError(
      'Jobs backend is not deployed yet. Deploy the Supabase Edge API with /jobs/update and try again.'
    );
  }

  let response: Awaited<ReturnType<typeof request<JobDetail>>>;
  try {
    response = await request<JobDetail>('POST', '/jobs/update', {
      body: payload
    });
    jobsApiAvailability = 'available';
  } catch (error) {
    if (isRouteNotFoundError(error, '/jobs/update')) {
      jobsApiAvailability = 'missing';
      throw new APIError(
        'Jobs backend is not deployed yet. Deploy the Supabase Edge API with /jobs/update and try again.'
      );
    }

    throw error;
  }

  return {
    result: normalizeJobDetail(response.data),
    warnings: response.warnings
  };
}

export async function completeJob(
  payload: { jobNumber: string; reason?: string }
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  if (jobsApiAvailability === 'missing') {
    throw new APIError(
      'Jobs backend is not deployed yet. Deploy the Supabase Edge API with /jobs/complete and try again.'
    );
  }

  let response: Awaited<ReturnType<typeof request<JobDetail>>>;
  try {
    response = await request<JobDetail>('POST', '/jobs/complete', {
      body: payload
    });
    jobsApiAvailability = 'available';
  } catch (error) {
    if (isRouteNotFoundError(error, '/jobs/complete')) {
      jobsApiAvailability = 'missing';
      throw new APIError(
        'Jobs backend is not deployed yet. Deploy the Supabase Edge API with /jobs/complete and try again.'
      );
    }

    throw error;
  }

  return {
    result: normalizeJobDetail(response.data),
    warnings: response.warnings
  };
}

export async function reopenJob(
  payload: { jobNumber: string; reason?: string }
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('jobs', 'write');
  if (jobsApiAvailability === 'missing') {
    throw new APIError(
      'Jobs backend is not deployed yet. Deploy the Supabase Edge API with /jobs/reopen and try again.'
    );
  }

  let response: Awaited<ReturnType<typeof request<JobDetail>>>;
  try {
    response = await request<JobDetail>('POST', '/jobs/reopen', {
      body: payload
    });
    jobsApiAvailability = 'available';
  } catch (error) {
    if (isRouteNotFoundError(error, '/jobs/reopen')) {
      jobsApiAvailability = 'missing';
      throw new APIError(
        'Jobs backend is not deployed yet. Deploy the Supabase Edge API with /jobs/reopen and try again.'
      );
    }

    throw error;
  }

  return {
    result: normalizeJobDetail(response.data),
    warnings: response.warnings
  };
}

export async function previewAllocationPlan(payload: AllocateBoxPayload): Promise<AllocationPreview> {
  assertFeatureAccess('allocations', 'read');
  const params = {
    boxId: payload.boxId,
    jobNumber: payload.jobNumber,
    jobDate: payload.jobDate,
    crewLeader: payload.crewLeader,
    requestedFeet: payload.requestedFeet,
    requestedWidthIn: payload.requestedWidthIn,
    crossWarehouse: payload.crossWarehouse
  };

  return requestReadWithFallback<AllocationPreview>('/allocations/preview', params, params);
}

export async function applyAllocationPlan(
  payload: ApplyAllocationPlanPayload
): Promise<{ result: ApplyAllocationPlanResult; warnings: string[] }> {
  assertFeatureAccess('allocations', 'write');
  const response = await request<ApplyAllocationPlanResult>('POST', '/allocations/apply', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function removeJobBoxAllocations(
  payload: RemoveJobBoxAllocationsPayload
): Promise<{ result: RemoveJobBoxAllocationsResult; warnings: string[] }> {
  assertFeatureAccess('allocations', 'write');
  const response = await request<RemoveJobBoxAllocationsResult>('POST', '/allocations/remove-box', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function getFilmOrders(): Promise<FilmOrderEntry[]> {
  assertFeatureAccess('film_orders', 'read');
  const data = await requestReadWithFallback<FilmOrderListResponse>('/film-orders/list', {}, {});

  return data.entries;
}

export async function getFilmCatalog(): Promise<FilmCatalogEntry[]> {
  assertFeatureAccess('inventory', 'read');
  const data = await requestReadWithFallback<FilmCatalogResponse>('/film-data/catalog', {}, {});

  return data.entries;
}

export async function createFilmOrder(
  payload: CreateFilmOrderPayload
): Promise<{ result: FilmOrderEntry; warnings: string[] }> {
  assertFeatureAccess('film_orders', 'write');
  const response = await request<FilmOrderEntry>('POST', '/film-orders/create', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function cancelJob(
  payload: { jobNumber: string; reason?: string }
): Promise<{ result: { jobNumber: string }; warnings: string[] }> {
  assertFeatureAccess('film_orders', 'write');
  const response = await request<{ jobNumber: string }>('POST', '/film-orders/cancel', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function deleteFilmOrder(
  payload: { filmOrderId: string; reason?: string }
): Promise<{ result: FilmOrderEntry; warnings: string[] }> {
  assertFeatureAccess('film_orders', 'write');
  const response = await request<FilmOrderEntry>('POST', '/film-orders/delete', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function allocateBox(
  payload: AllocateBoxPayload
): Promise<{ result: ApplyAllocationPlanResult; warnings: string[] }> {
  return applyAllocationPlan(payload);
}

export async function updateBox(
  payload: UpdateBoxPayload
): Promise<{ result: BoxMutationResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<BoxMutationResult>('POST', '/boxes/update', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function deleteBox(
  payload: DeleteBoxPayload
): Promise<{ result: DeleteBoxResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<DeleteBoxResult>('POST', '/boxes/delete', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function setBoxStatus(
  payload: SetBoxStatusPayload
): Promise<{ result: BoxMutationResult; warnings: string[] }> {
  assertFeatureAccess('inventory', 'write');
  const response = await request<BoxMutationResult>('POST', '/boxes/set-status', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function getAuditByBox(boxId: string): Promise<AuditEntry[]> {
  assertFeatureAccess('activity_history', 'read');
  const data = await requestReadWithFallback<BoxHistoryResponse>(
    '/audit/by-box',
    { boxId },
    { boxId }
  );

  return data.entries;
}

export async function listAudit(params: AuditListParams): Promise<AuditEntry[]> {
  assertFeatureAccess('activity_history', 'read');
  const filters = {
    from: params.from,
    to: params.to,
    user: params.user,
    action: params.action
  };
  const data = await requestReadWithFallback<AuditListResponse>('/audit/list', filters, filters);

  return data.entries;
}

export async function getRollHistoryByBox(boxId: string): Promise<RollHistoryEntry[]> {
  assertFeatureAccess('activity_history', 'read');
  const data = await requestReadWithFallback<RollHistoryResponse>(
    '/roll-history/by-box',
    { boxId },
    { boxId }
  );

  return data.entries;
}

export async function getReportsSummary(filters: ReportsSummaryFilters): Promise<ReportsSummary> {
  assertFeatureAccess('reports', 'read');
  const params = {
    warehouse: filters.warehouse,
    manufacturer: filters.manufacturer,
    film: filters.film,
    width: filters.width,
    from: filters.from,
    to: filters.to
  };

  const summary = await requestReadWithFallback<ReportsSummary>('/reports/summary', params, params);
  return {
    availableFeetByWidth: summary.availableFeetByWidth || [],
    neverCheckedOut: summary.neverCheckedOut || [],
    zeroedByMonth: summary.zeroedByMonth || [],
    completedJobs: summary.completedJobs || [],
    cancelledJobs: summary.cancelledJobs || []
  };
}

export async function undoAudit(
  payload: UndoAuditPayload
): Promise<{ result: UndoMutationResult; warnings: string[] }> {
  assertFeatureAccess('activity_history', 'write');
  const response = await request<UndoMutationResult>('POST', '/audit/undo', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function syncOfflineInventorySnapshot(
  warehouse: Warehouse
): Promise<OfflineInventorySyncMeta | null> {
  const boxes = await fetchRemoteBoxes({ warehouse, showRetired: true });
  return replaceOfflineInventoryBoxes(warehouse, boxes);
}

export async function syncAllOfflineInventorySnapshots(): Promise<OfflineInventorySyncMeta[]> {
  let warehouseCodes: Warehouse[] = [];
  try {
    warehouseCodes = (await listWarehouses()).map((entry) => entry.code);
  } catch {
    warehouseCodes = [...WAREHOUSE_CODES];
  }

  if (warehouseCodes.length === 0) {
    return [];
  }

  const snapshots = await Promise.all(
    warehouseCodes.map((warehouse) => syncOfflineInventorySnapshot(warehouse))
  );

  return snapshots.filter((snapshot): snapshot is OfflineInventorySyncMeta => Boolean(snapshot));
}

async function fetchRemoteBoxes(params: SearchBoxesParams): Promise<Box[]> {
  const filters = buildSearchBoxFilters(params);
  return requestReadWithFallback<Box[]>('/boxes/search', filters, filters);
}
