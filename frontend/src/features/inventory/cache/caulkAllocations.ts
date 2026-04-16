import type { QueryClient } from '@tanstack/react-query';
import type {
  AddCaulkJobAllocationPayload,
  CaulkJobAllocationEntry,
  CaulkProductEntry,
  JobDetail,
  UpdateCaulkJobAllocationPayload
} from '../../../domain';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';
import { syncJobDetailCaches } from './jobCacheCollections';
import { createOptimisticJobDetailAfterJobUpdate } from './jobRequirementCoverage';

function makePendingCaulkAllocationId() {
  return `pending-caulk-allocation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function findJobDetailByCaulkAllocationId(queryClient: QueryClient, caulkAllocationId: string) {
  const jobQueries = queryClient.getQueriesData<JobDetail>({ queryKey: inventoryKeys.jobRoot });

  for (let index = 0; index < jobQueries.length; index += 1) {
    const [, current] = jobQueries[index];
    if (
      current?.caulkAllocations.some((entry) => entry.caulkAllocationId === caulkAllocationId)
    ) {
      return current;
    }
  }

  return null;
}

function buildCaulkProductLookup(detail: JobDetail, caulkProducts: CaulkProductEntry[]) {
  const productLookup: Record<string, CaulkProductEntry | CaulkJobAllocationEntry | JobDetail['caulkRequirements'][number]> =
    {};

  for (let index = 0; index < detail.caulkRequirements.length; index += 1) {
    const requirement = detail.caulkRequirements[index];
    productLookup[requirement.productId] = requirement;
  }

  for (let index = 0; index < detail.caulkAllocations.length; index += 1) {
    const allocation = detail.caulkAllocations[index];
    productLookup[allocation.productId] = allocation;
  }

  for (let index = 0; index < caulkProducts.length; index += 1) {
    const product = caulkProducts[index];
    productLookup[product.productId] = product;
  }

  return productLookup;
}

function buildNextJobDetailForCaulkAllocations(
  queryClient: QueryClient,
  detail: JobDetail,
  nextCaulkAllocations: CaulkJobAllocationEntry[]
) {
  const caulkProducts =
    queryClient.getQueryData<CaulkProductEntry[]>(inventoryKeys.caulkProducts) || [];

  return createOptimisticJobDetailAfterJobUpdate(
    {
      ...detail,
      caulkAllocations: nextCaulkAllocations
    },
    {
      jobNumber: detail.summary.jobNumber,
      caulkRequirements: detail.caulkRequirements.map((entry) => ({
        requirementId: entry.requirementId,
        productId: entry.productId,
        requiredTubes: entry.requiredTubes
      }))
    },
    caulkProducts
  );
}

export function applyOptimisticAddCaulkAllocationToCaches(
  queryClient: QueryClient,
  payload: AddCaulkJobAllocationPayload
) {
  const currentJob = queryClient.getQueryData<JobDetail>(inventoryKeys.job(payload.jobNumber));
  if (!currentJob) {
    return {
      pendingCaulkAllocationId: ''
    };
  }

  const caulkProducts =
    queryClient.getQueryData<CaulkProductEntry[]>(inventoryKeys.caulkProducts) || [];
  const productLookup = buildCaulkProductLookup(currentJob, caulkProducts);
  const selectedRequirement =
    currentJob.caulkRequirements.find((entry) => entry.requirementId === payload.requirementId) || null;
  const selectedProduct = productLookup[payload.productId];
  const now = new Date().toISOString();
  const pendingCaulkAllocationId = makePendingCaulkAllocationId();
  const nextAllocation: CaulkJobAllocationEntry = {
    caulkAllocationId: pendingCaulkAllocationId,
    requirementId: selectedRequirement?.requirementId || payload.requirementId || '',
    productId: payload.productId,
    manufacturerId: selectedProduct?.manufacturerId || '',
    manufacturer: selectedProduct?.manufacturer || '',
    productName: selectedProduct?.productName || '',
    productCode: selectedProduct?.productCode || '',
    tubesPerCase: selectedProduct?.tubesPerCase || 0,
    warehouse: payload.warehouse,
    allocatedTubes: payload.allocatedTubes,
    reservedTubesRemaining: payload.allocatedTubes,
    checkedOutTubesTotal: 0,
    returnedUnusedTubesTotal: 0,
    usedTubesTotal: 0,
    overageTubesTotal: 0,
    outstandingCheckoutTubes: 0,
    openCheckoutCount: 0,
    status: 'ACTIVE',
    createdAt: now,
    createdBy: 'Pending...',
    updatedAt: now,
    updatedBy: 'Pending...',
    resolvedAt: '',
    resolvedBy: '',
    notes: payload.notes || ''
  };

  const nextDetail = buildNextJobDetailForCaulkAllocations(queryClient, currentJob, [
    ...currentJob.caulkAllocations,
    nextAllocation
  ]);
  syncJobDetailCaches(queryClient, nextDetail, { syncAllocationJobDetail: true });

  return {
    pendingCaulkAllocationId
  };
}

export function applyOptimisticUpdateCaulkAllocationToCaches(
  queryClient: QueryClient,
  payload: UpdateCaulkJobAllocationPayload
) {
  const currentJob = findJobDetailByCaulkAllocationId(queryClient, payload.caulkAllocationId);
  if (!currentJob) {
    return;
  }

  const caulkProducts =
    queryClient.getQueryData<CaulkProductEntry[]>(inventoryKeys.caulkProducts) || [];
  const productLookup = buildCaulkProductLookup(currentJob, caulkProducts);

  const nextCaulkAllocations = currentJob.caulkAllocations.map((entry) => {
    if (entry.caulkAllocationId !== payload.caulkAllocationId) {
      return entry;
    }

    const nextProductId = payload.productId || entry.productId;
    const nextProduct = productLookup[nextProductId];
    const nextAllocatedTubes = Math.max(0, Number(payload.allocatedTubes ?? entry.allocatedTubes));
    const deltaAllocatedTubes = nextAllocatedTubes - Math.max(0, Number(entry.allocatedTubes || 0));

    return {
      ...entry,
      requirementId:
        payload.productId && payload.productId !== entry.productId ? '' : entry.requirementId,
      productId: nextProductId,
      manufacturerId: nextProduct?.manufacturerId || entry.manufacturerId,
      manufacturer: nextProduct?.manufacturer || entry.manufacturer,
      productName: nextProduct?.productName || entry.productName,
      productCode: nextProduct?.productCode || entry.productCode,
      tubesPerCase: nextProduct?.tubesPerCase || entry.tubesPerCase,
      warehouse: payload.warehouse || entry.warehouse,
      allocatedTubes: nextAllocatedTubes,
      reservedTubesRemaining: Math.max(
        0,
        Math.max(0, Number(entry.reservedTubesRemaining || 0)) + deltaAllocatedTubes
      ),
      updatedAt: new Date().toISOString(),
      updatedBy: 'Pending...',
      notes: payload.notes !== undefined ? payload.notes || '' : entry.notes
    };
  });

  const nextDetail = buildNextJobDetailForCaulkAllocations(
    queryClient,
    currentJob,
    nextCaulkAllocations
  );
  syncJobDetailCaches(queryClient, nextDetail, { syncAllocationJobDetail: true });
}

export function applyOptimisticRemoveCaulkAllocationToCaches(
  queryClient: QueryClient,
  caulkAllocationId: string
) {
  const currentJob = findJobDetailByCaulkAllocationId(queryClient, caulkAllocationId);
  if (!currentJob) {
    return;
  }

  const nextDetail = buildNextJobDetailForCaulkAllocations(
    queryClient,
    currentJob,
    currentJob.caulkAllocations.filter((entry) => entry.caulkAllocationId !== caulkAllocationId)
  );
  syncJobDetailCaches(queryClient, nextDetail, { syncAllocationJobDetail: true });
}

export function replacePendingCaulkAllocationIdInCaches(
  queryClient: QueryClient,
  jobNumber: string,
  pendingCaulkAllocationId: string,
  caulkAllocationId: string
) {
  if (!pendingCaulkAllocationId || !caulkAllocationId) {
    return;
  }

  queryClient.setQueryData<JobDetail | undefined>(inventoryKeys.job(jobNumber), (current) =>
    current
      ? {
          ...current,
          caulkAllocations: current.caulkAllocations.map((entry) =>
            entry.caulkAllocationId === pendingCaulkAllocationId
              ? { ...entry, caulkAllocationId }
              : entry
          )
        }
      : current
  );

  queryClient.setQueryData(inventoryKeys.allocationJob(jobNumber), (current: any) =>
    current
      ? {
          ...current,
          caulkAllocations: current.caulkAllocations.map((entry: CaulkJobAllocationEntry) =>
            entry.caulkAllocationId === pendingCaulkAllocationId
              ? { ...entry, caulkAllocationId }
              : entry
          )
        }
      : current
  );
}
