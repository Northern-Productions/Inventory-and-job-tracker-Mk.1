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
  AddBoxPayload,
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
  Warehouse
} from '../domain';
import {
  getOfflineBox,
  replaceOfflineInventoryBoxes,
  searchOfflineBoxes,
  type OfflineInventorySyncMeta
} from '../lib/offlineInventory';
import { APIError, request } from './http';

type JobsApiAvailability = 'unknown' | 'available' | 'missing';
let jobsApiAvailability: JobsApiAvailability = 'unknown';

export function __resetJobsApiAvailabilityForTests() {
  jobsApiAvailability = 'unknown';
}

export async function getHealth(): Promise<HealthResponse> {
  const { data } = await request<HealthResponse>('GET', '/health');
  return data;
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

  if (status === 'READY' || status === 'COMPLETED') {
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
    status,
    lifecycleStatus: status === 'CANCELLED' ? 'CANCELLED' : 'ACTIVE',
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
    filmOrders: detail.filmOrders
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
  const response = await request<BoxMutationResult>('POST', '/boxes/add', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function getAllocationsByBox(boxId: string): Promise<AllocationEntry[]> {
  const data = await requestReadWithFallback<AllocationListResponse>(
    '/allocations/by-box',
    { boxId },
    { boxId }
  );

  return data.entries;
}

export async function getAllocationJobs(): Promise<AllocationJobSummary[]> {
  const data = await requestReadWithFallback<AllocationJobListResponse>('/allocations/jobs', {}, {});

  return data.entries;
}

export async function getAllocationJob(jobNumber: string): Promise<AllocationJobDetail> {
  return requestReadWithFallback<AllocationJobDetailResponse>(
    '/allocations/by-job',
    { jobNumber },
    { jobNumber }
  );
}

export async function getJobs(limit = 25): Promise<JobListEntry[]> {
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

export async function getJob(jobNumber: string): Promise<JobDetail> {
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
    return result;
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
  if (jobsApiAvailability === 'missing') {
    throw new APIError(
      'Jobs API is not deployed yet. Deploy the Supabase Edge API with /jobs/create and try again.'
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
        'Jobs API is not deployed yet. Deploy the Supabase Edge API with /jobs/create and try again.'
      );
    }

    throw error;
  }

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function updateJob(
  payload: UpdateJobPayload
): Promise<{ result: JobDetail; warnings: string[] }> {
  if (jobsApiAvailability === 'missing') {
    throw new APIError(
      'Jobs API is not deployed yet. Deploy the Supabase Edge API with /jobs/update and try again.'
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
        'Jobs API is not deployed yet. Deploy the Supabase Edge API with /jobs/update and try again.'
      );
    }

    throw error;
  }

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function previewAllocationPlan(payload: AllocateBoxPayload): Promise<AllocationPreview> {
  const params = {
    boxId: payload.boxId,
    jobNumber: payload.jobNumber,
    jobDate: payload.jobDate,
    crewLeader: payload.crewLeader,
    requestedFeet: payload.requestedFeet,
    crossWarehouse: payload.crossWarehouse
  };

  return requestReadWithFallback<AllocationPreview>('/allocations/preview', params, params);
}

export async function applyAllocationPlan(
  payload: ApplyAllocationPlanPayload
): Promise<{ result: ApplyAllocationPlanResult; warnings: string[] }> {
  const response = await request<ApplyAllocationPlanResult>('POST', '/allocations/apply', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function getFilmOrders(): Promise<FilmOrderEntry[]> {
  const data = await requestReadWithFallback<FilmOrderListResponse>('/film-orders/list', {}, {});

  return data.entries;
}

export async function getFilmCatalog(): Promise<FilmCatalogEntry[]> {
  const data = await requestReadWithFallback<FilmCatalogResponse>('/film-data/catalog', {}, {});

  return data.entries;
}

export async function createFilmOrder(
  payload: CreateFilmOrderPayload
): Promise<{ result: FilmOrderEntry; warnings: string[] }> {
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
  const response = await request<BoxMutationResult>('POST', '/boxes/update', {
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
  const response = await request<BoxMutationResult>('POST', '/boxes/set-status', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function getAuditByBox(boxId: string): Promise<AuditEntry[]> {
  const data = await requestReadWithFallback<BoxHistoryResponse>(
    '/audit/by-box',
    { boxId },
    { boxId }
  );

  return data.entries;
}

export async function listAudit(params: AuditListParams): Promise<AuditEntry[]> {
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
  const data = await requestReadWithFallback<RollHistoryResponse>(
    '/roll-history/by-box',
    { boxId },
    { boxId }
  );

  return data.entries;
}

export async function getReportsSummary(filters: ReportsSummaryFilters): Promise<ReportsSummary> {
  const params = {
    warehouse: filters.warehouse,
    manufacturer: filters.manufacturer,
    film: filters.film,
    width: filters.width,
    from: filters.from,
    to: filters.to
  };

  return requestReadWithFallback<ReportsSummary>('/reports/summary', params, params);
}

export async function undoAudit(
  payload: UndoAuditPayload
): Promise<{ result: UndoMutationResult; warnings: string[] }> {
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
  const snapshots = await Promise.all([
    syncOfflineInventorySnapshot('IL'),
    syncOfflineInventorySnapshot('MS')
  ]);

  return snapshots.filter((snapshot): snapshot is OfflineInventorySyncMeta => Boolean(snapshot));
}

async function fetchRemoteBoxes(params: SearchBoxesParams): Promise<Box[]> {
  const filters = buildSearchBoxFilters(params);
  return requestReadWithFallback<Box[]>('/boxes/search', filters, filters);
}
