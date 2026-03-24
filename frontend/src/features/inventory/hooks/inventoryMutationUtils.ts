import type { QueryClient } from '@tanstack/react-query';
import type { OptimisticOperationController } from '../../../components/OptimisticQueue';
import type {
  AddBoxPayload,
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

function computeOptimisticJobStatus(
  requiredFeet: number,
  requiredTubes: number,
  filmOrderCount = 0
): JobListEntry['status'] {
  if (filmOrderCount > 0) {
    return 'FILM_ORDER';
  }

  return requiredFeet > 0 || requiredTubes > 0 ? 'ALLOCATE' : 'READY';
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
      status: computeOptimisticJobStatus(requiredFeet, requiredTubes),
      lifecycleStatus: payload.lifecycleStatus || 'ACTIVE',
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
  return {
    jobNumber: detail.summary.jobNumber,
    jobDate: detail.summary.dueDate,
    crewLeader: detail.summary.crewLeader,
    status: detail.summary.status,
    activeAllocatedFeet: 0,
    fulfilledAllocatedFeet: 0,
    requiredTubes: detail.summary.requiredTubes,
    allocatedTubes: detail.summary.allocatedTubes,
    remainingTubes: detail.summary.remainingTubes,
    openFilmOrderCount: detail.summary.filmOrderCount,
    boxCount: 0
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

export function upsertJobListCaches(queryClient: QueryClient, entry: JobListEntry) {
  const jobQueries = queryClient.getQueriesData<JobListEntry[]>({
    queryKey: inventoryKeys.jobsListRoot
  });
  for (let index = 0; index < jobQueries.length; index += 1) {
    const [queryKey, current] = jobQueries[index];
    if (!current) {
      continue;
    }

    const queryParams =
      Array.isArray(queryKey) && queryKey.length > 0
        ? (queryKey[queryKey.length - 1] as { lifecycleStatus?: string } | undefined)
        : undefined;
    const lifecycleFilter = String(queryParams?.lifecycleStatus || '').toUpperCase();
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
