import type {
  AllocationJobDetailEntry,
  AllocationJobSummary,
  CaulkProductEntry,
  CreateJobPayload,
  FilmOrderEntry,
  JobCaulkRequirementLine,
  JobDetail,
  JobListEntry,
  JobPhase,
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

  return requiredFeet > 0 || requiredTubes > 0 ? 'FILM_ORDER' : 'READY';
}

function buildOptimisticJobRequirements(
  requirements: CreateJobPayload['requirements']
): JobRequirementLine[] {
  return (requirements || []).map((entry, index) => ({
    requirementId: `pending-film-req-${index + 1}`,
    phaseId: entry.phaseId,
    phaseNumber: entry.phaseNumber,
    manufacturer: entry.manufacturer,
    filmName: entry.filmName,
    widthIn: entry.widthIn,
    requiredFeet: entry.requiredFeet,
    status: 'ACTIVE',
    isComplete: false,
    actualUsedFeet: 0,
    completedAt: '',
    completedBy: '',
    completionResult: '',
    allocatedFeet: 0,
    autoPlanningSuppressed: false,
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
      phaseId: entry.phaseId,
      phaseNumber: entry.phaseNumber,
      productId: entry.productId,
      manufacturerId: product?.manufacturerId || '',
      manufacturer: product?.manufacturer || '',
      productName: product?.productName || '',
      productCode: product?.productCode || '',
      tubesPerCase: product?.tubesPerCase || 0,
      requiredTubes: entry.requiredTubes,
      status: 'ACTIVE',
      isComplete: false,
      actualUsedTubes: 0,
      completedAt: '',
      completedBy: '',
      completionResult: '',
      allocatedTubes: 0,
      remainingTubes: entry.requiredTubes,
      notes: '',
      updatedAt
    };
  });
}

function getPayloadWorkScope(payload: Pick<CreateJobPayload, 'workScope' | 'sections'>) {
  if (payload.workScope !== null && payload.workScope !== undefined && payload.workScope !== '') {
    return String(payload.workScope);
  }
  if (payload.sections !== null && payload.sections !== undefined && payload.sections !== '') {
    return String(payload.sections);
  }
  return null;
}

function getPayloadPhases(payload: CreateJobPayload) {
  if (Array.isArray(payload.phases) && payload.phases.length) {
    return payload.phases.map((phase, index) => ({
      ...phase,
      phaseId: phase.phaseId || `pending-phase-${index + 1}`,
      phaseNumber: Math.max(1, Math.floor(Number(phase.phaseNumber || index + 1))),
      workScope: getPayloadWorkScope(phase),
      sections: getPayloadWorkScope(phase),
      installDate: phase.installDate || '',
      crewLeader: phase.crewLeader || '',
      isPrimary: phase.isPrimary === true || index === 0,
      requirements: (phase.requirements || []).map((entry) => ({
        ...entry,
        phaseId: phase.phaseId || `pending-phase-${index + 1}`,
        phaseNumber: Math.max(1, Math.floor(Number(phase.phaseNumber || index + 1)))
      })),
      caulkRequirements: (phase.caulkRequirements || []).map((entry) => ({
        ...entry,
        phaseId: phase.phaseId || `pending-phase-${index + 1}`,
        phaseNumber: Math.max(1, Math.floor(Number(phase.phaseNumber || index + 1)))
      }))
    }));
  }

  const workScope = getPayloadWorkScope(payload);
  const topLevelPhaseNumber = Math.max(
    1,
    Math.floor(Number((payload as { phaseNumber?: unknown }).phaseNumber || 1))
  );
  return [
    {
      phaseId: 'pending-phase-1',
      phaseNumber: topLevelPhaseNumber,
      workScope,
      sections: workScope,
      installDate: payload.installDate || '',
      crewLeader: payload.crewLeader || '',
      laborStatus: 'ACTIVE' as const,
      isPrimary: true,
      requirements: (payload.requirements || []).map((entry) => ({
        ...entry,
        phaseId: 'pending-phase-1',
        phaseNumber: topLevelPhaseNumber
      })),
      caulkRequirements: (payload.caulkRequirements || []).map((entry) => ({
        ...entry,
        phaseId: 'pending-phase-1',
        phaseNumber: topLevelPhaseNumber
      }))
    }
  ];
}

export function createOptimisticJobDetailFromCreatePayload(
  payload: CreateJobPayload,
  caulkProducts: CaulkProductEntry[] = []
): JobDetail {
  const createdAt = new Date().toISOString();
  const payloadPhases = getPayloadPhases(payload);
  const requirements = buildOptimisticJobRequirements(payloadPhases.flatMap((phase) => phase.requirements || []));
  const caulkRequirements = buildOptimisticJobCaulkRequirements(
    payload.jobNumber,
    payloadPhases.flatMap((phase) => phase.caulkRequirements || []),
    caulkProducts,
    createdAt
  );
  const phases: JobPhase[] = payloadPhases.map((phase, index) => {
    const phaseRequirements = requirements.filter((entry) => entry.phaseId === phase.phaseId);
    const phaseCaulkRequirements = caulkRequirements.filter((entry) => entry.phaseId === phase.phaseId);
    const phaseRequiredFeet = phaseRequirements.reduce((sum, entry) => sum + entry.requiredFeet, 0);
    const phaseRequiredTubes = phaseCaulkRequirements.reduce((sum, entry) => sum + entry.requiredTubes, 0);
    const status = computeOptimisticJobStatus(phaseRequiredFeet, phaseRequiredTubes, 0, !phaseRequiredFeet && !phaseRequiredTubes);
    return {
      phaseId: String(phase.phaseId || `pending-phase-${index + 1}`),
      phaseNumber: phase.phaseNumber,
      workScope: phase.workScope,
      sections: phase.sections,
      installDate: phase.installDate,
      crewLeader: phase.crewLeader,
      laborStatus: phase.laborStatus === 'COMPLETE' ? 'COMPLETE' : 'ACTIVE',
      status,
      isComplete: false,
      isPrimary: phase.isPrimary,
      isNextRelevant: index === 0,
      isExpandedByDefault: index === 0,
      requiredFeet: phaseRequiredFeet,
      allocatedFeet: 0,
      remainingFeet: phaseRequiredFeet,
      requiredTubes: phaseRequiredTubes,
      allocatedTubes: 0,
      remainingTubes: phaseRequiredTubes,
      requirementCount: phaseRequirements.length,
      caulkRequirementCount: phaseCaulkRequirements.length,
      filmOrderCount: 0,
      allocationCount: 0,
      createdAt,
      updatedAt: createdAt
    };
  });
  const requiredFeet = requirements.reduce((sum, entry) => sum + entry.requiredFeet, 0);
  const requiredTubes = caulkRequirements.reduce((sum, entry) => sum + entry.requiredTubes, 0);
  const primaryPhase = phases.find((phase) => phase.isPrimary) || phases[0];

  return {
    summary: {
      jobNumber: payload.jobNumber,
      warehouse: payload.warehouse || WAREHOUSE_CODES[0],
      workScope: primaryPhase?.workScope ?? getPayloadWorkScope(payload),
      sections: primaryPhase?.sections ?? getPayloadWorkScope(payload),
      phaseId: primaryPhase?.phaseId,
      phaseNumber: primaryPhase?.phaseNumber,
      phaseWorkScope: primaryPhase?.workScope,
      phaseCount: phases.length,
      phases,
      installDate: primaryPhase?.installDate || payload.installDate || '',
      crewLeader: primaryPhase?.crewLeader || payload.crewLeader || '',
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
      hasOrderedAllocations: false,
      createdAt,
      updatedAt: createdAt,
      notes: payload.notes || ''
    },
    phases,
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

function hasOrderedAllocations(entries: Array<Pick<AllocationJobDetailEntry, 'status' | 'boxStatus'>>) {
  return entries.some(
    (entry) => entry.status === 'ACTIVE' && String(entry.boxStatus || '').trim().toUpperCase() === 'ORDERED'
  );
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
    jobId: detail.summary.jobId,
    jobNumber: detail.summary.jobNumber,
    installDate: detail.summary.installDate,
    crewLeader: detail.summary.crewLeader,
    status: detail.summary.status,
    activeAllocatedFeet,
    fulfilledAllocatedFeet,
    requiredTubes: detail.summary.requiredTubes,
    allocatedTubes: detail.summary.allocatedTubes,
    remainingTubes: detail.summary.remainingTubes,
    openFilmOrderCount,
    boxCount: new Set(detail.allocations.map((entry) => entry.boxId).filter(Boolean)).size,
    hasOrderedAllocations: hasOrderedAllocations(detail.allocations)
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
    boxCount: new Set(allocations.map((entry) => entry.boxId).filter(Boolean)).size,
    hasOrderedAllocations: hasOrderedAllocations(allocations)
  };
}
