import type {
  AllocationJobDetailEntry,
  AllocationJobSummary,
  CaulkProductEntry,
  CreateJobPayload,
  FilmOrderEntry,
  JobCaulkRequirementLine,
  JobDetail,
  JobListEntry,
  JobRequirementLine
} from '../../../domain';
import { WAREHOUSE_CODES } from '../../../domain';
import { countUnresolvedFilmOrders } from '../utils/filmOrders';

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
  return Object.fromEntries(entries.map((entry) => [entry.productId, entry])) as Record<string, CaulkProductEntry>;
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

export function getAllocationCoveredFeet(
  allocation: Pick<AllocationJobDetailEntry, 'allocatedFeet' | 'coveredFeet'>
) {
  const coveredFeet = Math.max(0, Number(allocation.coveredFeet || 0));
  if (coveredFeet > 0) {
    return coveredFeet;
  }

  return Math.max(0, Number(allocation.allocatedFeet || 0));
}

export function createOptimisticAllocationJobSummaryFromJobDetail(detail: JobDetail): AllocationJobSummary {
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

export function buildAllocationJobSummaryFromJobDetail(
  detail: JobDetail,
  currentSummary?: AllocationJobSummary
): AllocationJobSummary {
  const derivedSummary = createOptimisticAllocationJobSummaryFromJobDetail(detail);

  return {
    ...(currentSummary || derivedSummary),
    ...derivedSummary
  };
}

export function buildAllocationJobSummaryFromAllocations(
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
