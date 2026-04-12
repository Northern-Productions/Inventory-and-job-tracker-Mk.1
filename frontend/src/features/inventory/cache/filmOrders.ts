import type { QueryClient } from '@tanstack/react-query';
import type {
  AddBoxPayload,
  AllocationEntry,
  AllocationJobDetail,
  AllocationJobSummary,
  Box,
  CreateFilmOrderPayload,
  FilmOrderEntry,
  JobDetail,
  JobListEntry
} from '../../../domain';
import {
  createOptimisticBoxFromAddPayload,
  releasePlanningAllocationFromCachedBox,
  updateBoxCaches,
  upsertBoxInSearchCaches
} from './boxes';
import {
  buildAllocationJobSummaryFromAllocations,
  createOptimisticJobDetailAfterFilmOrderDeletion,
  createOptimisticJobDetailAfterFilmOrderReceipt,
  syncJobDetailCaches,
  syncJobSummaryCachesFromDetail
} from './jobs';
import { countUnresolvedFilmOrders, isUnresolvedFilmOrder } from '../utils/filmOrders';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';

function buildOptimisticFilmOrderAfterBoxReceipt(
  entry: FilmOrderEntry,
  box: Pick<Box, 'boxId' | 'initialFeet'>
): FilmOrderEntry {
  if (entry.status === 'CANCELLED' || entry.status === 'FULFILLED') {
    return entry;
  }

  const nextOrderedFeet =
    Math.max(0, Number(entry.orderedFeet || 0)) + Math.max(0, Number(box.initialFeet || 0));
  const nextRemainingToOrderFeet = Math.max(
    Math.max(0, Number(entry.requestedFeet || 0)) - nextOrderedFeet,
    0
  );
  const nextStatus =
    nextOrderedFeet >= Math.max(0, Number(entry.requestedFeet || 0))
      ? 'FILM_ON_THE_WAY'
      : 'FILM_ORDER';

  return {
    ...entry,
    orderedFeet: nextOrderedFeet,
    remainingToOrderFeet: nextRemainingToOrderFeet,
    status: nextStatus,
    resolvedAt: '',
    resolvedBy: '',
    linkedBoxes: [
      ...entry.linkedBoxes,
      {
        boxId: box.boxId,
        orderedFeet: Math.max(0, Number(box.initialFeet || 0)),
        autoAllocatedFeet: 0
      }
    ]
  };
}

function deriveAllocationJobStatusFromFilmOrders(
  currentStatus: AllocationJobSummary['status'],
  filmOrders: FilmOrderEntry[]
) {
  if (filmOrders.some((entry) => entry.status === 'FILM_ORDER')) {
    return 'FILM_ORDER' as const;
  }

  if (filmOrders.some((entry) => isUnresolvedFilmOrder(entry))) {
    return 'ON_ORDER' as const;
  }

  return currentStatus;
}

function applyOptimisticFilmOrderReceiptToCaches(
  queryClient: QueryClient,
  filmOrderId: string,
  box: Pick<Box, 'boxId' | 'initialFeet'>
) {
  const touchedJobNumbers = new Set<string>();
  const filmOrdersByJobNumber: Record<string, FilmOrderEntry[]> = {};
  const syncedFromJobDetail = new Set<string>();

  queryClient.setQueryData<FilmOrderEntry[] | undefined>(inventoryKeys.filmOrders, (current) => {
    if (!current) {
      return current;
    }

    const nextEntries = current.map((entry) => {
      if (entry.filmOrderId !== filmOrderId) {
        return entry;
      }

      touchedJobNumbers.add(entry.jobNumber);
      return buildOptimisticFilmOrderAfterBoxReceipt(entry, box);
    });

    for (let index = 0; index < nextEntries.length; index += 1) {
      const entry = nextEntries[index];
      if (!touchedJobNumbers.has(entry.jobNumber)) {
        continue;
      }

      if (!filmOrdersByJobNumber[entry.jobNumber]) {
        filmOrdersByJobNumber[entry.jobNumber] = [];
      }
      filmOrdersByJobNumber[entry.jobNumber].push(entry);
    }

    return nextEntries;
  });

  const jobQueries = queryClient.getQueriesData<JobDetail>({ queryKey: inventoryKeys.jobRoot });
  for (let index = 0; index < jobQueries.length; index += 1) {
    const [, current] = jobQueries[index];
    if (!current) {
      continue;
    }

    const nextDetail = createOptimisticJobDetailAfterFilmOrderReceipt(current, filmOrderId, box);
    if (!nextDetail.updated) {
      continue;
    }

    touchedJobNumbers.add(nextDetail.detail.summary.jobNumber);
    syncedFromJobDetail.add(nextDetail.detail.summary.jobNumber);
    filmOrdersByJobNumber[nextDetail.detail.summary.jobNumber] = nextDetail.detail.filmOrders;
    syncJobDetailCaches(queryClient, nextDetail.detail, { syncAllocationJobDetail: true });
  }

  const allocationJobQueries = queryClient.getQueriesData<AllocationJobDetail>({
    queryKey: inventoryKeys.allocationJobRoot
  });
  for (let index = 0; index < allocationJobQueries.length; index += 1) {
    const [queryKey, current] = allocationJobQueries[index];
    if (!current || syncedFromJobDetail.has(current.summary.jobNumber)) {
      continue;
    }

    let updated = false;
    const nextFilmOrders = current.filmOrders.map((entry) => {
      if (entry.filmOrderId !== filmOrderId) {
        return entry;
      }

      updated = true;
      return buildOptimisticFilmOrderAfterBoxReceipt(entry, box);
    });

    if (!updated) {
      continue;
    }

    touchedJobNumbers.add(current.summary.jobNumber);
    filmOrdersByJobNumber[current.summary.jobNumber] = nextFilmOrders;
    queryClient.setQueryData<AllocationJobDetail>(queryKey, {
      ...current,
      summary: {
        ...buildAllocationJobSummaryFromAllocations(current.summary, current.allocations, nextFilmOrders),
        status: deriveAllocationJobStatusFromFilmOrders(current.summary.status, nextFilmOrders)
      },
      filmOrders: nextFilmOrders
    });
  }

  if (!Object.keys(filmOrdersByJobNumber).length) {
    return;
  }

  queryClient.setQueryData<AllocationJobSummary[] | undefined>(inventoryKeys.allocationJobs, (current) =>
    current
      ? current.map((entry) => {
          const nextFilmOrders = filmOrdersByJobNumber[entry.jobNumber];
          if (!nextFilmOrders) {
            return entry;
          }

          return {
            ...entry,
            openFilmOrderCount: countUnresolvedFilmOrders(nextFilmOrders),
            status: deriveAllocationJobStatusFromFilmOrders(entry.status, nextFilmOrders)
          };
        })
      : current
  );
}

export function applyOptimisticAddBoxToCaches(queryClient: QueryClient, payload: AddBoxPayload) {
  const optimisticBox = createOptimisticBoxFromAddPayload(payload);
  queryClient.setQueryData(inventoryKeys.box(optimisticBox.boxId), optimisticBox);
  upsertBoxInSearchCaches(queryClient, optimisticBox);

  if (payload.filmOrderId) {
    applyOptimisticFilmOrderReceiptToCaches(queryClient, payload.filmOrderId, optimisticBox);
  }

  return optimisticBox;
}

export function createOptimisticFilmOrderFromPayload(
  payload: CreateFilmOrderPayload,
  scheduleMetadata: { installDate?: string; crewLeader?: string } = {}
): FilmOrderEntry {
  const createdAt = new Date().toISOString();

  return {
    filmOrderId: `pending-film-order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    jobNumber: payload.jobNumber,
    warehouse: payload.warehouse,
    manufacturer: payload.manufacturer,
    filmName: payload.filmName,
    widthIn: payload.widthIn,
    requestedFeet: payload.requestedFeet,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: payload.requestedFeet,
    installDate: String(scheduleMetadata.installDate || '').trim(),
    crewLeader: String(scheduleMetadata.crewLeader || '').trim(),
    status: 'FILM_ORDER',
    sourceBoxId: '',
    createdAt,
    createdBy: 'Pending...',
    resolvedAt: '',
    resolvedBy: '',
    notes: 'Pending server confirmation',
    linkedBoxes: []
  };
}

export function resolveOptimisticFilmOrderScheduleFromCaches(
  queryClient: QueryClient,
  jobNumber: string
) {
  const normalizedJobNumber = String(jobNumber || '').trim();
  if (!normalizedJobNumber) {
    return {
      installDate: '',
      crewLeader: ''
    };
  }

  const currentJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job(normalizedJobNumber));
  if (currentJob?.summary) {
    return {
      installDate: String(currentJob.summary.installDate || '').trim(),
      crewLeader: String(currentJob.summary.crewLeader || '').trim()
    };
  }

  const currentAllocationJob = queryClient.getQueryData<AllocationJobDetail>(
    inventoryKeys.allocationJob(normalizedJobNumber)
  );
  if (currentAllocationJob?.summary) {
    return {
      installDate: String(currentAllocationJob.summary.installDate || '').trim(),
      crewLeader: String(currentAllocationJob.summary.crewLeader || '').trim()
    };
  }

  const jobsQueries = queryClient.getQueriesData<JobListEntry[]>({
    queryKey: inventoryKeys.jobs
  });
  for (let index = 0; index < jobsQueries.length; index += 1) {
    const [, current] = jobsQueries[index];
    const match = Array.isArray(current)
      ? current.find((entry) => entry.jobNumber === normalizedJobNumber)
      : null;
    if (match) {
      return {
        installDate: String(match.installDate || '').trim(),
        crewLeader: String(match.crewLeader || '').trim()
      };
    }
  }

  const allocationJobQueries = queryClient.getQueriesData<AllocationJobSummary[]>({
    queryKey: inventoryKeys.allocationJobs
  });
  for (let index = 0; index < allocationJobQueries.length; index += 1) {
    const [, current] = allocationJobQueries[index];
    const match = Array.isArray(current)
      ? current.find((entry) => entry.jobNumber === normalizedJobNumber)
      : null;
    if (match) {
      return {
        installDate: String(match.installDate || '').trim(),
        crewLeader: String(match.crewLeader || '').trim()
      };
    }
  }

  return {
    installDate: '',
    crewLeader: ''
  };
}

export function upsertFilmOrdersCache(queryClient: QueryClient, entry: FilmOrderEntry) {
  queryClient.setQueryData<FilmOrderEntry[] | undefined>(inventoryKeys.filmOrders, (current) => {
    if (!current) {
      return [entry];
    }

    const existingIndex = current.findIndex((order) => order.filmOrderId === entry.filmOrderId);
    if (existingIndex === -1) {
      return [entry, ...current];
    }

    return current.map((order) => (order.filmOrderId === entry.filmOrderId ? entry : order));
  });
}

export function replaceFilmOrderInCaches(
  queryClient: QueryClient,
  pendingFilmOrderId: string,
  nextFilmOrder: FilmOrderEntry
) {
  queryClient.setQueryData<FilmOrderEntry[] | undefined>(inventoryKeys.filmOrders, (current) =>
    current
      ? current.map((entry) =>
          entry.filmOrderId === pendingFilmOrderId ? nextFilmOrder : entry
        )
      : current
  );
}

export function applyOptimisticFilmOrderDeletionToCaches(
  queryClient: QueryClient,
  options: { filmOrderId: string; reason?: string; resolvedAt?: string; jobNumber?: string }
) {
  const filmOrderId = String(options.filmOrderId || '').trim();
  if (!filmOrderId) {
    return {
      removedJobNumbers: [],
      releasedBoxIds: []
    };
  }

  const resolvedAt = options.resolvedAt || new Date().toISOString();
  const reason = String(options.reason || '').trim() || 'Pending server confirmation';
  const removedJobNumbers = new Set<string>();
  const releasedFeetByBoxId: Record<string, number> = {};
  const releasedAllocationIds = new Set<string>();
  const jobNumbersSyncedFromDetail = new Set<string>();

  function collectReleasedFeet(
    entry: Pick<AllocationEntry, 'allocationId' | 'boxId' | 'allocatedFeet' | 'status' | 'filmOrderId'>
  ) {
    if (
      entry.status !== 'ACTIVE' ||
      String(entry.filmOrderId || '').trim() !== filmOrderId ||
      releasedAllocationIds.has(entry.allocationId)
    ) {
      return;
    }

    releasedAllocationIds.add(entry.allocationId);
    releasedFeetByBoxId[entry.boxId] =
      Math.max(0, Number(releasedFeetByBoxId[entry.boxId] || 0)) +
      Math.max(0, Number(entry.allocatedFeet || 0));
  }

  queryClient.setQueryData<FilmOrderEntry[] | undefined>(inventoryKeys.filmOrders, (current) =>
    current ? current.filter((entry) => entry.filmOrderId !== filmOrderId) : current
  );

  const jobQueries = queryClient.getQueriesData<JobDetail>({ queryKey: inventoryKeys.jobRoot });
  for (let index = 0; index < jobQueries.length; index += 1) {
    const [queryKey, current] = jobQueries[index];
    if (!current) {
      continue;
    }

    const result = createOptimisticJobDetailAfterFilmOrderDeletion(current, {
      filmOrderId,
      reason,
      resolvedAt
    });
    if (!result.removed) {
      continue;
    }

    for (let resultIndex = 0; resultIndex < result.removedAllocationIds.length; resultIndex += 1) {
      const allocationId = result.removedAllocationIds[resultIndex];
      const allocation =
        current.allocations.find((entry) => entry.allocationId === allocationId && entry.status === 'ACTIVE') || null;
      if (allocation) {
        collectReleasedFeet(allocation);
      }
    }

    removedJobNumbers.add(result.detail.summary.jobNumber);
    jobNumbersSyncedFromDetail.add(result.detail.summary.jobNumber);
    queryClient.setQueryData<JobDetail>(queryKey, result.detail);
    syncJobSummaryCachesFromDetail(queryClient, result.detail, { syncAllocationJobDetail: true });
  }

  const allocationJobQueries = queryClient.getQueriesData<AllocationJobDetail>({
    queryKey: inventoryKeys.allocationJobRoot
  });
  for (let index = 0; index < allocationJobQueries.length; index += 1) {
    const [queryKey, current] = allocationJobQueries[index];
    if (!current) {
      continue;
    }

    const jobNumber = String(current.summary.jobNumber || '').trim();
    if (jobNumber && jobNumbersSyncedFromDetail.has(jobNumber)) {
      continue;
    }

    const nextFilmOrders = current.filmOrders.filter((entry) => entry.filmOrderId !== filmOrderId);
    const removedFilmOrderCount = current.filmOrders.length - nextFilmOrders.length;
    const nextAllocations = current.allocations.filter((entry) => {
      if (entry.filmOrderId === filmOrderId && entry.status === 'ACTIVE') {
        collectReleasedFeet(entry);
        return false;
      }

      return true;
    });
    const removedAllocationCount = current.allocations.length - nextAllocations.length;

    if (!removedFilmOrderCount && !removedAllocationCount) {
      continue;
    }

    removedJobNumbers.add(jobNumber);
    queryClient.setQueryData<AllocationJobDetail>(queryKey, {
      ...current,
      summary: buildAllocationJobSummaryFromAllocations(current.summary, nextAllocations, nextFilmOrders),
      allocations: nextAllocations,
      filmOrders: nextFilmOrders
    });

    queryClient.setQueryData<AllocationJobSummary[] | undefined>(inventoryKeys.allocationJobs, (summaryCurrent) =>
      summaryCurrent
        ? summaryCurrent.map((entry) =>
            entry.jobNumber === jobNumber
              ? buildAllocationJobSummaryFromAllocations(entry, nextAllocations, nextFilmOrders)
              : entry
          )
        : summaryCurrent
    );
  }

  const normalizedFallbackJobNumber = String(options.jobNumber || '').trim();
  if (normalizedFallbackJobNumber && !jobNumbersSyncedFromDetail.has(normalizedFallbackJobNumber)) {
    const jobsQueries = queryClient.getQueriesData<JobListEntry[]>({ queryKey: inventoryKeys.jobs });
    for (let index = 0; index < jobsQueries.length; index += 1) {
      const [queryKey, current] = jobsQueries[index];
      if (!current) {
        continue;
      }

      queryClient.setQueryData<JobListEntry[]>(
        queryKey,
        current.map((entry) =>
          entry.jobNumber === normalizedFallbackJobNumber
            ? {
                ...entry,
                filmOrderCount: Math.max(entry.filmOrderCount - 1, 0),
                updatedAt: resolvedAt
              }
            : entry
        )
      );
    }

    queryClient.setQueryData<AllocationJobSummary[] | undefined>(inventoryKeys.allocationJobs, (current) =>
      current
        ? current.map((entry) =>
            entry.jobNumber === normalizedFallbackJobNumber
              ? {
                  ...entry,
                  openFilmOrderCount: Math.max(entry.openFilmOrderCount - 1, 0)
                }
              : entry
          )
        : current
    );
  }

  const allocationQueries = queryClient.getQueriesData<AllocationEntry[]>({
    queryKey: inventoryKeys.allocationsRoot
  });
  for (let index = 0; index < allocationQueries.length; index += 1) {
    const [queryKey, current] = allocationQueries[index];
    if (!current) {
      continue;
    }

    let didChange = false;
    const nextAllocations = current.map((entry) => {
      if (entry.filmOrderId !== filmOrderId || entry.status !== 'ACTIVE') {
        return entry;
      }

      didChange = true;
      collectReleasedFeet(entry);
      return {
        ...entry,
        status: 'CANCELLED' as const,
        resolvedAt,
        resolvedBy: 'Pending...',
        notes: reason
      };
    });

    if (didChange) {
      queryClient.setQueryData<AllocationEntry[]>(queryKey, nextAllocations);
    }
  }

  const releasedBoxIds = Object.keys(releasedFeetByBoxId);
  for (let index = 0; index < releasedBoxIds.length; index += 1) {
    const boxId = releasedBoxIds[index];
    const releasedFeet = Math.max(0, Number(releasedFeetByBoxId[boxId] || 0));
    if (releasedFeet <= 0) {
      continue;
    }

    updateBoxCaches(queryClient, boxId, (box) => {
      if (box.status === 'ZEROED' || box.status === 'RETIRED') {
        return box;
      }

      return releasePlanningAllocationFromCachedBox(box, releasedFeet);
    });
  }

  return {
    removedJobNumbers: Array.from(removedJobNumbers).filter(Boolean),
    releasedBoxIds
  };
}
