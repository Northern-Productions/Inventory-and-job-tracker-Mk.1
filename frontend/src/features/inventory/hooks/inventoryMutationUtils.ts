import type { QueryClient } from '@tanstack/react-query';
import type { OptimisticOperationController } from '../../../components/OptimisticQueue';
import type {
  AddBoxPayload,
  AllocationEntry,
  AllocationJobDetail,
  AllocationJobDetailEntry,
  AllocationJobSummary,
  AllocationPreview,
  ApplyAllocationPlanPayload,
  Box,
  CaulkProductEntry,
  CreateFilmOrderPayload,
  CreateJobPayload,
  FilmOrderEntry,
  JobCaulkRequirementLine,
  JobDetail,
  JobListEntry,
  JobRequirementLine,
  SearchBoxesParams,
  UpdateJobPayload
} from '../../../domain';
import { WAREHOUSE_CODES } from '../../../domain';
import { planCoverageAllocation } from '../../../domain/allocationCoverageContract.mjs';
import {
  buildJobPlanningFilmFamilyKey,
  canJobPlanningFilmSatisfyRequirement,
  describeJobPlanningFilm
} from '../utils/jobPlanningFilmIdentity';
import {
  countUnresolvedFilmOrders,
  isUnresolvedFilmOrder
} from '../utils/filmOrders';
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

function normalizeSearchBoxesQueryKeyParams(queryKey: readonly unknown[]) {
  if (!Array.isArray(queryKey) || queryKey.length < 3) {
    return null;
  }

  return (queryKey[2] as Partial<SearchBoxesParams> | undefined) || null;
}

function isLowStockBoxForSearch(box: Box) {
  return box.status === 'IN_STOCK' && box.feetAvailable > 0 && box.feetAvailable < 10;
}

function matchesSearchBoxesParams(box: Box, params: Partial<SearchBoxesParams> | null) {
  if (!params) {
    return true;
  }

  const normalizedWarehouse = String(params.warehouse || '')
    .trim()
    .toUpperCase();
  if (normalizedWarehouse && box.warehouse !== normalizedWarehouse) {
    return false;
  }

  const status = String(params.status || '')
    .trim()
    .toUpperCase();
  if (status && box.status !== status) {
    return false;
  }

  const width = String(params.width || '').trim();
  if (width && String(box.widthIn) !== width) {
    return false;
  }

  const film = String(params.film || '')
    .trim()
    .toLowerCase();
  if (
    film &&
    !box.filmName.toLowerCase().includes(film) &&
    !box.manufacturer.toLowerCase().includes(film) &&
    !box.filmKey.toLowerCase().includes(film)
  ) {
    return false;
  }

  const query = String(params.q || '')
    .trim()
    .toLowerCase();
  if (query) {
    const haystack = [box.boxId, box.manufacturer, box.filmName, box.lotRun, box.filmKey]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(query)) {
      return false;
    }
  }

  if (!params.showRetired && !status && (box.status === 'ZEROED' || box.status === 'RETIRED')) {
    return false;
  }

  return true;
}

function sortBoxesForSearchCache(boxes: Box[], params: Partial<SearchBoxesParams> | null) {
  if (!params?.film) {
    return boxes;
  }

  const lowStock = boxes.filter((box) => isLowStockBoxForSearch(box));
  const remaining = boxes.filter((box) => !lowStock.includes(box));
  lowStock.sort((left, right) =>
    left.feetAvailable !== right.feetAvailable
      ? left.feetAvailable - right.feetAvailable
      : left.boxId < right.boxId
        ? -1
        : left.boxId > right.boxId
          ? 1
          : 0
  );

  return [...lowStock, ...remaining];
}

export function upsertBoxInSearchCaches(queryClient: QueryClient, box: Box) {
  const normalizedBoxId = box.boxId.trim().toUpperCase();
  const listQueries = queryClient.getQueriesData<Box[]>({ queryKey: inventoryKeys.listRoot });

  for (let index = 0; index < listQueries.length; index += 1) {
    const [queryKey, current] = listQueries[index];
    if (!current) {
      continue;
    }

    const params = normalizeSearchBoxesQueryKeyParams(queryKey);
    const nextMatches = matchesSearchBoxesParams(box, params);
    const existingIndex = current.findIndex(
      (entry) => entry.boxId.trim().toUpperCase() === normalizedBoxId
    );

    if (!nextMatches) {
      if (existingIndex === -1) {
        continue;
      }

      queryClient.setQueryData<Box[]>(
        queryKey,
        current.filter((entry) => entry.boxId.trim().toUpperCase() !== normalizedBoxId)
      );
      continue;
    }

    const nextEntries =
      existingIndex === -1
        ? [box, ...current]
        : current.map((entry) =>
            entry.boxId.trim().toUpperCase() === normalizedBoxId ? box : entry
          );

    queryClient.setQueryData<Box[]>(queryKey, sortBoxesForSearchCache(nextEntries, params));
  }
}

function buildOptimisticFilmOrderAfterBoxReceipt(
  entry: FilmOrderEntry,
  box: Pick<Box, 'boxId' | 'initialFeet'>
): FilmOrderEntry {
  if (entry.status === 'CANCELLED' || entry.status === 'FULFILLED') {
    return entry;
  }

  const nextOrderedFeet = Math.max(0, Number(entry.orderedFeet || 0)) + Math.max(0, Number(box.initialFeet || 0));
  const nextRemainingToOrderFeet = Math.max(Math.max(0, Number(entry.requestedFeet || 0)) - nextOrderedFeet, 0);
  const nextStatus = nextOrderedFeet >= Math.max(0, Number(entry.requestedFeet || 0))
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

function createOptimisticJobDetailAfterFilmOrderReceipt(
  detail: JobDetail,
  filmOrderId: string,
  box: Pick<Box, 'boxId' | 'initialFeet'>
) {
  let updated = false;
  const nextFilmOrders = detail.filmOrders.map((entry) => {
    if (entry.filmOrderId !== filmOrderId) {
      return entry;
    }

    updated = true;
    return buildOptimisticFilmOrderAfterBoxReceipt(entry, box);
  });

  if (!updated) {
    return {
      detail,
      updated: false
    };
  }

  return {
    detail: recomputeOptimisticJobDetail({
      ...detail,
      filmOrders: nextFilmOrders,
      summary: {
        ...detail.summary,
        updatedAt: new Date().toISOString()
      }
    }),
    updated: true
  };
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

function makePendingId(prefix: string) {
  return `pending-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function findCachedBoxById(queryClient: QueryClient, boxId: string) {
  const normalizedBoxId = String(boxId || '').trim().toUpperCase();
  if (!normalizedBoxId) {
    return null;
  }

  const directMatch = queryClient.getQueryData<Box>(inventoryKeys.box(normalizedBoxId));
  if (directMatch) {
    return directMatch;
  }

  const listQueries = queryClient.getQueriesData<Box[]>({ queryKey: inventoryKeys.listRoot });
  for (let index = 0; index < listQueries.length; index += 1) {
    const [, current] = listQueries[index];
    const matched = current?.find((entry) => entry.boxId.trim().toUpperCase() === normalizedBoxId) || null;
    if (matched) {
      return matched;
    }
  }

  const searchQueries = queryClient.getQueriesData<Box[]>({
    queryKey: ['inventory', 'search'] as const
  });
  for (let index = 0; index < searchQueries.length; index += 1) {
    const [, current] = searchQueries[index];
    const matched = current?.find((entry) => entry.boxId.trim().toUpperCase() === normalizedBoxId) || null;
    if (matched) {
      return matched;
    }
  }

  return null;
}

function matchesAllocationPreviewPayload(
  candidate: unknown,
  payload: ApplyAllocationPlanPayload
) {
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

function findMatchingAllocationPreview(
  queryClient: QueryClient,
  payload: ApplyAllocationPlanPayload
) {
  const previewQueries = queryClient.getQueriesData<AllocationPreview>({
    queryKey: ['inventory', 'allocation-preview'] as const
  });

  for (let index = 0; index < previewQueries.length; index += 1) {
    const [queryKey, preview] = previewQueries[index];
    if (!preview) {
      continue;
    }

    const previewPayload =
      Array.isArray(queryKey) && queryKey.length >= 3 ? queryKey[2] : null;
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
  const requirementWidthIn =
    Number(payload.requestedWidthIn) || Number(selectedRequirement?.widthIn) || 0;
  let remainingFeet = Math.max(0, Math.floor(Number(payload.requestedFeet || 0)));

  function addOptimisticAllocation(
    boxId: string,
    availableFeet: number,
    options: {
      warehouse?: string;
      widthIn?: number;
      box?: Box | null;
    } = {}
  ) {
    if (availableFeet <= 0 || remainingFeet <= 0) {
      return;
    }

    const box = options.box || findCachedBoxById(queryClient, boxId);
    const warehouse =
      options.warehouse ||
      box?.warehouse ||
      payload.jobWarehouse ||
      detail?.summary.warehouse ||
      WAREHOUSE_CODES[0];
    const widthIn =
      options.widthIn ||
      box?.widthIn ||
      requirementWidthIn ||
      0;
    const nextPlan = planCoverageAllocation(remainingFeet, availableFeet, widthIn, requirementWidthIn);
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
      jobDate: payload.jobDate || '',
      crewLeader: payload.crewLeader || '',
      allocatedFeet: nextAllocatedFeet,
      coveredFeet: nextCoveredFeet,
      requirementId: payload.requirementId,
      allocationKind: 'REQUIREMENT',
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
      jobDate: payload.jobDate || '',
      crewLeader: payload.crewLeader || '',
      allocatedFeet: nextAllocatedFeet,
      coveredFeet: nextCoveredFeet,
      requirementId: payload.requirementId,
      allocationKind: 'REQUIREMENT',
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
      boxStatus: 'IN_STOCK',
      checkedOutOnThisJob: false
    });

    allocatedFeetByBoxId[boxId] = (allocatedFeetByBoxId[boxId] || 0) + nextAllocatedFeet;
    remainingFeet = nextPlan.remainingCoveredFeet;
  }

  if (preview) {
    if (preview.sourceSuggestedFeet > 0) {
      addOptimisticAllocation(preview.sourceBoxId, preview.sourceSuggestedFeet, {
        warehouse: preview.sourceWarehouse,
        widthIn: findCachedBoxById(queryClient, preview.sourceBoxId)?.widthIn || Number(payload.requestedWidthIn) || 0
      });
    }

    for (let index = 0; index < preview.suggestions.length && remainingFeet > 0; index += 1) {
      const suggestion = preview.suggestions[index];
      if (!selectedSuggestionIds.has(suggestion.boxId)) {
        continue;
      }

      addOptimisticAllocation(suggestion.boxId, suggestion.availableFeet, {
        warehouse: suggestion.warehouse,
        widthIn: suggestion.widthIn
      });
    }
  } else {
    const orderedBoxIds = [payload.boxId, ...(payload.selectedSuggestionBoxIds || [])];
    for (let index = 0; index < orderedBoxIds.length && remainingFeet > 0; index += 1) {
      const boxId = orderedBoxIds[index];
      const box = findCachedBoxById(queryClient, boxId);
      addOptimisticAllocation(boxId, Math.max(0, Number(box?.feetAvailable || remainingFeet)), {
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
    (sum, entry) => (entry.status === 'ACTIVE' ? sum + getAllocationCoveredFeet(entry) : sum),
    0
  );
  const fulfilledAllocatedFeet = detail.allocations.reduce(
    (sum, entry) => (entry.status === 'FULFILLED' ? sum + getAllocationCoveredFeet(entry) : sum),
    0
  );
  const openFilmOrderCount = countUnresolvedFilmOrders(detail.filmOrders);

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

function normalizeRequirementFilmFamilyKey(manufacturer: string, filmName: string) {
  return buildJobPlanningFilmFamilyKey(manufacturer, filmName);
}

function isExteriorPlanningFilm(manufacturer: string, filmName: string) {
  return describeJobPlanningFilm(manufacturer, filmName).isExterior;
}

function shouldIgnoreOptimisticAllocationCoverage(allocation: AllocationJobDetailEntry) {
  if (allocation.status !== 'ACTIVE') {
    return false;
  }

  return allocation.boxStatus === 'ZEROED' || allocation.boxStatus === 'RETIRED';
}

function getAllocationCoveredFeet(
  allocation: Pick<AllocationJobDetailEntry, 'allocatedFeet' | 'coveredFeet'>
) {
  const coveredFeet = Math.max(0, Number(allocation.coveredFeet || 0));
  if (coveredFeet > 0) {
    return coveredFeet;
  }

  return Math.max(0, Number(allocation.allocatedFeet || 0));
}

function allocationMatchesRequirement(
  allocation: Pick<AllocationJobDetailEntry, 'manufacturer' | 'filmName' | 'widthIn'>,
  requirement: Pick<JobRequirementLine, 'manufacturer' | 'filmName' | 'widthIn'>
) {
  return (
    canJobPlanningFilmSatisfyRequirement(
      allocation.manufacturer,
      allocation.filmName,
      requirement.manufacturer,
      requirement.filmName
    ) &&
    (Number(allocation.widthIn) || 0) >= (Number(requirement.widthIn) || 0)
  );
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
        isExterior: boolean;
        index: number;
      }>;
      pools: Array<{
        widthIn: number;
        remainingFeet: number;
        isExterior: boolean;
      }>;
    }
  > = {};
  const coverageByRequirementId: Record<string, number> = {};
  const requirementById: Record<string, JobRequirementLine> = {};

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const groupKey = normalizeRequirementFilmFamilyKey(requirement.manufacturer, requirement.filmName);
    requirementById[requirement.requirementId] = requirement;
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
      isExterior: isExteriorPlanningFilm(requirement.manufacturer, requirement.filmName),
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

    const boundRequirementId = String(allocation.requirementId || '').trim();
    const boundRequirement = boundRequirementId ? requirementById[boundRequirementId] : null;
    const coveredFeet = getAllocationCoveredFeet(allocation);
    if (boundRequirement && allocationMatchesRequirement(allocation, boundRequirement)) {
      const nextCoveredFeet = Math.min(
        Math.max(0, Number(boundRequirement.requiredFeet || 0)),
        Math.max(0, Number(coverageByRequirementId[boundRequirementId] || 0)) + coveredFeet
      );
      coverageByRequirementId[boundRequirementId] = nextCoveredFeet;
      continue;
    }

    const groupKey = normalizeRequirementFilmFamilyKey(allocation.manufacturer, allocation.filmName);
    if (!grouped[groupKey]) {
      grouped[groupKey] = {
        requirements: [],
        pools: []
      };
    }

    grouped[groupKey].pools.push({
      widthIn: Number(allocation.widthIn) || 0,
      remainingFeet: coveredFeet,
      isExterior: isExteriorPlanningFilm(allocation.manufacturer, allocation.filmName)
    });
  }

  const groupedValues = Object.values(grouped);
  for (let groupIndex = 0; groupIndex < groupedValues.length; groupIndex += 1) {
    const group = groupedValues[groupIndex];
    group.requirements.sort((left, right) => {
      if (left.isExterior !== right.isExterior) {
        return left.isExterior ? -1 : 1;
      }

      if (left.widthIn !== right.widthIn) {
        return right.widthIn - left.widthIn;
      }

      return left.index - right.index;
    });
    group.pools.sort((left, right) => {
      if (left.isExterior !== right.isExterior) {
        return left.isExterior ? 1 : -1;
      }

      return left.widthIn - right.widthIn;
    });

    for (let requirementIndex = 0; requirementIndex < group.requirements.length; requirementIndex += 1) {
      const requirement = group.requirements[requirementIndex];
      const coveredBeforePools = Math.max(0, Number(coverageByRequirementId[requirement.requirementId] || 0));
      let remainingNeed = Math.max(
        0,
        requirement.requiredFeet - coveredBeforePools
      );

      for (let poolIndex = 0; poolIndex < group.pools.length && remainingNeed > 0; poolIndex += 1) {
        const pool = group.pools[poolIndex];
        if (
          pool.remainingFeet <= 0 ||
          pool.widthIn < requirement.widthIn ||
          (requirement.isExterior && !pool.isExterior)
        ) {
          continue;
        }

        const assignedFeet = Math.min(pool.remainingFeet, remainingNeed);
        pool.remainingFeet -= assignedFeet;
        remainingNeed -= assignedFeet;
      }

      coverageByRequirementId[requirement.requirementId] = Math.min(
        requirement.requiredFeet,
        requirement.requiredFeet - Math.max(0, remainingNeed)
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

function recomputeOptimisticJobDetail(detail: JobDetail): JobDetail {
  const nextRequirements = rebuildRequirementCoverage(detail.requirements, detail.allocations);
  const requiredFeet = nextRequirements.reduce((sum, entry) => sum + entry.requiredFeet, 0);
  const allocatedFeet = nextRequirements.reduce((sum, entry) => sum + entry.allocatedFeet, 0);
  const remainingFeet = nextRequirements.reduce((sum, entry) => sum + entry.remainingFeet, 0);

  return {
    ...detail,
    summary: {
      ...detail.summary,
      status: computeOptimisticExistingJobStatus(detail, nextRequirements),
      requiredFeet,
      allocatedFeet,
      remainingFeet,
      allocationCount: detail.allocations.length,
      filmOrderCount: detail.filmOrders.length
    },
    requirements: nextRequirements
  };
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

  if (detail.filmOrders.some((entry) => isUnresolvedFilmOrder(entry))) {
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

  return {
    detail: recomputeOptimisticJobDetail({
      ...detail,
      allocations: detail.allocations.filter((entry) => entry.allocationId !== allocationId)
    }),
    removedAllocation
  };
}

export function createOptimisticJobDetailAfterAllocationAddition(
  detail: JobDetail,
  addedAllocations: AllocationJobDetailEntry[]
) {
  if (!addedAllocations.length) {
    return detail;
  }

  return recomputeOptimisticJobDetail({
    ...detail,
    allocations: [...detail.allocations, ...addedAllocations]
  });
}

interface OptimisticFilmOrderDeletionOptions {
  filmOrderId: string;
  reason?: string;
  resolvedAt?: string;
}

interface OptimisticFilmOrderDeletionResult {
  removedJobNumbers: string[];
  releasedBoxIds: string[];
}

function buildOptimisticCancelledAllocation<
  T extends Pick<AllocationEntry, 'status' | 'resolvedAt' | 'resolvedBy' | 'notes'>
>(entry: T, resolvedAt: string, reason: string): T {
  return {
    ...entry,
    status: 'CANCELLED',
    resolvedAt,
    resolvedBy: 'Pending...',
    notes: reason || 'Pending server confirmation'
  };
}

function buildAllocationJobSummaryFromAllocations(
  currentSummary: AllocationJobSummary,
  allocations: AllocationJobDetailEntry[],
  filmOrders: FilmOrderEntry[]
): AllocationJobSummary {
  return {
    ...currentSummary,
    activeAllocatedFeet: allocations.reduce(
      (sum, entry) => (entry.status === 'ACTIVE' ? sum + getAllocationCoveredFeet(entry) : sum),
      0
    ),
    fulfilledAllocatedFeet: allocations.reduce(
      (sum, entry) => (entry.status === 'FULFILLED' ? sum + getAllocationCoveredFeet(entry) : sum),
      0
    ),
    openFilmOrderCount: countUnresolvedFilmOrders(filmOrders),
    boxCount: new Set(allocations.map((entry) => entry.boxId).filter(Boolean)).size
  };
}

export function createOptimisticJobDetailAfterFilmOrderDeletion(
  detail: JobDetail,
  options: OptimisticFilmOrderDeletionOptions
) {
  const filmOrderId = String(options.filmOrderId || '').trim();
  if (!filmOrderId) {
    return {
      detail,
      releasedFeetByBoxId: {} as Record<string, number>,
      removedAllocationIds: [] as string[],
      removed: false
    };
  }

  const nextFilmOrders = detail.filmOrders.filter((entry) => entry.filmOrderId !== filmOrderId);
  const removedFilmOrderCount = detail.filmOrders.length - nextFilmOrders.length;
  const linkedActiveAllocations = detail.allocations.filter(
    (entry) => entry.filmOrderId === filmOrderId && entry.status === 'ACTIVE'
  );

  if (!removedFilmOrderCount && !linkedActiveAllocations.length) {
    return {
      detail,
      releasedFeetByBoxId: {} as Record<string, number>,
      removedAllocationIds: [] as string[],
      removed: false
    };
  }

  const releasedFeetByBoxId: Record<string, number> = {};
  for (let index = 0; index < linkedActiveAllocations.length; index += 1) {
    const entry = linkedActiveAllocations[index];
    releasedFeetByBoxId[entry.boxId] =
      Math.max(0, Number(releasedFeetByBoxId[entry.boxId] || 0)) + Math.max(0, Number(entry.allocatedFeet || 0));
  }

  const nextDetail = recomputeOptimisticJobDetail({
    ...detail,
    filmOrders: nextFilmOrders,
    allocations: detail.allocations.filter(
      (entry) => !(entry.filmOrderId === filmOrderId && entry.status === 'ACTIVE')
    ),
    summary: {
      ...detail.summary,
      updatedAt: options.resolvedAt || detail.summary.updatedAt
    }
  });

  return {
    detail: nextDetail,
    releasedFeetByBoxId,
    removedAllocationIds: linkedActiveAllocations.map((entry) => entry.allocationId),
    removed: true
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

export function applyOptimisticFilmOrderDeletionToCaches(
  queryClient: QueryClient,
  options: OptimisticFilmOrderDeletionOptions & { jobNumber?: string }
): OptimisticFilmOrderDeletionResult {
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
      Math.max(0, Number(releasedFeetByBoxId[entry.boxId] || 0)) + Math.max(0, Number(entry.allocatedFeet || 0));
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
      return buildOptimisticCancelledAllocation(entry, resolvedAt, reason);
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

      return {
        ...box,
        feetAvailable: Math.min(box.initialFeet, Math.max(0, box.feetAvailable + releasedFeet))
      };
    });
  }

  return {
    removedJobNumbers: Array.from(removedJobNumbers).filter(Boolean),
    releasedBoxIds
  };
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
    const nextJobDetail = createOptimisticJobDetailAfterAllocationAddition(
      currentJob,
      optimisticRows.jobAllocations
    );
    syncJobDetailCaches(queryClient, nextJobDetail, { syncAllocationJobDetail: true });
  }

  if (!syncedAllocationJobFromDetail) {
    queryClient.setQueryData<AllocationJobDetail | undefined>(
      inventoryKeys.allocationJob(payload.jobNumber),
      (current) => {
        if (!current) {
          return current;
        }

        const nextAllocations = [...current.allocations, ...optimisticRows.jobAllocations];
        return {
          ...current,
          summary: {
            ...current.summary,
            activeAllocatedFeet: nextAllocations.reduce(
              (sum, entry) => (entry.status === 'ACTIVE' ? sum + getAllocationCoveredFeet(entry) : sum),
              0
            ),
            fulfilledAllocatedFeet: nextAllocations.reduce(
              (sum, entry) => (entry.status === 'FULFILLED' ? sum + getAllocationCoveredFeet(entry) : sum),
              0
            ),
            boxCount: new Set(nextAllocations.map((entry) => entry.boxId).filter(Boolean)).size
          },
          allocations: nextAllocations
        };
      }
    );
  }

  for (let index = 0; index < optimisticRows.allocations.length; index += 1) {
    const entry = optimisticRows.allocations[index];
    queryClient.setQueryData<AllocationEntry[] | undefined>(
      inventoryKeys.allocations(entry.boxId),
      (current) => [...(current || []), entry]
    );
  }

  const touchedBoxIds = Object.keys(optimisticRows.allocatedFeetByBoxId);
  for (let index = 0; index < touchedBoxIds.length; index += 1) {
    const boxId = touchedBoxIds[index];
    const allocatedFeet = optimisticRows.allocatedFeetByBoxId[boxId] || 0;
    if (allocatedFeet <= 0) {
      continue;
    }

    updateBoxCaches(queryClient, boxId, (box) => ({
      ...box,
      feetAvailable: Math.max(0, box.feetAvailable - allocatedFeet)
    }));
  }

  return optimisticRows;
}

export function createOptimisticFilmOrderFromPayload(
  payload: CreateFilmOrderPayload,
  scheduleMetadata: { jobDate?: string; crewLeader?: string } = {}
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
    jobDate: String(scheduleMetadata.jobDate || '').trim(),
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
      jobDate: '',
      crewLeader: ''
    };
  }

  const currentJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job(normalizedJobNumber));
  if (currentJob?.summary) {
    return {
      jobDate: String(currentJob.summary.dueDate || '').trim(),
      crewLeader: String(currentJob.summary.crewLeader || '').trim()
    };
  }

  const currentAllocationJob = queryClient.getQueryData<AllocationJobDetail>(
    inventoryKeys.allocationJob(normalizedJobNumber)
  );
  if (currentAllocationJob?.summary) {
    return {
      jobDate: String(currentAllocationJob.summary.jobDate || '').trim(),
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
        jobDate: String(match.dueDate || '').trim(),
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
        jobDate: String(match.jobDate || '').trim(),
        crewLeader: String(match.crewLeader || '').trim()
      };
    }
  }

  return {
    jobDate: '',
    crewLeader: ''
  };
}

function updateCachedJobSummaryCollections(
  queryClient: QueryClient,
  jobNumber: string,
  updater: (entry: JobListEntry) => JobListEntry
) {
  const jobQueries = queryClient.getQueriesData<JobListEntry[]>({
    queryKey: inventoryKeys.jobs
  });

  for (let index = 0; index < jobQueries.length; index += 1) {
    const [queryKey, current] = jobQueries[index];
    if (!Array.isArray(current) || !current.some((entry) => entry.jobNumber === jobNumber)) {
      continue;
    }

    queryClient.setQueryData<JobListEntry[]>(
      queryKey,
      current.map((entry) => (entry.jobNumber === jobNumber ? updater(entry) : entry))
    );
  }
}

export function applyOptimisticJobScheduleSyncToCaches(
  queryClient: QueryClient,
  payload: Pick<UpdateJobPayload, 'jobNumber' | 'dueDate' | 'crewLeader'>
) {
  const normalizedJobNumber = String(payload.jobNumber || '').trim();
  if (!normalizedJobNumber) {
    return;
  }

  const hasDueDateUpdate = payload.dueDate !== undefined;
  const hasCrewLeaderUpdate = payload.crewLeader !== undefined;
  if (!hasDueDateUpdate && !hasCrewLeaderUpdate) {
    return;
  }

  const nextDueDate = hasDueDateUpdate ? String(payload.dueDate || '').trim() : undefined;
  const nextCrewLeader = hasCrewLeaderUpdate ? String(payload.crewLeader || '').trim() : undefined;
  const patchFilmOrder = (entry: FilmOrderEntry): FilmOrderEntry =>
    entry.jobNumber === normalizedJobNumber && isUnresolvedFilmOrder(entry)
      ? {
          ...entry,
          ...(nextDueDate !== undefined ? { jobDate: nextDueDate } : {}),
          ...(nextCrewLeader !== undefined ? { crewLeader: nextCrewLeader } : {})
        }
      : entry;

  const currentJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job(normalizedJobNumber));
  if (currentJob) {
    syncJobDetailCaches(
      queryClient,
      {
        ...currentJob,
        summary: {
          ...currentJob.summary,
          ...(nextDueDate !== undefined ? { dueDate: nextDueDate } : {}),
          ...(nextCrewLeader !== undefined ? { crewLeader: nextCrewLeader } : {})
        },
        filmOrders: currentJob.filmOrders.map(patchFilmOrder)
      },
      { syncAllocationJobDetail: true }
    );
  }

  updateCachedJobSummaryCollections(queryClient, normalizedJobNumber, (entry) => ({
    ...entry,
    ...(nextDueDate !== undefined ? { dueDate: nextDueDate } : {}),
    ...(nextCrewLeader !== undefined ? { crewLeader: nextCrewLeader } : {})
  }));

  queryClient.setQueryData<AllocationJobSummary[] | undefined>(inventoryKeys.allocationJobs, (current) =>
    current
      ? current.map((entry) =>
          entry.jobNumber === normalizedJobNumber
            ? {
                ...entry,
                ...(nextDueDate !== undefined ? { jobDate: nextDueDate } : {}),
                ...(nextCrewLeader !== undefined ? { crewLeader: nextCrewLeader } : {})
              }
            : entry
        )
      : current
  );

  queryClient.setQueryData<AllocationJobDetail | undefined>(
    inventoryKeys.allocationJob(normalizedJobNumber),
    (current) =>
      current
        ? {
            ...current,
            summary: {
              ...current.summary,
              ...(nextDueDate !== undefined ? { jobDate: nextDueDate } : {}),
              ...(nextCrewLeader !== undefined ? { crewLeader: nextCrewLeader } : {})
            },
            filmOrders: current.filmOrders.map(patchFilmOrder)
          }
        : current
  );

  queryClient.setQueryData<FilmOrderEntry[] | undefined>(inventoryKeys.filmOrders, (current) =>
    current ? current.map(patchFilmOrder) : current
  );
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

export function syncJobSummaryCachesFromDetail(
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
            allocations: detail.allocations,
            usage: detail.usage,
            usageTimeline: detail.usageTimeline,
            caulkRequirements: detail.caulkRequirements,
            caulkAllocations: detail.caulkAllocations,
            caulkCheckouts: detail.caulkCheckouts,
            filmOrders: detail.filmOrders
          }
        : current
  );
}

export function syncJobDetailCaches(
  queryClient: QueryClient,
  detail: JobDetail,
  options: { syncAllocationJobDetail?: boolean } = {}
) {
  queryClient.setQueryData<JobDetail>(inventoryKeys.job(detail.summary.jobNumber), detail);
  syncJobSummaryCachesFromDetail(queryClient, detail, options);
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
