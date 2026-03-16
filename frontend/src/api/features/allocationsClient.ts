// Purpose: Allocation planning and assignment API surface.
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
  RemoveJobBoxAllocationsPayload,
  RemoveJobBoxAllocationsResult
} from '../../domain';
import { request } from '../http';
import { assertFeatureAccess, requestReadWithFallback } from './sharedClient';

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
