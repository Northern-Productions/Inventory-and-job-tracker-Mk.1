// Purpose: Allocation planning and assignment API surface.
import type {
  AddCaulkJobAllocationPayload,
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
  CaulkJobAllocationMutationResult,
  CaulkJobCheckoutMutationResult,
  CheckinCaulkJobAllocationPayload,
  CheckoutCaulkJobAllocationPayload,
  RemoveJobBoxAllocationsPayload,
  RemoveJobBoxAllocationsResult,
  RemoveCaulkJobAllocationPayload,
  RemoveCaulkJobAllocationResult,
  UpdateCaulkJobAllocationPayload
} from '../../domain';
import { request } from '../http';
import { assertFeatureAccess, requestReadWithFallback } from './sharedClient';

function normalizeAllocationJobSummary(summary: AllocationJobSummary): AllocationJobSummary {
  return {
    ...summary,
    requiredTubes: Math.max(0, Number(summary.requiredTubes || 0)),
    allocatedTubes: Math.max(0, Number(summary.allocatedTubes || 0)),
    remainingTubes: Math.max(0, Number(summary.remainingTubes || 0)),
    hasOrderedAllocations: Boolean(summary.hasOrderedAllocations)
  };
}

function normalizeAllocationPreview(preview: AllocationPreview): AllocationPreview {
  return {
    ...preview,
    sourceBoxFeetAvailable: Math.max(0, Number(preview.sourceBoxFeetAvailable || 0)),
    sourceBoxPlanningFeet: Math.max(
      0,
      Number(
        preview.sourceBoxPlanningFeet === undefined || preview.sourceBoxPlanningFeet === null
          ? preview.sourceBoxFeetAvailable
          : preview.sourceBoxPlanningFeet
      )
    ),
    sourceBoxStatus: preview.sourceBoxStatus || 'ORDERED',
    suggestions: (preview.suggestions || []).map((suggestion) => ({
      ...suggestion,
      availableFeet: Math.max(0, Number(suggestion.availableFeet || 0)),
      planningFeet: Math.max(
        0,
        Number(
          suggestion.planningFeet === undefined || suggestion.planningFeet === null
            ? suggestion.availableFeet
            : suggestion.planningFeet
        )
      ),
      boxStatus: suggestion.boxStatus || 'ORDERED'
    }))
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
  return (data.entries || []).map(normalizeAllocationJobSummary);
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
    summary: normalizeAllocationJobSummary(detail.summary),
    usage: detail.usage || [],
    usageTimeline: detail.usageTimeline || [],
    caulkRequirements: detail.caulkRequirements || [],
    caulkAllocations: detail.caulkAllocations || [],
    caulkCheckouts: detail.caulkCheckouts || [],
    filmTransferAlerts: detail.filmTransferAlerts || []
  };
}

export async function previewAllocationPlan(payload: AllocateBoxPayload): Promise<AllocationPreview> {
  assertFeatureAccess('allocations', 'read');
  const params = {
    boxId: payload.boxId,
    jobNumber: payload.jobNumber,
    installDate: payload.installDate,
    crewLeader: payload.crewLeader,
    requestedFeet: payload.requestedFeet,
    requestedWidthIn: payload.requestedWidthIn,
    requirementId: payload.requirementId,
    crossWarehouse: payload.crossWarehouse,
    jobWarehouse: payload.jobWarehouse
  };

  return normalizeAllocationPreview(
    await requestReadWithFallback<AllocationPreview>('/allocations/preview', params, params)
  );
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

export async function addCaulkJobAllocation(
  payload: AddCaulkJobAllocationPayload
): Promise<{ result: CaulkJobAllocationMutationResult; warnings: string[] }> {
  assertFeatureAccess('allocations', 'write');
  const response = await request<CaulkJobAllocationMutationResult>('POST', '/allocations/caulk/add', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function updateCaulkJobAllocation(
  payload: UpdateCaulkJobAllocationPayload
): Promise<{ result: CaulkJobAllocationMutationResult; warnings: string[] }> {
  assertFeatureAccess('allocations', 'write');
  const response = await request<CaulkJobAllocationMutationResult>('POST', '/allocations/caulk/update', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function checkoutCaulkJobAllocation(
  payload: CheckoutCaulkJobAllocationPayload
): Promise<{ result: CaulkJobCheckoutMutationResult; warnings: string[] }> {
  assertFeatureAccess('allocations', 'write');
  const response = await request<CaulkJobCheckoutMutationResult>('POST', '/allocations/caulk/checkout', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function checkinCaulkJobAllocation(
  payload: CheckinCaulkJobAllocationPayload
): Promise<{ result: CaulkJobCheckoutMutationResult; warnings: string[] }> {
  assertFeatureAccess('allocations', 'write');
  const response = await request<CaulkJobCheckoutMutationResult>('POST', '/allocations/caulk/checkin', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}

export async function removeCaulkJobAllocation(
  payload: RemoveCaulkJobAllocationPayload
): Promise<{ result: RemoveCaulkJobAllocationResult; warnings: string[] }> {
  assertFeatureAccess('allocations', 'write');
  const response = await request<RemoveCaulkJobAllocationResult>('POST', '/allocations/caulk/remove', {
    body: payload
  });

  return {
    result: response.data,
    warnings: response.warnings
  };
}
