import type { QueryClient } from '@tanstack/react-query';
import type {
  AllocationJobDetail,
  CaulkJobAllocationEntry,
  CaulkJobCheckoutEntry,
  CheckinCaulkJobAllocationPayload,
  CheckoutCaulkJobAllocationPayload,
  JobDetail
} from '../../../domain';
import { WAREHOUSE_CODES } from '../../../domain';
import { todayDateString } from '../../../lib/date';
import { updateBoxCaches } from './boxes';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';

function updateJobDetailQueries<T>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  updater: (current: T) => T
) {
  const queries = queryClient.getQueriesData<T>({ queryKey });
  for (let index = 0; index < queries.length; index += 1) {
    const [currentKey, current] = queries[index];
    if (!current) {
      continue;
    }

    queryClient.setQueryData<T>(currentKey, updater(current));
  }
}

function isCurrentFilmAllocationRow(entry: { status: string; resolvedAt: string }) {
  return entry.status === 'ACTIVE' && !String(entry.resolvedAt || '').trim();
}

export function updateCheckedOutBoxCaches(
  queryClient: QueryClient,
  boxId: string,
  status: 'CHECKED_OUT' | 'IN_STOCK'
) {
  updateJobDetailQueries<JobDetail>(queryClient, inventoryKeys.jobRoot, (current) => ({
    ...current,
    allocations: current.allocations.map((entry) =>
      entry.boxId === boxId
        ? {
            ...entry,
            boxStatus: status,
            checkedOutOnThisJob: status === 'CHECKED_OUT' ? isCurrentFilmAllocationRow(entry) : false
          }
        : entry
    )
  }));

  updateJobDetailQueries<AllocationJobDetail>(queryClient, inventoryKeys.allocationJobRoot, (current) => ({
    ...current,
    allocations: current.allocations.map((entry) =>
      entry.boxId === boxId
        ? {
            ...entry,
            boxStatus: status,
            checkedOutOnThisJob: status === 'CHECKED_OUT' ? isCurrentFilmAllocationRow(entry) : false
          }
        : entry
    )
  }));
}

export function updateCaulkCheckoutCaches(
  queryClient: QueryClient,
  payload: CheckoutCaulkJobAllocationPayload,
  options: {
    checkoutTubes: number;
    notes?: string;
    sourceAllocation?: CaulkJobAllocationEntry | null;
  } | null
) {
  const now = new Date().toISOString();
  const checkoutTubes = options?.checkoutTubes || 0;
  const sourceAllocation = options?.sourceAllocation || null;

  if (checkoutTubes <= 0) {
    return;
  }

  updateJobDetailQueries<JobDetail>(queryClient, inventoryKeys.jobRoot, (current) => ({
    ...current,
    caulkAllocations: current.caulkAllocations.map((entry) =>
      entry.caulkAllocationId === payload.caulkAllocationId
        ? {
            ...entry,
            reservedTubesRemaining: Math.max(entry.reservedTubesRemaining - checkoutTubes, 0),
            checkedOutTubesTotal: entry.checkedOutTubesTotal + checkoutTubes,
            outstandingCheckoutTubes: entry.outstandingCheckoutTubes + checkoutTubes,
            openCheckoutCount: entry.openCheckoutCount + 1
          }
        : entry
    ),
    caulkCheckouts: [
      {
        caulkCheckoutId: `pending-${payload.caulkAllocationId}-${Date.now()}`,
        caulkAllocationId: payload.caulkAllocationId,
        productId: sourceAllocation?.productId || '',
        manufacturerId: sourceAllocation?.manufacturerId || '',
        manufacturer: sourceAllocation?.manufacturer || '',
        productName: sourceAllocation?.productName || '',
        productCode: sourceAllocation?.productCode || '',
        tubesPerCase: sourceAllocation?.tubesPerCase || 0,
        warehouse: sourceAllocation?.warehouse || WAREHOUSE_CODES[0],
        checkoutTubes,
        overageTubes: 0,
        status: 'OPEN',
        checkedOutAt: now,
        checkedOutBy: 'Pending...',
        checkedInAt: '',
        checkedInBy: '',
        unusedTubes: 0,
        usedTubes: 0,
        notes: options?.notes || ''
      },
      ...current.caulkCheckouts
    ]
  }));

  updateJobDetailQueries<AllocationJobDetail>(queryClient, inventoryKeys.allocationJobRoot, (current) => ({
    ...current,
    caulkAllocations: current.caulkAllocations.map((entry) =>
      entry.caulkAllocationId === payload.caulkAllocationId
        ? {
            ...entry,
            reservedTubesRemaining: Math.max(entry.reservedTubesRemaining - checkoutTubes, 0),
            checkedOutTubesTotal: entry.checkedOutTubesTotal + checkoutTubes,
            outstandingCheckoutTubes: entry.outstandingCheckoutTubes + checkoutTubes,
            openCheckoutCount: entry.openCheckoutCount + 1
          }
        : entry
    ),
    caulkCheckouts: [
      {
        caulkCheckoutId: `pending-${payload.caulkAllocationId}-${Date.now()}`,
        caulkAllocationId: payload.caulkAllocationId,
        productId: sourceAllocation?.productId || '',
        manufacturerId: sourceAllocation?.manufacturerId || '',
        manufacturer: sourceAllocation?.manufacturer || '',
        productName: sourceAllocation?.productName || '',
        productCode: sourceAllocation?.productCode || '',
        tubesPerCase: sourceAllocation?.tubesPerCase || 0,
        warehouse: sourceAllocation?.warehouse || WAREHOUSE_CODES[0],
        checkoutTubes,
        overageTubes: 0,
        status: 'OPEN',
        checkedOutAt: now,
        checkedOutBy: 'Pending...',
        checkedInAt: '',
        checkedInBy: '',
        unusedTubes: 0,
        usedTubes: 0,
        notes: options?.notes || ''
      },
      ...current.caulkCheckouts
    ]
  }));
}

export function updateCaulkCheckinCaches(
  queryClient: QueryClient,
  caulkAllocationId: string,
  caulkCheckoutId: string,
  details: {
    checkoutTubes: number;
    unusedLooseTubes: number;
    unusedCases: number;
    notes?: string;
    sourceCheckout?: CaulkJobCheckoutEntry | null;
  }
) {
  const now = new Date().toISOString();
  const tubesPerCase = Math.max(details.sourceCheckout?.tubesPerCase || 0, 0);
  const returnedTubes = details.unusedLooseTubes + details.unusedCases * tubesPerCase;
  const usedTubes = Math.max(details.checkoutTubes - returnedTubes, 0);

  updateJobDetailQueries<JobDetail>(queryClient, inventoryKeys.jobRoot, (current) => ({
    ...current,
    caulkAllocations: current.caulkAllocations.map((entry) =>
      entry.caulkAllocationId === caulkAllocationId
        ? {
            ...entry,
            openCheckoutCount: Math.max(entry.openCheckoutCount - 1, 0),
            outstandingCheckoutTubes: Math.max(entry.outstandingCheckoutTubes - details.checkoutTubes, 0),
            returnedUnusedTubesTotal: entry.returnedUnusedTubesTotal + returnedTubes,
            usedTubesTotal: entry.usedTubesTotal + usedTubes
          }
        : entry
    ),
    caulkCheckouts: current.caulkCheckouts.map((entry) =>
      entry.caulkCheckoutId === caulkCheckoutId
        ? {
            ...entry,
            status: 'CLOSED',
            checkedInAt: now,
            checkedInBy: 'Pending...',
            unusedTubes: returnedTubes,
            usedTubes,
            notes: details.notes || entry.notes
          }
        : entry
    )
  }));

  updateJobDetailQueries<AllocationJobDetail>(queryClient, inventoryKeys.allocationJobRoot, (current) => ({
    ...current,
    caulkAllocations: current.caulkAllocations.map((entry) =>
      entry.caulkAllocationId === caulkAllocationId
        ? {
            ...entry,
            openCheckoutCount: Math.max(entry.openCheckoutCount - 1, 0),
            outstandingCheckoutTubes: Math.max(entry.outstandingCheckoutTubes - details.checkoutTubes, 0),
            returnedUnusedTubesTotal: entry.returnedUnusedTubesTotal + returnedTubes,
            usedTubesTotal: entry.usedTubesTotal + usedTubes
          }
        : entry
    ),
    caulkCheckouts: current.caulkCheckouts.map((entry) =>
      entry.caulkCheckoutId === caulkCheckoutId
        ? {
            ...entry,
            status: 'CLOSED',
            checkedInAt: now,
            checkedInBy: 'Pending...',
            unusedTubes: returnedTubes,
            usedTubes,
            notes: details.notes || entry.notes
          }
        : entry
    )
  }));
}

function buildPendingCaulkCheckoutFromAllocation(
  sourceAllocation: CaulkJobAllocationEntry,
  checkoutTubes: number,
  now: string
): CaulkJobCheckoutEntry {
  return {
    caulkCheckoutId: `pending-${sourceAllocation.caulkAllocationId}-${Date.now()}`,
    caulkAllocationId: sourceAllocation.caulkAllocationId,
    productId: sourceAllocation.productId,
    manufacturerId: sourceAllocation.manufacturerId,
    manufacturer: sourceAllocation.manufacturer,
    productName: sourceAllocation.productName,
    productCode: sourceAllocation.productCode,
    tubesPerCase: sourceAllocation.tubesPerCase,
    warehouse: sourceAllocation.warehouse,
    checkoutTubes,
    overageTubes: 0,
    status: 'OPEN',
    checkedOutAt: now,
    checkedOutBy: 'Pending...',
    checkedInAt: '',
    checkedInBy: '',
    unusedTubes: 0,
    usedTubes: 0,
    notes: 'Pending server confirmation'
  };
}

function applyCheckoutAllToJobDetail(detail: JobDetail): JobDetail {
  const now = new Date().toISOString();
  const nextCaulkCheckouts = [...detail.caulkCheckouts];

  return {
    ...detail,
    allocations: detail.allocations.map((entry) =>
      isCurrentFilmAllocationRow(entry) && entry.boxStatus === 'IN_STOCK' && !entry.checkedOutOnThisJob
        ? {
            ...entry,
            boxStatus: 'CHECKED_OUT' as const,
            checkedOutOnThisJob: true
          }
        : entry
    ),
    caulkAllocations: detail.caulkAllocations.map((entry) => {
      const checkoutTubes = Math.max(0, entry.reservedTubesRemaining);
      const shouldCheckout = entry.status === 'ACTIVE' && checkoutTubes > 0 && entry.openCheckoutCount <= 0;

      if (!shouldCheckout) {
        return entry;
      }

      nextCaulkCheckouts.unshift(buildPendingCaulkCheckoutFromAllocation(entry, checkoutTubes, now));
      return {
        ...entry,
        reservedTubesRemaining: 0,
        checkedOutTubesTotal: entry.checkedOutTubesTotal + checkoutTubes,
        outstandingCheckoutTubes: entry.outstandingCheckoutTubes + checkoutTubes,
        openCheckoutCount: entry.openCheckoutCount + 1
      };
    }),
    caulkCheckouts: nextCaulkCheckouts
  };
}

function applyCheckoutAllToAllocationJobDetail(detail: AllocationJobDetail): AllocationJobDetail {
  const now = new Date().toISOString();
  const nextCaulkCheckouts = [...detail.caulkCheckouts];

  return {
    ...detail,
    allocations: detail.allocations.map((entry) =>
      isCurrentFilmAllocationRow(entry) && entry.boxStatus === 'IN_STOCK' && !entry.checkedOutOnThisJob
        ? {
            ...entry,
            boxStatus: 'CHECKED_OUT' as const,
            checkedOutOnThisJob: true
          }
        : entry
    ),
    caulkAllocations: detail.caulkAllocations.map((entry) => {
      const checkoutTubes = Math.max(0, entry.reservedTubesRemaining);
      const shouldCheckout = entry.status === 'ACTIVE' && checkoutTubes > 0 && entry.openCheckoutCount <= 0;

      if (!shouldCheckout) {
        return entry;
      }

      nextCaulkCheckouts.unshift(buildPendingCaulkCheckoutFromAllocation(entry, checkoutTubes, now));
      return {
        ...entry,
        reservedTubesRemaining: 0,
        checkedOutTubesTotal: entry.checkedOutTubesTotal + checkoutTubes,
        outstandingCheckoutTubes: entry.outstandingCheckoutTubes + checkoutTubes,
        openCheckoutCount: entry.openCheckoutCount + 1
      };
    }),
    caulkCheckouts: nextCaulkCheckouts
  };
}

export function applyCheckoutAllToCaches(queryClient: QueryClient, jobNumber: string) {
  const currentJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job(jobNumber));
  const currentAllocationJob = queryClient.getQueryData<AllocationJobDetail>(inventoryKeys.allocationJob(jobNumber));
  const touchedBoxIds = new Set<string>();
  const today = todayDateString();

  if (currentJob) {
    for (let index = 0; index < currentJob.allocations.length; index += 1) {
      const entry = currentJob.allocations[index];
      if (isCurrentFilmAllocationRow(entry) && entry.boxStatus === 'IN_STOCK' && !entry.checkedOutOnThisJob) {
        touchedBoxIds.add(entry.boxId);
      }
    }

    queryClient.setQueryData<JobDetail>(inventoryKeys.job(jobNumber), applyCheckoutAllToJobDetail(currentJob));
  }

  if (currentAllocationJob) {
    queryClient.setQueryData<AllocationJobDetail>(
      inventoryKeys.allocationJob(jobNumber),
      applyCheckoutAllToAllocationJobDetail(currentAllocationJob)
    );
  }

  touchedBoxIds.forEach((boxId) => {
    updateBoxCaches(queryClient, boxId, (box) => ({
      ...box,
      status: 'CHECKED_OUT',
      hasEverBeenCheckedOut: true,
      lastCheckoutJob: jobNumber,
      lastCheckoutDate: today,
      zeroedDate: '',
      zeroedReason: '',
      zeroedBy: ''
    }));
  });
}
