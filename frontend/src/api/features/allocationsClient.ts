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
  CaulkJobAllocationEntry,
  CaulkJobAllocationMutationResult,
  CaulkJobCheckoutMutationResult,
  CheckinCaulkJobAllocationPayload,
  ClearAllocationPlannerSuppressionPayload,
  CheckoutCaulkJobAllocationPayload,
  JobDetail,
  JobCaulkRequirementLine,
  JobRequirementLine,
  RemoveJobBoxAllocationsPayload,
  RemoveJobBoxAllocationsResult,
  RemoveCaulkJobAllocationPayload,
  RemoveCaulkJobAllocationResult,
  UpdateCaulkJobAllocationPayload
} from '../../domain';
import { request } from '../http';
import { assertFeatureAccess, requestReadWithFallback } from './sharedClient';
import type { AllocationSource } from '../../domain';

function normalizeAllocationSource(value: unknown): AllocationSource {
  const normalized = String(value || '').trim().toUpperCase();
  if (
    normalized === 'AUTO_PLANNED' ||
    normalized === 'FILM_ORDER_RECEIPT' ||
    normalized === 'DIRECT_TO_JOB_SITE'
  ) {
    return normalized;
  }
  return 'MANUAL';
}

function normalizeAllocationJobSummary(summary: AllocationJobSummary): AllocationJobSummary {
  const workScope = String(summary.workScope ?? summary.sections ?? '').trim() || null;
  return {
    ...summary,
    jobId: String(summary.jobId || '').trim() || undefined,
    workScope,
    sections: String(summary.sections ?? workScope ?? '').trim() || null,
    activeAllocatedFeet: Math.max(0, Number(summary.activeAllocatedFeet || 0)),
    allocatedWithInstallDateFeet: Math.max(0, Number(summary.allocatedWithInstallDateFeet || 0)),
    allocatedWithoutInstallDateFeet: Math.max(0, Number(summary.allocatedWithoutInstallDateFeet || 0)),
    fulfilledAllocatedFeet: Math.max(0, Number(summary.fulfilledAllocatedFeet || 0)),
    requiredTubes: Math.max(0, Number(summary.requiredTubes || 0)),
    allocatedTubes: Math.max(0, Number(summary.allocatedTubes || 0)),
    remainingTubes: Math.max(0, Number(summary.remainingTubes || 0)),
    hasOrderedAllocations: Boolean(summary.hasOrderedAllocations)
  };
}

function normalizeAllocationEntry<T extends AllocationEntry>(entry: T): T {
  return {
    ...entry,
    allocationSource: normalizeAllocationSource(entry.allocationSource),
    allocatedFeet: Math.max(0, Number(entry.allocatedFeet || 0)),
    coveredFeet: Math.max(0, Number(entry.coveredFeet || 0)),
    backedPhysicalFeet: Math.max(
      0,
      Number(
        entry.backedPhysicalFeet === undefined || entry.backedPhysicalFeet === null
          ? entry.allocatedFeet
          : entry.backedPhysicalFeet
      )
    ),
    reservationState:
      entry.reservationState === 'WITH_INSTALL_DATE' ? 'WITH_INSTALL_DATE' : 'WITHOUT_INSTALL_DATE'
  } as T;
}

function normalizeJobDetailSummary(summary: JobDetail['summary']): JobDetail['summary'] {
  const workScope = String(summary.workScope ?? summary.sections ?? '').trim() || null;
  return {
    ...summary,
    jobId: String(summary.jobId || '').trim() || undefined,
    workScope,
    sections: String(summary.sections ?? workScope ?? '').trim() || null,
    isLaborOnly: Boolean(summary.isLaborOnly),
    isStagedForPickup: Boolean(summary.isStagedForPickup),
    hasOrderedAllocations: Boolean(summary.hasOrderedAllocations),
    requiredFeet: Math.max(0, Number(summary.requiredFeet || 0)),
    allocatedFeet: Math.max(0, Number(summary.allocatedFeet || 0)),
    allocatedWithInstallDateFeet: Math.max(0, Number(summary.allocatedWithInstallDateFeet || 0)),
    allocatedWithoutInstallDateFeet: Math.max(0, Number(summary.allocatedWithoutInstallDateFeet || 0)),
    remainingFeet: Math.max(0, Number(summary.remainingFeet || 0)),
    requiredTubes: Math.max(0, Number(summary.requiredTubes || 0)),
    allocatedTubes: Math.max(0, Number(summary.allocatedTubes || 0)),
    remainingTubes: Math.max(0, Number(summary.remainingTubes || 0))
  };
}

function normalizeCaulkAllocationEntry<T extends CaulkJobAllocationEntry>(entry: T): T {
  return {
    ...entry,
    allocationSource: normalizeAllocationSource(entry.allocationSource)
  };
}

function normalizeJobRequirementLine(entry: JobRequirementLine): JobRequirementLine {
  return {
    ...entry,
    requiredFeet: Math.max(0, Number(entry.requiredFeet || 0)),
    allocatedFeet: Math.max(0, Number(entry.allocatedFeet || 0)),
    allocatedWithInstallDateFeet: Math.max(0, Number(entry.allocatedWithInstallDateFeet || 0)),
    allocatedWithoutInstallDateFeet: Math.max(0, Number(entry.allocatedWithoutInstallDateFeet || 0)),
    remainingFeet: Math.max(0, Number(entry.remainingFeet || 0)),
    autoPlanningSuppressed: Boolean(entry.autoPlanningSuppressed)
  };
}

function normalizeCaulkRequirementLine(entry: JobCaulkRequirementLine): JobCaulkRequirementLine {
  return {
    ...entry,
    requiredTubes: Math.max(0, Number(entry.requiredTubes || 0)),
    allocatedTubes: Math.max(0, Number(entry.allocatedTubes || 0)),
    remainingTubes: Math.max(0, Number(entry.remainingTubes || 0)),
    autoPlanningSuppressed: Boolean(entry.autoPlanningSuppressed)
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

  return (data.entries || []).map(normalizeAllocationEntry);
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
    requirements: (detail.requirements || []).map(normalizeJobRequirementLine),
    allocations: (detail.allocations || []).map(normalizeAllocationEntry),
    usage: detail.usage || [],
    usageTimeline: detail.usageTimeline || [],
    caulkRequirements: (detail.caulkRequirements || []).map(normalizeCaulkRequirementLine),
    caulkAllocations: (detail.caulkAllocations || []).map(normalizeCaulkAllocationEntry),
    caulkCheckouts: detail.caulkCheckouts || [],
    filmTransferAlerts: detail.filmTransferAlerts || [],
    caulkTransferAlerts: detail.caulkTransferAlerts || []
  };
}

export async function clearAllocationPlannerSuppression(
  payload: ClearAllocationPlannerSuppressionPayload
): Promise<{ result: JobDetail; warnings: string[] }> {
  assertFeatureAccess('allocations', 'write');
  const response = await request<JobDetail>('POST', '/allocations/planner-suppression/clear', {
    body: payload
  });

  return {
    result: {
      ...response.data,
      summary: normalizeJobDetailSummary(response.data.summary),
      requirements: (response.data.requirements || []).map(normalizeJobRequirementLine),
      allocations: (response.data.allocations || []).map(normalizeAllocationEntry),
      usage: response.data.usage || [],
      usageTimeline: response.data.usageTimeline || [],
      caulkRequirements: (response.data.caulkRequirements || []).map(normalizeCaulkRequirementLine),
      caulkAllocations: (response.data.caulkAllocations || []).map(normalizeCaulkAllocationEntry),
      caulkCheckouts: response.data.caulkCheckouts || [],
      filmTransferAlerts: response.data.filmTransferAlerts || [],
      caulkTransferAlerts: response.data.caulkTransferAlerts || []
    },
    warnings: response.warnings
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
    result: {
      ...response.data,
      allocations: (response.data.allocations || []).map(normalizeAllocationEntry)
    },
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
