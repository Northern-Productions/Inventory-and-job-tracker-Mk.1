import type {
  AllocationEntry,
  AllocationJobDetail,
  AllocationJobDetailResponse,
  AllocationJobListResponse,
  AllocationJobSummary,
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
  FilmOrderEntry,
  FilmOrderListResponse,
  HealthResponse,
  ReportsSummary,
  ReportsSummaryFilters,
  RollHistoryResponse,
  RollHistoryEntry,
  SearchBoxesParams,
  SetBoxStatusPayload,
  UndoAuditPayload,
  UndoMutationResult,
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

export async function previewAllocationPlan(payload: AllocateBoxPayload): Promise<AllocationPreview> {
  const params = {
    boxId: payload.boxId,
    jobNumber: payload.jobNumber,
    jobDate: payload.jobDate,
    crewLeader: payload.crewLeader,
    requestedFeet: payload.requestedFeet
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
