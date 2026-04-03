import type { QueryClient } from '@tanstack/react-query';
import type { OptimisticOperationController } from '../../../components/OptimisticQueue';
import type {
  AddBoxPayload,
  AllocationEntry,
  AllocationJobDetail,
  AllocationJobDetailEntry,
  AllocationJobSummary,
  Box,
  CaulkProductEntry,
  CreateFilmOrderPayload,
  CreateJobPayload,
  FilmOrderEntry,
  JobCaulkRequirementLine,
  JobDetail,
  JobListEntry,
  JobRequirementLine
} from '../../../domain';
import { WAREHOUSE_CODES } from '../../../domain';
import { inventoryKeys } from './inventoryQueryKeys';

// Purpose: Shared optimistic mutation and cache helper utilities for inventory hooks.
export interface QuerySnapshot {
  queryKey: readonly unknown[];
  data: unknown;
}

export interface MutationOptimisticContext {
  operation?: OptimisticOperationController;
  snapshots: QuerySnapshot[];
  deletedBox?: Box;
  pendingFilmOrderId?: string;
}

export function captureSnapshots(queryClient: QueryClient, queryKey: readonly unknown[]) {
  return queryClient
    .getQueriesData({ queryKey })
    .map(([key, data]) => ({ queryKey: key, data }));
}

export function restoreSnapshots(
  queryClient: QueryClient,
  snapshots: QuerySnapshot[] | undefined
) {
  if (!snapshots) {
    return;
  }

  for (let index = 0; index < snapshots.length; index += 1) {
    queryClient.setQueryData(snapshots[index].queryKey, snapshots[index].data);
  }
}

export function updateBoxCaches(
  queryClient: QueryClient,
  boxId: string,
  updater: (box: Box) => Box
) {
  queryClient.setQueryData<Box | undefined>(inventoryKeys.box(boxId), (current) =>
    current ? updater(current) : current
  );

  const listQueries = queryClient.getQueriesData<Box[]>({ queryKey: inventoryKeys.listRoot });
  for (let index = 0; index < listQueries.length; index += 1) {
    const [queryKey, current] = listQueries[index];
    if (!current) {
      continue;
    }

    queryClient.setQueryData<Box[]>(
      queryKey,
      current.map((box) => (box.boxId === boxId ? updater(box) : box))
    );
  }
}

export function removeBoxCaches(queryClient: QueryClient, boxId: string) {
  queryClient.setQueryData<Box | undefined>(inventoryKeys.box(boxId), undefined);

  const listQueries = queryClient.getQueriesData<Box[]>({ queryKey: inventoryKeys.listRoot });
  for (let index = 0; index < listQueries.length; index += 1) {
    const [queryKey, current] = listQueries[index];
    if (!current) {
      continue;
    }

    queryClient.setQueryData<Box[]>(
      queryKey,
      current.filter((box) => box.boxId !== boxId)
    );
  }
}

export function beginDelayedOptimisticMutation(
  queryClient: QueryClient,
  _optimisticQueue: { begin: (label: string, apply: () => void) => OptimisticOperationController },
  _label: string,
  snapshotKeys: readonly (readonly unknown[])[],
  apply: () => void
): MutationOptimisticContext {
  const snapshots = snapshotKeys.flatMap((queryKey) => captureSnapshots(queryClient, queryKey));
  apply();

  return {
    snapshots
  };
}

export function beginImmediateOptimisticMutation(
  queryClient: QueryClient,
  snapshotKeys: readonly (readonly unknown[])[],
  apply: () => void
): MutationOptimisticContext {
  const snapshots = snapshotKeys.flatMap((queryKey) => captureSnapshots(queryClient, queryKey));
  apply();

  return {
    snapshots
  };
}

export function createOptimisticBoxFromAddPayload(payload: AddBoxPayload): Box {
  const isReceived = Boolean(payload.receivedDate);

  return {
    boxId: payload.boxId,
    warehouse: payload.warehouse || WAREHOUSE_CODES[0],
    manufacturer: payload.manufacturer,
    filmName: payload.filmName,
    widthIn: payload.widthIn,
    initialFeet: payload.initialFeet,
    feetAvailable: payload.feetAvailable,
    lotRun: payload.lotRun || '',
    status: isReceived ? 'IN_STOCK' : 'ORDERED',
    orderDate: payload.orderDate,
    receivedDate: payload.receivedDate,
    initialWeightLbs: payload.initialWeightLbs ?? null,
    lastRollWeightLbs: payload.lastRollWeightLbs ?? null,
    lastWeighedDate: payload.lastWeighedDate || '',
    filmKey: payload.filmKey || '',
    coreType: payload.coreType || '',
    coreWeightLbs: payload.coreWeightLbs ?? null,
    lfWeightLbsPerFt: payload.lfWeightLbsPerFt ?? null,
    pricePerLf: payload.pricePerLf ?? null,
    purchaseCost: payload.purchaseCost ?? null,
    notes: payload.notes || '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: ''
  };
}

function makePendingId(prefix: string) {
  return `pending-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function computeOptimisticJobStatus(
  requiredFeet: number,
  requiredTubes: number,
  filmOrderCount = 0,
  isLaborOnly = false
): JobListEntry['status'] {
  if (filmOrderCount > 0) {
    return 'FILM_ORDER';
  }

  if (isLaborOnly && requiredFeet <= 0 && requiredTubes <= 0) {
    return 'READY';
  }

  return 'ALLOCATE';
}

function buildOptimisticJobRequirements(
  requirements: CreateJobPayload['requirements']
): JobRequirementLine[] {
  return (requirements || []).map((entry, index) => ({
    requirementId: `pending-film-req-${index + 1}`,
    manufacturer: entry.manufacturer,
    filmName: entry.filmName,
    widthIn: entry.widthIn,
    requiredFeet: entry.requiredFeet,
    allocatedFeet: 0,
    remainingFeet: entry.requiredFeet
  }));
}

function buildCaulkProductLookup(entries: CaulkProductEntry[]) {
  return Object.fromEntries(entries.map((entry) => [entry.productId, entry])) as Record<
    string,
    CaulkProductEntry
  >;
}

function buildOptimisticJobCaulkRequirements(
  jobNumber: string,
  requirements: CreateJobPayload['caulkRequirements'],
  caulkProducts: CaulkProductEntry[],
  updatedAt: string
): JobCaulkRequirementLine[] {
  const caulkProductLookup = buildCaulkProductLookup(caulkProducts);

  return (requirements || []).map((entry, index) => {
    const product = caulkProductLookup[entry.productId];
    return {
      requirementId: entry.requirementId || `pending-caulk-req-${index + 1}`,
      jobNumber,
      productId: entry.productId,
      manufacturerId: product?.manufacturerId || '',
      manufacturer: product?.manufacturer || '',
      productName: product?.productName || '',
      productCode: product?.productCode || '',
      tubesPerCase: product?.tubesPerCase || 0,
      requiredTubes: entry.requiredTubes,
      allocatedTubes: 0,
      remainingTubes: entry.requiredTubes,
      notes: '',
      updatedAt
    };
  });
}

export function createOptimisticJobDetailFromCreatePayload(
  payload: CreateJobPayload,
  caulkProducts: CaulkProductEntry[] = []
): JobDetail {
  const createdAt = new Date().toISOString();
  const requirements = buildOptimisticJobRequirements(payload.requirements);
  const caulkRequirements = buildOptimisticJobCaulkRequirements(
    payload.jobNumber,
    payload.caulkRequirements,
    caulkProducts,
    createdAt
  );
  const requiredFeet = requirements.reduce((sum, entry) => sum + entry.requiredFeet, 0);
  const requiredTubes = caulkRequirements.reduce((sum, entry) => sum + entry.requiredTubes, 0);

  return {
    summary: {
      jobNumber: payload.jobNumber,
      warehouse: payload.warehouse || WAREHOUSE_CODES[0],
      sections:
        payload.sections === null || payload.sections === undefined || payload.sections === ''
          ? null
          : String(payload.sections),
      dueDate: payload.dueDate || '',
      crewLeader: payload.crewLeader || '',
      status: computeOptimisticJobStatus(requiredFeet, requiredTubes, 0, Boolean(payload.isLaborOnly)),
      lifecycleStatus: payload.lifecycleStatus || 'ACTIVE',
      isLaborOnly: Boolean(payload.isLaborOnly),
      isStagedForPickup: Boolean(payload.isLaborOnly),
      requiredFeet,
      allocatedFeet: 0,
      remainingFeet: requiredFeet,
      requiredTubes,
      allocatedTubes: 0,
      remainingTubes: requiredTubes,
      requirementCount: requirements.length,
      allocationCount: 0,
      filmOrderCount: 0,
      createdAt,
      updatedAt: createdAt,
      notes: payload.notes || ''
    },
    requirements,
    allocations: [],
    usage: [],
    usageTimeline: [],
    caulkRequirements,
    caulkAllocations: [],
    caulkCheckouts: [],
    filmOrders: []
  };
}

export function createOptimisticAllocationJobSummaryFromJobDetail(
  detail: JobDetail
): AllocationJobSummary {
  const activeAllocatedFeet = detail.allocations.reduce(
    (sum, entry) => (entry.status === 'ACTIVE' ? sum + entry.allocatedFeet : sum),
    0
  );
  const fulfilledAllocatedFeet = detail.allocations.reduce(
    (sum, entry) => (entry.status === 'FULFILLED' ? sum + entry.allocatedFeet : sum),
    0
  );
  const openFilmOrderCount = detail.filmOrders.reduce((sum, entry) => {
    if (entry.status === 'FILM_ORDER' || entry.status === 'FILM_ON_THE_WAY') {
      return sum + 1;
    }

    return sum;
  }, 0);

  return {
    jobNumber: detail.summary.jobNumber,
    jobDate: detail.summary.dueDate,
    crewLeader: detail.summary.crewLeader,
    status: detail.summary.status,
    activeAllocatedFeet,
    fulfilledAllocatedFeet,
    requiredTubes: detail.summary.requiredTubes,
    allocatedTubes: detail.summary.allocatedTubes,
    remainingTubes: detail.summary.remainingTubes,
    openFilmOrderCount,
    boxCount: new Set(detail.allocations.map((entry) => entry.boxId).filter(Boolean)).size
  };
}

function buildAllocationJobSummaryFromJobDetail(
  detail: JobDetail,
  currentSummary?: AllocationJobSummary
): AllocationJobSummary {
  const derivedSummary = createOptimisticAllocationJobSummaryFromJobDetail(detail);

  return {
    ...(currentSummary || derivedSummary),
    ...derivedSummary
  };
}

function normalizeRequirementFilmKey(manufacturer: string, filmName: string) {
  return `${manufacturer.trim().toUpperCase()}|${filmName.trim().toUpperCase()}`;
}

function shouldIgnoreOptimisticAllocationCoverage(allocation: AllocationJobDetailEntry) {
  if (allocation.status !== 'ACTIVE') {
    return false;
  }

  return allocation.boxStatus === 'ZEROED' || allocation.boxStatus === 'RETIRED';
}

function rebuildRequirementCoverage(
  requirements: JobRequirementLine[],
  allocations: AllocationJobDetailEntry[]
) {
  const grouped: Record<
    string,
    {
      requirements: Array<{
        requirementId: string;
        widthIn: number;
        requiredFeet: number;
        index: number;
      }>;
      pools: Array<{
        widthIn: number;
        remainingFeet: number;
      }>;
    }
  > = {};
  const coverageByRequirementId: Record<string, number> = {};

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const groupKey = normalizeRequirementFilmKey(requirement.manufacturer, requirement.filmName);
    if (!grouped[groupKey]) {
      grouped[groupKey] = {
        requirements: [],
        pools: []
      };
    }

    grouped[groupKey].requirements.push({
      requirementId: requirement.requirementId,
      widthIn: Number(requirement.widthIn) || 0,
      requiredFeet: Math.max(0, Number(requirement.requiredFeet || 0)),
      index
    });
  }

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    if (
      allocation.status === 'CANCELLED' ||
      allocation.allocatedFeet <= 0 ||
      allocation.allocationKind === 'EXTRA' ||
      shouldIgnoreOptimisticAllocationCoverage(allocation)
    ) {
      continue;
    }

    const groupKey = normalizeRequirementFilmKey(allocation.manufacturer, allocation.filmName);
    if (!grouped[groupKey]) {
      grouped[groupKey] = {
        requirements: [],
        pools: []
      };
    }

    grouped[groupKey].pools.push({
      widthIn: Number(allocation.widthIn) || 0,
      remainingFeet: Math.max(0, Number(allocation.allocatedFeet || 0))
    });
  }

  const groupedValues = Object.values(grouped);
  for (let groupIndex = 0; groupIndex < groupedValues.length; groupIndex += 1) {
    const group = groupedValues[groupIndex];
    group.requirements.sort((left, right) => {
      if (left.widthIn !== right.widthIn) {
        return right.widthIn - left.widthIn;
      }

      return left.index - right.index;
    });
    group.pools.sort((left, right) => left.widthIn - right.widthIn);

    for (let requirementIndex = 0; requirementIndex < group.requirements.length; requirementIndex += 1) {
      const requirement = group.requirements[requirementIndex];
      let remainingNeed = requirement.requiredFeet;

      for (let poolIndex = 0; poolIndex < group.pools.length && remainingNeed > 0; poolIndex += 1) {
        const pool = group.pools[poolIndex];
        if (pool.remainingFeet <= 0 || pool.widthIn < requirement.widthIn) {
          continue;
        }

        const assignedFeet = Math.min(pool.remainingFeet, remainingNeed);
        pool.remainingFeet -= assignedFeet;
        remainingNeed -= assignedFeet;
      }

      coverageByRequirementId[requirement.requirementId] = Math.max(
        0,
        requirement.requiredFeet - remainingNeed
      );
    }
  }

  return requirements.map((requirement) => {
    const requiredFeet = Math.max(0, Number(requirement.requiredFeet || 0));
    const allocatedFeet = Math.min(
      requiredFeet,
      Math.max(0, Number(coverageByRequirementId[requirement.requirementId] || 0))
    );
    const remainingFeet = Math.max(0, requiredFeet - allocatedFeet);

    return {
      ...requirement,
      allocatedFeet,
      remainingFeet
    };
  });
}

function computeOptimisticExistingJobStatus(
  detail: JobDetail,
  nextRequirements: JobRequirementLine[]
) {
  const lifecycleStatus = detail.summary.lifecycleStatus;
  if (lifecycleStatus === 'CANCELLED') {
    return 'CANCELLED' as const;
  }

  if (lifecycleStatus === 'COMPLETED') {
    return 'COMPLETED' as const;
  }

  const hasMaterialRequirements =
    nextRequirements.some((entry) => entry.requiredFeet > 0) ||
    detail.caulkRequirements.some((entry) => entry.requiredTubes > 0);
  if (!hasMaterialRequirements) {
    return 'READY' as const;
  }

  const hasRemainingFilm = nextRequirements.some((entry) => entry.remainingFeet > 0);
  const hasRemainingCaulk = detail.caulkRequirements.some((entry) => entry.remainingTubes > 0);
  if (!hasRemainingFilm && !hasRemainingCaulk) {
    return 'READY' as const;
  }

  if (detail.filmOrders.some((entry) => entry.status === 'FILM_ORDER')) {
    return 'FILM_ORDER' as const;
  }

  if (detail.filmOrders.some((entry) => entry.status === 'FILM_ON_THE_WAY')) {
    return 'ON_ORDER' as const;
  }

  return 'ALLOCATE';
}

export function createOptimisticJobDetailAfterAllocationRemoval(
  detail: JobDetail,
  allocationId: string
) {
  const removedAllocation =
    detail.allocations.find((entry) => entry.allocationId === allocationId) || null;
  if (!removedAllocation) {
    return {
      detail,
      removedAllocation: null
    };
  }

  const nextAllocations = detail.allocations.filter((entry) => entry.allocationId !== allocationId);
  const nextRequirements = rebuildRequirementCoverage(detail.requirements, nextAllocations);
  const requiredFeet = nextRequirements.reduce((sum, entry) => sum + entry.requiredFeet, 0);
  const allocatedFeet = nextRequirements.reduce((sum, entry) => sum + entry.allocatedFeet, 0);
  const remainingFeet = nextRequirements.reduce((sum, entry) => sum + entry.remainingFeet, 0);

  return {
    detail: {
      ...detail,
      summary: {
        ...detail.summary,
        status: computeOptimisticExistingJobStatus(detail, nextRequirements),
        requiredFeet,
        allocatedFeet,
        remainingFeet,
        allocationCount: nextAllocations.length
      },
      requirements: nextRequirements,
      allocations: nextAllocations
    },
    removedAllocation
  };
}

export function applyOptimisticAllocationRemovalToCaches(
  queryClient: QueryClient,
  jobNumber: string,
  allocationId: string
) {
  let removedAllocation: Pick<AllocationEntry, 'allocationId' | 'boxId' | 'allocatedFeet' | 'status'> | null =
    null;
  const currentJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job(jobNumber));

  if (currentJob) {
    const optimisticResult = createOptimisticJobDetailAfterAllocationRemoval(currentJob, allocationId);
    if (optimisticResult.removedAllocation) {
      removedAllocation = {
        allocationId: optimisticResult.removedAllocation.allocationId,
        boxId: optimisticResult.removedAllocation.boxId,
        allocatedFeet: optimisticResult.removedAllocation.allocatedFeet,
        status: optimisticResult.removedAllocation.status
      };
      syncJobDetailCaches(queryClient, optimisticResult.detail, { syncAllocationJobDetail: true });
    }
  }

  queryClient.setQueryData<AllocationJobDetail | undefined>(
    inventoryKeys.allocationJob(jobNumber),
    (current) => {
      if (!current) {
        return current;
      }

      const matched = current.allocations.find((entry) => entry.allocationId === allocationId) || null;
      if (!removedAllocation && matched) {
        removedAllocation = {
          allocationId: matched.allocationId,
          boxId: matched.boxId,
          allocatedFeet: matched.allocatedFeet,
          status: matched.status
        };
      }

      return {
        ...current,
        allocations: current.allocations.filter((entry) => entry.allocationId !== allocationId)
      };
    }
  );

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

    if (!removedAllocation) {
      removedAllocation = {
        allocationId: matched.allocationId,
        boxId: matched.boxId,
        allocatedFeet: matched.allocatedFeet,
        status: matched.status
      };
    }

    queryClient.setQueryData<AllocationEntry[]>(
      queryKey,
      current.filter((entry) => entry.allocationId !== allocationId)
    );
  }

  if (removedAllocation && removedAllocation.status === 'ACTIVE' && removedAllocation.allocatedFeet > 0) {
    const releasedFeet = removedAllocation.allocatedFeet;
    updateBoxCaches(queryClient, removedAllocation.boxId, (box) => {
      if (box.status === 'ZEROED' || box.status === 'RETIRED') {
        return box;
      }

      return {
        ...box,
        feetAvailable: Math.min(
          box.initialFeet,
          Math.max(0, box.feetAvailable + releasedFeet)
        )
      };
    });
  }

  return {
    removedBoxId: removedAllocation?.boxId || ''
  };
}

export function createOptimisticFilmOrderFromPayload(
  payload: CreateFilmOrderPayload
): FilmOrderEntry {
  const createdAt = new Date().toISOString();

  return {
    filmOrderId: makePendingId('film-order'),
    jobNumber: payload.jobNumber,
    warehouse: payload.warehouse,
    manufacturer: payload.manufacturer,
    filmName: payload.filmName,
    widthIn: payload.widthIn,
    requestedFeet: payload.requestedFeet,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: payload.requestedFeet,
    jobDate: '',
    crewLeader: '',
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

function extractLifecycleFilterFromQueryKey(queryKey: readonly unknown[]) {
  const queryParams =
    Array.isArray(queryKey) && queryKey.length > 0
      ? (queryKey[queryKey.length - 1] as { lifecycleStatus?: string } | undefined)
      : undefined;

  return String(queryParams?.lifecycleStatus || '').toUpperCase();
}

export function upsertJobListCaches(queryClient: QueryClient, entry: JobListEntry) {
  const jobQueries = queryClient.getQueriesData<JobListEntry[]>({
    queryKey: inventoryKeys.jobsListRoot
  });
  for (let index = 0; index < jobQueries.length; index += 1) {
    const [queryKey, current] = jobQueries[index];
    if (!current) {
      continue;
    }

    const lifecycleFilter = extractLifecycleFilterFromQueryKey(queryKey);
    if (lifecycleFilter && lifecycleFilter !== entry.lifecycleStatus) {
      queryClient.setQueryData<JobListEntry[]>(
        queryKey,
        current.filter((job) => job.jobNumber !== entry.jobNumber)
      );
      continue;
    }

    const existingIndex = current.findIndex((job) => job.jobNumber === entry.jobNumber);
    const next =
      existingIndex === -1
        ? [entry, ...current]
        : current.map((job) => (job.jobNumber === entry.jobNumber ? entry : job));
    queryClient.setQueryData<JobListEntry[]>(queryKey, next);
  }
}

export function upsertJobsCalendarCaches(queryClient: QueryClient, entry: JobListEntry) {
  const calendarQueries = queryClient.getQueriesData<JobListEntry[]>({
    queryKey: inventoryKeys.jobsCalendarRoot
  });

  for (let index = 0; index < calendarQueries.length; index += 1) {
    const [queryKey, current] = calendarQueries[index];
    if (!current) {
      continue;
    }

    const lifecycleFilter = extractLifecycleFilterFromQueryKey(queryKey);
    if (lifecycleFilter && lifecycleFilter !== entry.lifecycleStatus) {
      queryClient.setQueryData<JobListEntry[]>(
        queryKey,
        current.filter((job) => job.jobNumber !== entry.jobNumber)
      );
      continue;
    }

    const hasExistingEntry = current.some((job) => job.jobNumber === entry.jobNumber);
    if (!hasExistingEntry) {
      continue;
    }

    queryClient.setQueryData<JobListEntry[]>(
      queryKey,
      current.map((job) => (job.jobNumber === entry.jobNumber ? entry : job))
    );
  }
}

export function removeJobListCaches(queryClient: QueryClient, jobNumber: string) {
  const jobQueries = queryClient.getQueriesData<JobListEntry[]>({
    queryKey: inventoryKeys.jobsListRoot
  });
  for (let index = 0; index < jobQueries.length; index += 1) {
    const [queryKey, current] = jobQueries[index];
    if (!current) {
      continue;
    }

    queryClient.setQueryData<JobListEntry[]>(
      queryKey,
      current.filter((entry) => entry.jobNumber !== jobNumber)
    );
  }
}

export function removeJobsCalendarCaches(queryClient: QueryClient, jobNumber: string) {
  const calendarQueries = queryClient.getQueriesData<JobListEntry[]>({
    queryKey: inventoryKeys.jobsCalendarRoot
  });

  for (let index = 0; index < calendarQueries.length; index += 1) {
    const [queryKey, current] = calendarQueries[index];
    if (!current) {
      continue;
    }

    queryClient.setQueryData<JobListEntry[]>(
      queryKey,
      current.filter((entry) => entry.jobNumber !== jobNumber)
    );
  }
}

export function removeJobsSearchCaches(queryClient: QueryClient, jobNumber: string) {
  const searchQueries = queryClient.getQueriesData<JobListEntry[]>({
    queryKey: inventoryKeys.jobsSearch
  });

  for (let index = 0; index < searchQueries.length; index += 1) {
    const [queryKey, current] = searchQueries[index];
    if (!current) {
      continue;
    }

    queryClient.setQueryData<JobListEntry[]>(
      queryKey,
      current.filter((entry) => entry.jobNumber !== jobNumber)
    );
  }
}

export function removeJobPlanningCaches(queryClient: QueryClient, jobNumber: string) {
  removeJobListCaches(queryClient, jobNumber);
  removeJobsCalendarCaches(queryClient, jobNumber);
  removeJobsSearchCaches(queryClient, jobNumber);
  removeAllocationJobSummaryCaches(queryClient, jobNumber);
  queryClient.removeQueries({ queryKey: inventoryKeys.job(jobNumber), exact: true });
  queryClient.removeQueries({ queryKey: inventoryKeys.allocationJob(jobNumber), exact: true });
  queryClient.setQueryData<FilmOrderEntry[] | undefined>(inventoryKeys.filmOrders, (current) =>
    current ? current.filter((entry) => entry.jobNumber !== jobNumber) : current
  );
}

export function upsertAllocationJobSummaryCaches(
  queryClient: QueryClient,
  entry: AllocationJobSummary
) {
  queryClient.setQueryData<AllocationJobSummary[] | undefined>(inventoryKeys.allocationJobs, (current) => {
    if (!current) {
      return current;
    }

    const existingIndex = current.findIndex((job) => job.jobNumber === entry.jobNumber);
    if (existingIndex === -1) {
      return [entry, ...current];
    }

    return current.map((job) => (job.jobNumber === entry.jobNumber ? entry : job));
  });
}

export function removeAllocationJobSummaryCaches(queryClient: QueryClient, jobNumber: string) {
  queryClient.setQueryData<AllocationJobSummary[] | undefined>(inventoryKeys.allocationJobs, (current) =>
    current ? current.filter((entry) => entry.jobNumber !== jobNumber) : current
  );
}

export function syncJobDetailCaches(
  queryClient: QueryClient,
  detail: JobDetail,
  options: { syncAllocationJobDetail?: boolean } = {}
) {
  const jobNumber = detail.summary.jobNumber;
  const currentAllocationJob = queryClient.getQueryData<AllocationJobDetail>(
    inventoryKeys.allocationJob(jobNumber)
  );
  const nextAllocationSummary = buildAllocationJobSummaryFromJobDetail(
    detail,
    currentAllocationJob?.summary
  );

  queryClient.setQueryData<JobDetail>(inventoryKeys.job(jobNumber), detail);
  upsertJobListCaches(queryClient, detail.summary);
  upsertJobsCalendarCaches(queryClient, detail.summary);
  upsertAllocationJobSummaryCaches(queryClient, nextAllocationSummary);

  if (!options.syncAllocationJobDetail) {
    return;
  }

  queryClient.setQueryData<AllocationJobDetail | undefined>(
    inventoryKeys.allocationJob(jobNumber),
    (current) =>
      current
        ? {
            ...current,
            summary: buildAllocationJobSummaryFromJobDetail(detail, current.summary),
            caulkRequirements: detail.caulkRequirements,
            filmOrders: detail.filmOrders
          }
        : current
  );
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
