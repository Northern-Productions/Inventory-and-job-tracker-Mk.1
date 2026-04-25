import type { QueryClient } from '@tanstack/react-query';
import type {
  AllocationEntry,
  AllocationJobDetail,
  AllocationJobDetailEntry,
  AllocationJobSummary,
  AllocationPreview,
  ApplyAllocationPlanPayload,
  Box,
  JobDetail
} from '../../../domain';
import { WAREHOUSE_CODES } from '../../../domain';
import { planCoverageAllocation } from '../../../domain/allocationCoverageContract.mjs';
import {
  applyPlanningAllocationToCachedBox,
  findCachedBoxById,
  getBoxAllocationPlanningFeet,
  releasePlanningAllocationFromCachedBox,
  updateBoxCaches
} from './boxes';
import {
  buildAllocationJobSummaryFromAllocations,
  createOptimisticJobDetailAfterAllocationAddition,
  createOptimisticJobDetailAfterAllocationRemoval,
  syncJobDetailCaches,
  upsertAllocationJobSummaryCaches
} from './jobs';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';

function makePendingId(prefix: string) {
  return `pending-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function matchesAllocationPreviewPayload(candidate: unknown, payload: ApplyAllocationPlanPayload) {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }

  const previewPayload = candidate as Partial<ApplyAllocationPlanPayload>;
  return (
    String(previewPayload.boxId || '').trim().toUpperCase() === payload.boxId.trim().toUpperCase() &&
    String(previewPayload.jobNumber || '').trim().toUpperCase() === payload.jobNumber.trim().toUpperCase() &&
    Number(previewPayload.requestedFeet || 0) === Number(payload.requestedFeet || 0) &&
    String(previewPayload.requirementId || '').trim() === String(payload.requirementId || '').trim() &&
    Number(previewPayload.requestedWidthIn || 0) === Number(payload.requestedWidthIn || 0)
  );
}

function findMatchingAllocationPreview(queryClient: QueryClient, payload: ApplyAllocationPlanPayload) {
  const previewQueries = queryClient.getQueriesData<AllocationPreview>({
    queryKey: ['inventory', 'allocation-preview'] as const
  });

  for (let index = 0; index < previewQueries.length; index += 1) {
    const [queryKey, preview] = previewQueries[index];
    if (!preview) {
      continue;
    }

    const previewPayload = Array.isArray(queryKey) && queryKey.length >= 3 ? queryKey[2] : null;
    if (matchesAllocationPreviewPayload(previewPayload, payload)) {
      return preview;
    }
  }

  return null;
}

interface OptimisticAllocationBuildResult {
  allocations: AllocationEntry[];
  jobAllocations: AllocationJobDetailEntry[];
  allocatedFeetByBoxId: Record<string, number>;
}

function buildOptimisticAllocationRows(
  queryClient: QueryClient,
  payload: ApplyAllocationPlanPayload,
  detail: JobDetail | undefined
): OptimisticAllocationBuildResult {
  const selectedRequirement =
    detail?.requirements.find((entry) => entry.requirementId === payload.requirementId) || null;
  const preview = findMatchingAllocationPreview(queryClient, payload);
  const selectedSuggestionIds = new Set(payload.selectedSuggestionBoxIds || []);
  const allocations: AllocationEntry[] = [];
  const jobAllocations: AllocationJobDetailEntry[] = [];
  const allocatedFeetByBoxId: Record<string, number> = {};
  const now = new Date().toISOString();
  const requirementWidthIn = Number(payload.requestedWidthIn) || Number(selectedRequirement?.widthIn) || 0;
  let remainingFeet = Math.max(0, Math.floor(Number(payload.requestedFeet || 0)));

  function addOptimisticAllocation(
    boxId: string,
    planningFeet: number,
    options: {
      warehouse?: string;
      widthIn?: number;
      boxStatus?: Box['status'];
      box?: Box | null;
    } = {}
  ) {
    if (planningFeet <= 0 || remainingFeet <= 0) {
      return;
    }

    const box = options.box || findCachedBoxById(queryClient, boxId);
    const warehouse =
      options.warehouse || box?.warehouse || payload.jobWarehouse || detail?.summary.warehouse || WAREHOUSE_CODES[0];
    const widthIn = options.widthIn || box?.widthIn || requirementWidthIn || 0;
    const boxStatus = options.boxStatus || box?.status || 'ORDERED';
    const nextPlan = planCoverageAllocation(remainingFeet, planningFeet, widthIn, requirementWidthIn);
    const nextAllocatedFeet = nextPlan.allocatedFeet;
    const nextCoveredFeet = nextPlan.coveredFeet;
    if (nextAllocatedFeet <= 0 || nextCoveredFeet <= 0) {
      return;
    }

    const manufacturer = box?.manufacturer || selectedRequirement?.manufacturer || '';
    const filmName = box?.filmName || selectedRequirement?.filmName || '';
    const allocationId = makePendingId(`allocation-${boxId}`);

    allocations.push({
      allocationId,
      boxId,
      warehouse,
      jobNumber: payload.jobNumber,
      installDate: payload.installDate || '',
      crewLeader: payload.crewLeader || '',
      allocatedFeet: nextAllocatedFeet,
      coveredFeet: nextCoveredFeet,
      requirementId: payload.requirementId,
      allocationKind: 'REQUIREMENT',
      allocationSource: 'MANUAL',
      status: 'ACTIVE',
      createdAt: now,
      createdBy: 'Pending...',
      resolvedAt: '',
      resolvedBy: '',
      filmOrderId: '',
      notes: 'Pending server confirmation'
    });

    jobAllocations.push({
      allocationId,
      boxId,
      warehouse,
      jobNumber: payload.jobNumber,
      installDate: payload.installDate || '',
      crewLeader: payload.crewLeader || '',
      allocatedFeet: nextAllocatedFeet,
      coveredFeet: nextCoveredFeet,
      requirementId: payload.requirementId,
      allocationKind: 'REQUIREMENT',
      allocationSource: 'MANUAL',
      status: 'ACTIVE',
      createdAt: now,
      createdBy: 'Pending...',
      resolvedAt: '',
      resolvedBy: '',
      filmOrderId: '',
      notes: 'Pending server confirmation',
      manufacturer,
      filmName,
      widthIn,
      boxStatus,
      checkedOutOnThisJob: false
    });

    allocatedFeetByBoxId[boxId] = (allocatedFeetByBoxId[boxId] || 0) + nextAllocatedFeet;
    remainingFeet = nextPlan.remainingCoveredFeet;
  }

  if (preview) {
    if (preview.sourceSuggestedFeet > 0) {
      addOptimisticAllocation(preview.sourceBoxId, preview.sourceSuggestedFeet, {
        warehouse: preview.sourceWarehouse,
        widthIn: findCachedBoxById(queryClient, preview.sourceBoxId)?.widthIn || Number(payload.requestedWidthIn) || 0,
        boxStatus: preview.sourceBoxStatus
      });
    }

    for (let index = 0; index < preview.suggestions.length && remainingFeet > 0; index += 1) {
      const suggestion = preview.suggestions[index];
      if (!selectedSuggestionIds.has(suggestion.boxId)) {
        continue;
      }

      addOptimisticAllocation(suggestion.boxId, suggestion.planningFeet, {
        warehouse: suggestion.warehouse,
        widthIn: suggestion.widthIn,
        boxStatus: suggestion.boxStatus
      });
    }
  } else {
    const orderedBoxIds = [payload.boxId, ...(payload.selectedSuggestionBoxIds || [])];
    for (let index = 0; index < orderedBoxIds.length && remainingFeet > 0; index += 1) {
      const boxId = orderedBoxIds[index];
      const box = findCachedBoxById(queryClient, boxId);
      addOptimisticAllocation(boxId, Math.max(0, Number(box ? getBoxAllocationPlanningFeet(box) : remainingFeet)), {
        box
      });
    }
  }

  return {
    allocations,
    jobAllocations,
    allocatedFeetByBoxId
  };
}

export function applyOptimisticAllocationRemovalToCaches(
  queryClient: QueryClient,
  jobNumber: string,
  allocationId: string
) {
  let removedAllocation: AllocationJobDetailEntry | null = null;
  let removedBoxId = '';
  let removedAllocationForBoxUpdate: Pick<AllocationEntry, 'boxId' | 'allocatedFeet' | 'status'> | null = null;
  let syncedFromJobDetail = false;
  let fallbackAllocationJobSummary: AllocationJobSummary | null = null;
  const currentJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job(jobNumber));

  if (currentJob) {
    const optimisticResult = createOptimisticJobDetailAfterAllocationRemoval(currentJob, allocationId);
    if (optimisticResult.removedAllocation) {
      removedAllocation = optimisticResult.removedAllocation;
      removedBoxId = optimisticResult.removedAllocation.boxId;
      removedAllocationForBoxUpdate = {
        boxId: optimisticResult.removedAllocation.boxId,
        allocatedFeet: optimisticResult.removedAllocation.allocatedFeet,
        status: optimisticResult.removedAllocation.status
      };
      syncedFromJobDetail = true;
      syncJobDetailCaches(queryClient, optimisticResult.detail, { syncAllocationJobDetail: true });
    }
  }

  queryClient.setQueryData<AllocationJobDetail | undefined>(inventoryKeys.allocationJob(jobNumber), (current) => {
    if (!current) {
      return current;
    }

    const matched = current.allocations.find((entry) => entry.allocationId === allocationId) || null;
    if (matched) {
      removedBoxId = removedBoxId || matched.boxId;
      removedAllocationForBoxUpdate =
        removedAllocationForBoxUpdate || {
          boxId: matched.boxId,
          allocatedFeet: matched.allocatedFeet,
          status: matched.status
        };
      if (!removedAllocation) {
        removedAllocation = matched;
      }
    }

    const nextAllocations = current.allocations.filter((entry) => entry.allocationId !== allocationId);
    if (syncedFromJobDetail || !matched) {
      return {
        ...current,
        allocations: nextAllocations
      };
    }

    fallbackAllocationJobSummary = buildAllocationJobSummaryFromAllocations(
      current.summary,
      nextAllocations,
      current.filmOrders
    );

    return {
      ...current,
      summary: fallbackAllocationJobSummary,
      allocations: nextAllocations
    };
  });

  if (!syncedFromJobDetail && fallbackAllocationJobSummary) {
    upsertAllocationJobSummaryCaches(queryClient, fallbackAllocationJobSummary);
  }

  const allocationQueries = queryClient.getQueriesData<AllocationEntry[]>({
    queryKey: inventoryKeys.allocationsRoot
  });
  for (let index = 0; index < allocationQueries.length; index += 1) {
    const [queryKey, current] = allocationQueries[index];
    if (!current) {
      continue;
    }

    const matched = current.find((entry) => entry.allocationId === allocationId) || null;
    if (!matched) {
      continue;
    }

    removedBoxId = removedBoxId || matched.boxId;
    removedAllocationForBoxUpdate =
      removedAllocationForBoxUpdate || {
        boxId: matched.boxId,
        allocatedFeet: matched.allocatedFeet,
        status: matched.status
      };

    queryClient.setQueryData<AllocationEntry[]>(
      queryKey,
      current.filter((entry) => entry.allocationId !== allocationId)
    );
  }

  if (
    removedAllocationForBoxUpdate &&
    removedAllocationForBoxUpdate.status === 'ACTIVE' &&
    removedAllocationForBoxUpdate.allocatedFeet > 0
  ) {
    const releasedFeet = removedAllocationForBoxUpdate.allocatedFeet;
    updateBoxCaches(queryClient, removedAllocationForBoxUpdate.boxId, (box) => {
      if (box.status === 'ZEROED' || box.status === 'RETIRED') {
        return box;
      }

      return releasePlanningAllocationFromCachedBox(box, releasedFeet);
    });
  }

  return {
    removedBoxId,
    rollback: removedAllocation
      ? {
          jobNumber,
          allocation: removedAllocation
        }
      : null
  };
}

export interface OptimisticAllocationRemovalRollback {
  jobNumber: string;
  allocation: AllocationJobDetailEntry;
}

function createAllocationEntryFromDetail(entry: AllocationJobDetailEntry): AllocationEntry {
  return {
    allocationId: entry.allocationId,
    boxId: entry.boxId,
    warehouse: entry.warehouse,
    jobNumber: entry.jobNumber,
    installDate: entry.installDate,
    crewLeader: entry.crewLeader,
    allocatedFeet: entry.allocatedFeet,
    coveredFeet: entry.coveredFeet,
    requirementId: entry.requirementId,
    allocationKind: entry.allocationKind,
    allocationSource: entry.allocationSource,
    status: entry.status,
    createdAt: entry.createdAt,
    createdBy: entry.createdBy,
    resolvedAt: entry.resolvedAt,
    resolvedBy: entry.resolvedBy,
    filmOrderId: entry.filmOrderId,
    notes: entry.notes
  };
}

export function rollbackOptimisticAllocationRemovalInCaches(
  queryClient: QueryClient,
  rollback: OptimisticAllocationRemovalRollback | null | undefined
) {
  if (!rollback) {
    return;
  }

  const { allocation } = rollback;
  const normalizedAllocationId = allocation.allocationId.trim().toUpperCase();
  const currentJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job(rollback.jobNumber));

  if (currentJob) {
    const alreadyPresent = currentJob.allocations.some(
      (entry) => entry.allocationId.trim().toUpperCase() === normalizedAllocationId
    );
    if (!alreadyPresent) {
      const nextDetail = createOptimisticJobDetailAfterAllocationAddition(currentJob, [allocation]);
      syncJobDetailCaches(queryClient, nextDetail, { syncAllocationJobDetail: true });
    }
  } else {
    let nextAllocationSummary: AllocationJobSummary | null = null;

    queryClient.setQueryData<AllocationJobDetail | undefined>(
      inventoryKeys.allocationJob(rollback.jobNumber),
      (current) => {
        if (!current) {
          return current;
        }

        const alreadyPresent = current.allocations.some(
          (entry) => entry.allocationId.trim().toUpperCase() === normalizedAllocationId
        );
        if (alreadyPresent) {
          return current;
        }

        const nextAllocations = [...current.allocations, allocation];
        nextAllocationSummary = buildAllocationJobSummaryFromAllocations(
          current.summary,
          nextAllocations,
          current.filmOrders
        );

        return {
          ...current,
          summary: nextAllocationSummary,
          allocations: nextAllocations
        };
      }
    );

    if (nextAllocationSummary) {
      upsertAllocationJobSummaryCaches(queryClient, nextAllocationSummary);
    }
  }

  queryClient.setQueryData<AllocationEntry[] | undefined>(
    inventoryKeys.allocations(allocation.boxId),
    (current) => {
      if (!current) {
        return current;
      }

      const alreadyPresent = current.some(
        (entry) => entry.allocationId.trim().toUpperCase() === normalizedAllocationId
      );
      if (alreadyPresent) {
        return current;
      }

      return [...current, createAllocationEntryFromDetail(allocation)];
    }
  );

  if (allocation.status === 'ACTIVE' && allocation.allocatedFeet > 0) {
    updateBoxCaches(queryClient, allocation.boxId, (box) => {
      if (box.status === 'ZEROED' || box.status === 'RETIRED') {
        return box;
      }

      return applyPlanningAllocationToCachedBox(box, allocation.allocatedFeet);
    });
  }
}

export function rollbackOptimisticAllocationAdditionInCaches(
  queryClient: QueryClient,
  jobNumber: string,
  allocationIds: readonly string[]
) {
  const uniqueAllocationIds = Array.from(
    new Set(
      allocationIds
        .map((allocationId) => String(allocationId || '').trim())
        .filter(Boolean)
    )
  );

  for (let index = 0; index < uniqueAllocationIds.length; index += 1) {
    applyOptimisticAllocationRemovalToCaches(queryClient, jobNumber, uniqueAllocationIds[index]);
  }
}

export function applyOptimisticAllocationAdditionToCaches(
  queryClient: QueryClient,
  payload: ApplyAllocationPlanPayload
) {
  const currentJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job(payload.jobNumber));
  const optimisticRows = buildOptimisticAllocationRows(queryClient, payload, currentJob);
  const syncedAllocationJobFromDetail = Boolean(currentJob);

  if (!optimisticRows.allocations.length) {
    return optimisticRows;
  }

  if (currentJob) {
    const nextJobDetail = createOptimisticJobDetailAfterAllocationAddition(currentJob, optimisticRows.jobAllocations);
    syncJobDetailCaches(queryClient, nextJobDetail, { syncAllocationJobDetail: true });
  }

  if (!syncedAllocationJobFromDetail) {
    queryClient.setQueryData<AllocationJobDetail | undefined>(inventoryKeys.allocationJob(payload.jobNumber), (current) => {
      if (!current) {
        return current;
      }

      const nextAllocations = [...current.allocations, ...optimisticRows.jobAllocations];
      return {
        ...current,
        summary: buildAllocationJobSummaryFromAllocations(current.summary, nextAllocations, current.filmOrders),
        allocations: nextAllocations
      };
    });
  }

  for (let index = 0; index < optimisticRows.allocations.length; index += 1) {
    const entry = optimisticRows.allocations[index];
    queryClient.setQueryData<AllocationEntry[] | undefined>(inventoryKeys.allocations(entry.boxId), (current) => [
      ...(current || []),
      entry
    ]);
  }

  const touchedBoxIds = Object.keys(optimisticRows.allocatedFeetByBoxId);
  for (let index = 0; index < touchedBoxIds.length; index += 1) {
    const boxId = touchedBoxIds[index];
    const allocatedFeet = optimisticRows.allocatedFeetByBoxId[boxId] || 0;
    if (allocatedFeet <= 0) {
      continue;
    }

    updateBoxCaches(queryClient, boxId, (box) => ({
      ...applyPlanningAllocationToCachedBox(box, allocatedFeet)
    }));
  }

  return optimisticRows;
}
