import type {
  AllocationJobDetailEntry,
  CaulkProductEntry,
  FilmOrderEntry,
  JobDetail,
  JobRequirementLine,
  JobCaulkRequirementLine,
  UpdateJobPayload
} from '../../../domain';
import { canJobPlanningFilmSatisfyRequirement } from '../utils/jobPlanningFilmIdentity';
import {
  addOptimisticLinkedBoxToFilmOrder,
  countUnresolvedFilmOrders,
  isUnresolvedFilmOrder,
  markFilmOrderLinkedBoxReceived
} from '../utils/filmOrders';
import { getAllocationCoveredFeet } from './jobSummaryMath';
import { computeCoveredFeetForAllocation } from '../../../domain/allocationCoverageContract.mjs';

type UpdateJobRequirementInput = NonNullable<UpdateJobPayload['requirements']>[number] & {
  requirementId?: string;
};
type UpdateJobCaulkRequirementInput = NonNullable<UpdateJobPayload['caulkRequirements']>[number] & {
  requirementId?: string;
};

function normalizeRequirementStatus(value: unknown): 'ACTIVE' | 'COMPLETE' {
  return String(value || '').trim().toUpperCase() === 'COMPLETE' ? 'COMPLETE' : 'ACTIVE';
}

function isRequirementComplete(requirement: Pick<JobRequirementLine, 'status'>) {
  return normalizeRequirementStatus(requirement.status) === 'COMPLETE';
}

function deriveCompletionResult(
  requirement: Pick<JobRequirementLine, 'status' | 'requiredFeet' | 'actualUsedFeet'>
): JobRequirementLine['completionResult'] {
  if (!isRequirementComplete(requirement)) {
    return '' as const;
  }

  return Math.max(0, Number(requirement.actualUsedFeet || 0)) <=
    Math.max(0, Number(requirement.requiredFeet || 0))
    ? 'ON_TARGET'
    : 'OVERUSED';
}

function isCaulkRequirementComplete(requirement: Pick<JobCaulkRequirementLine, 'status'>) {
  return normalizeRequirementStatus(requirement.status) === 'COMPLETE';
}

function getPhaseId(entry: { phaseId?: string | null } | null | undefined) {
  return String(entry?.phaseId || '').trim();
}

function getRequirementId(entry: { requirementId?: string | null } | null | undefined) {
  return String(entry?.requirementId || '').trim();
}

function isWorkflowActivePhase(phase: { workflowStatus?: string | null }) {
  return String(phase.workflowStatus || '').trim().toUpperCase() !== 'PLACEHOLDER';
}

function getActivePhaseScope(detail: JobDetail) {
  const phases = detail.summary.phases || detail.phases || [];
  if (!phases.length) {
    return {
      hasPhaseScope: false,
      activePhaseIds: new Set<string>(),
      fallbackPhaseId: ''
    };
  }

  return {
    hasPhaseScope: true,
    activePhaseIds: new Set(phases.filter(isWorkflowActivePhase).map(getPhaseId).filter(Boolean)),
    fallbackPhaseId: getPhaseId(phases.find((phase) => phase.isPrimary) || phases[0])
  };
}

function isEntryInActivePhase(
  entry: { phaseId?: string | null } | null | undefined,
  scope: ReturnType<typeof getActivePhaseScope>
) {
  if (!scope.hasPhaseScope) {
    return true;
  }
  const phaseId = getPhaseId(entry);
  if (phaseId) {
    return scope.activePhaseIds.has(phaseId);
  }
  return Boolean(scope.fallbackPhaseId && scope.activePhaseIds.has(scope.fallbackPhaseId));
}

function getActiveScopedRequirements(detail: JobDetail, requirements: JobRequirementLine[]) {
  const scope = getActivePhaseScope(detail);
  return requirements.filter((entry) => isEntryInActivePhase(entry, scope));
}

function getActiveScopedCaulkRequirements(detail: JobDetail, requirements: JobCaulkRequirementLine[]) {
  const scope = getActivePhaseScope(detail);
  return requirements.filter((entry) => isEntryInActivePhase(entry, scope));
}

function getActiveScopedAllocations(
  detail: JobDetail,
  allocations: AllocationJobDetailEntry[],
  activeRequirements: JobRequirementLine[]
) {
  const scope = getActivePhaseScope(detail);
  const requirementIds = new Set(activeRequirements.map(getRequirementId).filter(Boolean));
  return allocations.filter((entry) => {
    const requirementId = getRequirementId(entry);
    return requirementId ? requirementIds.has(requirementId) : isEntryInActivePhase(entry as { phaseId?: string }, scope);
  });
}

function getActiveScopedFilmOrders(
  detail: JobDetail,
  filmOrders: FilmOrderEntry[],
  activeRequirements: JobRequirementLine[]
) {
  const scope = getActivePhaseScope(detail);
  const requirementIds = new Set(activeRequirements.map(getRequirementId).filter(Boolean));
  return filmOrders.filter((entry) => {
    const requirementId = getRequirementId(entry);
    return requirementId ? requirementIds.has(requirementId) : isEntryInActivePhase(entry as { phaseId?: string }, scope);
  });
}

function deriveCaulkCompletionResult(
  requirement: Pick<JobCaulkRequirementLine, 'status' | 'requiredTubes' | 'actualUsedTubes'>
): JobCaulkRequirementLine['completionResult'] {
  if (!isCaulkRequirementComplete(requirement)) {
    return '' as const;
  }

  return Math.max(0, Number(requirement.actualUsedTubes || 0)) <=
    Math.max(0, Number(requirement.requiredTubes || 0))
    ? 'ON_TARGET'
    : 'OVERUSED';
}

function shouldIgnoreOptimisticAllocationCoverage(allocation: AllocationJobDetailEntry) {
  return allocation.boxStatus === 'ZEROED' || allocation.boxStatus === 'RETIRED';
}

function allocationMatchesRequirement(
  allocation: Pick<AllocationJobDetailEntry, 'manufacturer' | 'filmName' | 'widthIn'>,
  requirement: Pick<JobRequirementLine, 'manufacturer' | 'filmName' | 'widthIn'>
) {
  const requirementWidth = Number(requirement.widthIn) || 0;
  return (
    canJobPlanningFilmSatisfyRequirement(
      allocation.manufacturer,
      allocation.filmName,
      requirement.manufacturer,
      requirement.filmName
    ) &&
    requirementWidth > 0 &&
    (Number(allocation.widthIn) || 0) >= requirementWidth
  );
}

function normalizeJobNumberKey(value: string) {
  return String(value || '').trim().toUpperCase();
}

interface RequirementCoverageEntry {
  requirement: JobRequirementLine;
  requirementId: string;
}

function findFallbackCoverageRequirementEntry(
  requirementEntries: RequirementCoverageEntry[],
  allocation: AllocationJobDetailEntry
) {
  const matches = requirementEntries.filter((entry) =>
    allocationMatchesRequirement(allocation, entry.requirement)
  );

  return matches.length === 1 ? matches[0] : null;
}

function rebuildRequirementCoverage(
  requirements: JobRequirementLine[],
  allocations: AllocationJobDetailEntry[],
  jobNumber: string
) {
  const coverageByRequirementId: Record<string, number> = {};
  const requirementById: Record<string, RequirementCoverageEntry> = {};
  const requirementEntries: RequirementCoverageEntry[] = [];
  const expectedJobNumber = normalizeJobNumberKey(jobNumber);

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const requirementEntry = {
      requirement,
      requirementId: requirement.requirementId
    };
    requirementById[requirement.requirementId] = requirementEntry;
    requirementEntries.push(requirementEntry);
  }

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    const coveredFeet = getAllocationCoveredFeet(allocation);
    if (
      allocation.status === 'CANCELLED' ||
      coveredFeet <= 0 ||
      allocation.allocationKind === 'EXTRA' ||
      shouldIgnoreOptimisticAllocationCoverage(allocation)
    ) {
      continue;
    }

    if (
      expectedJobNumber &&
      normalizeJobNumberKey(allocation.jobNumber) !== expectedJobNumber
    ) {
      continue;
    }

    const boundRequirementId = String(allocation.requirementId || '').trim();
    const requirementEntry =
      (boundRequirementId ? requirementById[boundRequirementId] : null) ||
      findFallbackCoverageRequirementEntry(requirementEntries, allocation);

    if (requirementEntry && allocationMatchesRequirement(allocation, requirementEntry.requirement)) {
      const nextCoveredFeet = Math.min(
        Math.max(0, Number(requirementEntry.requirement.requiredFeet || 0)),
        Math.max(0, Number(coverageByRequirementId[requirementEntry.requirementId] || 0)) +
          coveredFeet
      );
      coverageByRequirementId[requirementEntry.requirementId] = nextCoveredFeet;
    }
  }

  return requirements.map((requirement) => {
    const requiredFeet = Math.max(0, Number(requirement.requiredFeet || 0));
    const actualUsedFeet = Math.max(0, Number(requirement.actualUsedFeet || 0));
    const allocatedFeet = Math.min(
      requiredFeet,
      Math.max(0, Number(coverageByRequirementId[requirement.requirementId] || 0))
    );
    const status = normalizeRequirementStatus(requirement.status);
    const nextRequirement = {
      ...requirement,
      status,
      isComplete: status === 'COMPLETE',
      actualUsedFeet,
      allocatedFeet,
      remainingFeet:
        status === 'COMPLETE' ? 0 : Math.max(0, requiredFeet - actualUsedFeet - allocatedFeet)
    };

    return {
      ...nextRequirement,
      completionResult: deriveCompletionResult(nextRequirement)
    };
  });
}


function filmOrderMatchesRequirement(
  order: FilmOrderEntry,
  requirement: Pick<JobRequirementLine, 'requirementId' | 'manufacturer' | 'filmName' | 'widthIn'>
) {
  const orderRequirementId = String(order.requirementId || '').trim();
  const requirementId = String(requirement.requirementId || '').trim();
  const productMatches = allocationMatchesRequirement(order, requirement);

  if (orderRequirementId || requirementId) {
    return Boolean(orderRequirementId && requirementId && orderRequirementId === requirementId && productMatches);
  }

  return productMatches;
}

function getFilmOnTheWayFeetForRequirement(filmOrders: FilmOrderEntry[], requirement: JobRequirementLine) {
  return filmOrders.reduce((sum, order) => {
    if (order.status !== 'FILM_ON_THE_WAY' || !filmOrderMatchesRequirement(order, requirement)) {
      return sum;
    }

    // FILM_ON_THE_WAY coverage prefers approved ordered LF; requested LF is a legacy fallback.
    const orderedFeet = Math.max(0, Number(order.orderedFeet || 0));
    const sourceFeet = orderedFeet > 0 ? orderedFeet : Math.max(0, Number(order.requestedFeet || 0));
    return sum + computeCoveredFeetForAllocation(sourceFeet, order.widthIn, requirement.widthIn);
  }, 0);
}

function areFilmShortagesFullyOnTheWay(requirements: JobRequirementLine[], filmOrders: FilmOrderEntry[]) {
  return requirements.every((requirement) => {
    if (isRequirementComplete(requirement)) {
      return true;
    }
    const requiredFeet = Math.max(0, Number(requirement.requiredFeet || 0));
    const actualUsedFeet = Math.max(0, Number(requirement.actualUsedFeet || 0));
    const allocatedFeet = Math.max(0, Number(requirement.allocatedFeet || 0));
    const missingFeet = Math.max(0, requiredFeet - actualUsedFeet - Math.min(allocatedFeet, requiredFeet));
    return missingFeet <= 0 || getFilmOnTheWayFeetForRequirement(filmOrders, requirement) >= missingFeet;
  });
}

function computeOptimisticExistingJobStatus(
  detail: JobDetail,
  nextRequirements: JobRequirementLine[],
  nextCaulkRequirements: JobCaulkRequirementLine[] = detail.caulkRequirements
) {
  const lifecycleStatus = detail.summary.lifecycleStatus;
  if (lifecycleStatus === 'CANCELLED') {
    return 'CANCELLED' as const;
  }

  if (lifecycleStatus === 'COMPLETED') {
    return 'COMPLETED' as const;
  }

  const activeScopedRequirements = getActiveScopedRequirements(detail, nextRequirements);
  const activeScopedCaulkRequirements = getActiveScopedCaulkRequirements(detail, nextCaulkRequirements);
  const activeScopedFilmOrders = getActiveScopedFilmOrders(detail, detail.filmOrders, activeScopedRequirements);
  const hasMaterialRequirements =
    activeScopedRequirements.some((entry) => !isRequirementComplete(entry) && entry.requiredFeet > 0) ||
    activeScopedCaulkRequirements.some((entry) => !isCaulkRequirementComplete(entry) && entry.requiredTubes > 0);
  if (!hasMaterialRequirements) {
    return 'READY' as const;
  }

  const hasRemainingFilm = activeScopedRequirements.some((entry) => entry.remainingFeet > 0);
  const hasRemainingCaulk = activeScopedCaulkRequirements.some(
    (entry) => !isCaulkRequirementComplete(entry) && entry.remainingTubes > 0
  );
  if (!hasRemainingFilm && !hasRemainingCaulk) {
    return 'READY' as const;
  }

  if (!hasRemainingCaulk && areFilmShortagesFullyOnTheWay(activeScopedRequirements, activeScopedFilmOrders)) {
    return 'ORDERED' as const;
  }

  return activeScopedFilmOrders.some((entry) => entry.status === 'FILM_ORDER')
    ? 'FILM_ORDER'
    : 'NEEDS_ALLOCATION';
}

function recomputeOptimisticJobDetail(detail: JobDetail): JobDetail {
  const nextRequirements = rebuildRequirementCoverage(
    detail.requirements,
    detail.allocations,
    detail.summary.jobNumber
  );
  const activeRequirements = getActiveScopedRequirements(detail, nextRequirements).filter((entry) => !isRequirementComplete(entry));
  const activeAllocations = getActiveScopedAllocations(detail, detail.allocations, activeRequirements);
  const activeFilmOrders = getActiveScopedFilmOrders(detail, detail.filmOrders, activeRequirements);
  const requiredFeet = activeRequirements.reduce((sum, entry) => sum + entry.requiredFeet, 0);
  const allocatedFeet = activeRequirements.reduce((sum, entry) => sum + entry.allocatedFeet, 0);
  const remainingFeet = activeRequirements.reduce((sum, entry) => sum + entry.remainingFeet, 0);
  const hasOrderedAllocations = activeAllocations.some(
    (entry) => entry.status === 'ACTIVE' && entry.boxStatus === 'ORDERED'
  );

  return {
    ...detail,
    summary: {
      ...detail.summary,
      status: computeOptimisticExistingJobStatus(detail, nextRequirements),
      requiredFeet,
      allocatedFeet,
      remainingFeet,
      allocationCount: detail.allocations.length,
      filmOrderCount: countUnresolvedFilmOrders(activeFilmOrders),
      hasOrderedAllocations
    },
    requirements: nextRequirements
  };
}

export function createOptimisticJobDetailAfterRequirementStateChange(
  detail: JobDetail,
  payload: { requirementId: string; status: 'ACTIVE' | 'COMPLETE'; materialType?: 'FILM' | 'CAULK' }
) {
  const nextStatus = normalizeRequirementStatus(payload.status);
  if (payload.materialType === 'CAULK') {
    const nextCaulkRequirements = detail.caulkRequirements.map((entry) => {
      if (entry.requirementId !== payload.requirementId) {
        return entry;
      }

      const nextRequirement = {
        ...entry,
        status: nextStatus,
        isComplete: nextStatus === 'COMPLETE',
        completedAt: nextStatus === 'COMPLETE' ? entry.completedAt || new Date().toISOString() : '',
        completedBy: nextStatus === 'COMPLETE' ? entry.completedBy || '' : '',
        remainingTubes:
          nextStatus === 'COMPLETE'
            ? 0
            : Math.max(
                0,
                Number(entry.requiredTubes || 0) -
                  Math.max(0, Number(entry.actualUsedTubes || 0)) -
                  Math.max(0, Number(entry.allocatedTubes || 0))
              )
      };

      return {
        ...nextRequirement,
        completionResult: deriveCaulkCompletionResult(nextRequirement)
      };
    });

    return reconcileJobDetailCaulkCoverage({
      ...detail,
      summary: {
        ...detail.summary,
        updatedAt: new Date().toISOString()
      },
      caulkRequirements: nextCaulkRequirements
    });
  }

  const nextRequirements = detail.requirements.map((entry) => {
    if (entry.requirementId !== payload.requirementId) {
      return entry;
    }

    const nextRequirement = {
      ...entry,
      status: nextStatus,
      isComplete: nextStatus === 'COMPLETE',
      completedAt: nextStatus === 'COMPLETE' ? entry.completedAt || new Date().toISOString() : '',
      completedBy: nextStatus === 'COMPLETE' ? entry.completedBy || '' : '',
      remainingFeet:
        nextStatus === 'COMPLETE'
          ? 0
          : Math.max(
              0,
              Number(entry.requiredFeet || 0) -
                Math.max(0, Number(entry.actualUsedFeet || 0)) -
                Math.max(0, Number(entry.allocatedFeet || 0))
            )
    };

    return {
      ...nextRequirement,
      completionResult: deriveCompletionResult(nextRequirement)
    };
  });

  return recomputeOptimisticJobDetail({
    ...detail,
    summary: {
      ...detail.summary,
      updatedAt: new Date().toISOString()
    },
    requirements: nextRequirements
  });
}

function normalizeLookupSegment(value: string) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function buildRequirementIdentityKey(
  requirement: Pick<JobRequirementLine, 'manufacturer' | 'filmName' | 'widthIn'>
) {
  return `${normalizeLookupSegment(requirement.manufacturer)}|${normalizeLookupSegment(
    requirement.filmName
  )}|${Math.max(0, Number(requirement.widthIn || 0))}`;
}

function buildRequirementPhaseKey(
  requirement: Pick<JobRequirementLine, 'phaseId' | 'phaseNumber'>
) {
  const phaseId = String(requirement.phaseId || '').trim();
  if (phaseId) {
    return phaseId;
  }

  return `number:${Math.max(1, Math.floor(Number(requirement.phaseNumber || 1)))}`;
}

function buildPhaseScopedRequirementIdentityKey(
  requirement: Pick<JobRequirementLine, 'phaseId' | 'phaseNumber' | 'manufacturer' | 'filmName' | 'widthIn'>
) {
  return `${buildRequirementPhaseKey(requirement)}|${buildRequirementIdentityKey(requirement)}`;
}

function buildRequirementSuppressionSignature(
  requirement: Pick<JobRequirementLine, 'manufacturer' | 'filmName' | 'widthIn' | 'requiredFeet'>
) {
  return `${buildRequirementIdentityKey(requirement)}|${Math.max(0, Number(requirement.requiredFeet || 0))}`;
}

function compareCatalogStrings(left: string, right: string) {
  return normalizeLookupSegment(left).localeCompare(normalizeLookupSegment(right));
}

type OrderedCaulkRequirementLine = JobCaulkRequirementLine & {
  coverageOrder: number;
};

function getCaulkAllocationCoverageTubes(allocation: JobDetail['caulkAllocations'][number]) {
  const allocatedTubes = Math.max(0, Number(allocation.allocatedTubes || 0));
  if (
    allocatedTubes <= 0 ||
    String(allocation.status || '').trim().toUpperCase() === 'CANCELLED' ||
    String(allocation.resolvedAt || '').trim()
  ) {
    return 0;
  }

  const outstandingCheckoutTubes = Math.max(
    0,
    Number(allocation.outstandingCheckoutTubes || 0) > 0
      ? Number(allocation.outstandingCheckoutTubes || 0)
      : Number(allocation.checkedOutTubesTotal || 0) -
          Number(allocation.returnedUnusedTubesTotal || 0) -
          Number(allocation.usedTubesTotal || 0)
  );
  const committedTubes =
    Math.max(0, Number(allocation.reservedTubesRemaining || 0)) +
    outstandingCheckoutTubes +
    Math.max(0, Number(allocation.usedTubesTotal || 0));

  return Math.min(allocatedTubes, Math.max(0, committedTubes));
}

function addCaulkCoverageTubes(
  coverageByRequirementId: Record<string, number>,
  requirementId: string,
  tubes: number
) {
  const normalizedRequirementId = String(requirementId || '').trim();
  if (!normalizedRequirementId) {
    return;
  }

  coverageByRequirementId[normalizedRequirementId] =
    Math.max(0, Number(coverageByRequirementId[normalizedRequirementId] || 0)) +
    Math.max(0, Math.floor(Number(tubes || 0)));
}

function buildCaulkFallbackRequirementGroupKey(productId: string, jobNumber: string) {
  return `${String(productId || '').trim()}|${normalizeJobNumberKey(jobNumber)}`;
}

function buildCaulkRequirementPhaseProductKey(
  requirement: Pick<JobCaulkRequirementLine, 'phaseId' | 'phaseNumber' | 'productId'>
) {
  return `${buildRequirementPhaseKey(requirement)}|${String(requirement.productId || '').trim()}`;
}

function caulkAllocationMatchesJob(
  allocation: JobDetail['caulkAllocations'][number],
  expectedJobNumber: string
) {
  const normalizedExpectedJobNumber = normalizeJobNumberKey(expectedJobNumber);
  const allocationJobNumber = String(
    (allocation as JobDetail['caulkAllocations'][number] & { jobNumber?: string }).jobNumber ||
      expectedJobNumber
  );
  return (
    !normalizedExpectedJobNumber ||
    normalizeJobNumberKey(allocationJobNumber) === normalizedExpectedJobNumber
  );
}

function caulkAllocationMatchesWarehouse(
  allocation: JobDetail['caulkAllocations'][number],
  expectedWarehouse: string
) {
  const normalizedExpectedWarehouse = String(expectedWarehouse || '').trim().toUpperCase();
  const allocationWarehouse = String(allocation.warehouse || '').trim().toUpperCase();
  return (
    !normalizedExpectedWarehouse ||
    !allocationWarehouse ||
    allocationWarehouse === normalizedExpectedWarehouse
  );
}

function compareCaulkFallbackAllocations(
  left: JobDetail['caulkAllocations'][number],
  right: JobDetail['caulkAllocations'][number]
) {
  const createdCompare = compareCatalogStrings(left.createdAt || '', right.createdAt || '');
  if (createdCompare !== 0) {
    return createdCompare;
  }

  return compareCatalogStrings(left.caulkAllocationId || '', right.caulkAllocationId || '');
}

function compareCaulkFallbackRequirements(
  left: OrderedCaulkRequirementLine,
  right: OrderedCaulkRequirementLine
) {
  if (left.coverageOrder !== right.coverageOrder) {
    return left.coverageOrder - right.coverageOrder;
  }

  return compareCatalogStrings(left.requirementId || '', right.requirementId || '');
}

function buildCaulkCoverageByRequirementId(detail: JobDetail) {
  const coverageByRequirementId: Record<string, number> = {};
  const requirementById: Record<string, JobCaulkRequirementLine> = {};
  const requirementsByFallbackGroup = new Map<string, OrderedCaulkRequirementLine[]>();

  for (let index = 0; index < detail.caulkRequirements.length; index += 1) {
    const requirement = detail.caulkRequirements[index];
    if (isCaulkRequirementComplete(requirement)) {
      continue;
    }
    const requirementId = String(requirement.requirementId || '').trim();
    if (!requirementId) {
      continue;
    }

    requirementById[requirementId] = requirement;

    const productId = String(requirement.productId || '').trim();
    if (!productId) {
      continue;
    }

    const key = buildCaulkFallbackRequirementGroupKey(productId, detail.summary.jobNumber);
    const rows = requirementsByFallbackGroup.get(key) || [];
    rows.push({ ...requirement, coverageOrder: index });
    requirementsByFallbackGroup.set(key, rows);
  }

  for (const rows of requirementsByFallbackGroup.values()) {
    rows.sort(compareCaulkFallbackRequirements);
  }

  for (let index = 0; index < detail.caulkAllocations.length; index += 1) {
    const allocation = detail.caulkAllocations[index];
    const requirementId = String(allocation.requirementId || '').trim();
    const requirement = requirementId ? requirementById[requirementId] : null;
    const coverageTubes = getCaulkAllocationCoverageTubes(allocation);
    if (
      !requirement ||
      coverageTubes <= 0 ||
      String(allocation.productId || '').trim() !== String(requirement.productId || '').trim()
    ) {
      continue;
    }

    if (!caulkAllocationMatchesJob(allocation, detail.summary.jobNumber)) {
      continue;
    }

    if (!caulkAllocationMatchesWarehouse(allocation, detail.summary.warehouse || '')) {
      continue;
    }

    addCaulkCoverageTubes(coverageByRequirementId, requirementId, coverageTubes);
  }

  const fallbackAllocations = detail.caulkAllocations
    .filter((allocation) => {
      if (String(allocation.requirementId || '').trim()) {
        return false;
      }
      if (String(allocation.status || '').trim().toUpperCase() !== 'ACTIVE') {
        return false;
      }
      if (!caulkAllocationMatchesJob(allocation, detail.summary.jobNumber)) {
        return false;
      }
      if (!caulkAllocationMatchesWarehouse(allocation, detail.summary.warehouse || '')) {
        return false;
      }
      return getCaulkAllocationCoverageTubes(allocation) > 0;
    })
    .sort(compareCaulkFallbackAllocations);

  for (const allocation of fallbackAllocations) {
    const productId = String(allocation.productId || '').trim();
    const matchingRequirements =
      requirementsByFallbackGroup.get(
        buildCaulkFallbackRequirementGroupKey(productId, detail.summary.jobNumber)
      ) || [];
    let remainingAllocationTubes = getCaulkAllocationCoverageTubes(allocation);

    for (
      let index = 0;
      index < matchingRequirements.length && remainingAllocationTubes > 0;
      index += 1
    ) {
      const requirement = matchingRequirements[index];
      const requiredTubes = Math.max(0, Number(requirement.requiredTubes || 0));
      const coveredBefore = Math.min(
        requiredTubes,
        Math.max(0, Number(coverageByRequirementId[requirement.requirementId] || 0))
      );
      const remainingRequirementTubes = Math.max(0, requiredTubes - coveredBefore);
      if (remainingRequirementTubes <= 0) {
        continue;
      }

      const appliedTubes = Math.min(remainingAllocationTubes, remainingRequirementTubes);
      addCaulkCoverageTubes(coverageByRequirementId, requirement.requirementId, appliedTubes);
      remainingAllocationTubes -= appliedTubes;
    }
  }

  return coverageByRequirementId;
}

function buildNextRequirementLines(
  currentRequirements: JobRequirementLine[],
  nextRequirements: UpdateJobRequirementInput[]
) {
  const currentRequirementById = Object.fromEntries(
    currentRequirements.map((entry) => [entry.requirementId, entry])
  ) as Record<string, JobRequirementLine>;
  const unusedCurrentByKey = new Map<string, JobRequirementLine[]>();

  for (let index = 0; index < currentRequirements.length; index += 1) {
    const requirement = currentRequirements[index];
    const key = buildPhaseScopedRequirementIdentityKey(requirement);
    const currentMatches = unusedCurrentByKey.get(key) || [];
    currentMatches.push(requirement);
    unusedCurrentByKey.set(key, currentMatches);
  }

  return nextRequirements.map((entry, index) => {
    const explicitRequirementId = String(entry.requirementId || '').trim();
    const matchedRequirement = explicitRequirementId
      ? currentRequirementById[explicitRequirementId]
      : (unusedCurrentByKey.get(
          buildPhaseScopedRequirementIdentityKey({
            phaseId: entry.phaseId,
            phaseNumber: entry.phaseNumber,
            manufacturer: entry.manufacturer,
            filmName: entry.filmName,
            widthIn: entry.widthIn
          })
        ) || [])[0];
    if (!explicitRequirementId && matchedRequirement) {
      const key = buildPhaseScopedRequirementIdentityKey(matchedRequirement);
      const remainingMatches = (unusedCurrentByKey.get(key) || []).filter(
        (candidate) => candidate.requirementId !== matchedRequirement.requirementId
      );
      unusedCurrentByKey.set(key, remainingMatches);
    }

    return {
      requirementId:
        explicitRequirementId ||
        matchedRequirement?.requirementId ||
        `pending-film-req-update-${index + 1}`,
      phaseId: entry.phaseId || matchedRequirement?.phaseId,
      phaseNumber: entry.phaseNumber || matchedRequirement?.phaseNumber,
      phaseWorkScope: matchedRequirement?.phaseWorkScope,
      phaseInstallDate: matchedRequirement?.phaseInstallDate,
      phaseCrewLeader: matchedRequirement?.phaseCrewLeader,
      manufacturer: entry.manufacturer,
      filmName: entry.filmName,
      widthIn: entry.widthIn,
      requiredFeet: entry.requiredFeet,
      status: normalizeRequirementStatus(matchedRequirement?.status),
      isComplete: normalizeRequirementStatus(matchedRequirement?.status) === 'COMPLETE',
      actualUsedFeet: Math.max(0, Number(matchedRequirement?.actualUsedFeet || 0)),
      completedAt: matchedRequirement?.completedAt || '',
      completedBy: matchedRequirement?.completedBy || '',
      completionResult: deriveCompletionResult({
        status: normalizeRequirementStatus(matchedRequirement?.status),
        requiredFeet: entry.requiredFeet,
        actualUsedFeet: Math.max(0, Number(matchedRequirement?.actualUsedFeet || 0))
      }),
      allocatedFeet: 0,
      autoPlanningSuppressed:
        matchedRequirement?.autoPlanningSuppressed === true &&
        buildRequirementSuppressionSignature(matchedRequirement) ===
          buildRequirementSuppressionSignature({
            manufacturer: entry.manufacturer,
            filmName: entry.filmName,
            widthIn: entry.widthIn,
            requiredFeet: entry.requiredFeet
          }),
      remainingFeet: Math.max(
        0,
        Number(entry.requiredFeet || 0) - Math.max(0, Number(matchedRequirement?.actualUsedFeet || 0))
      )
    };
  });
}

function buildCaulkMetadataLookup(detail: JobDetail, caulkProducts: CaulkProductEntry[]) {
  const caulkMetadataByProductId: Record<
    string,
    Pick<
      JobCaulkRequirementLine,
      'manufacturerId' | 'manufacturer' | 'productName' | 'productCode' | 'tubesPerCase'
    >
  > = {};

  for (let index = 0; index < detail.caulkRequirements.length; index += 1) {
    const requirement = detail.caulkRequirements[index];
    caulkMetadataByProductId[requirement.productId] = {
      manufacturerId: requirement.manufacturerId,
      manufacturer: requirement.manufacturer,
      productName: requirement.productName,
      productCode: requirement.productCode,
      tubesPerCase: requirement.tubesPerCase
    };
  }

  for (let index = 0; index < detail.caulkAllocations.length; index += 1) {
    const allocation = detail.caulkAllocations[index];
    if (caulkMetadataByProductId[allocation.productId]) {
      continue;
    }

    caulkMetadataByProductId[allocation.productId] = {
      manufacturerId: allocation.manufacturerId,
      manufacturer: allocation.manufacturer,
      productName: allocation.productName,
      productCode: allocation.productCode,
      tubesPerCase: allocation.tubesPerCase
    };
  }

  for (let index = 0; index < caulkProducts.length; index += 1) {
    const product = caulkProducts[index];
    caulkMetadataByProductId[product.productId] = {
      manufacturerId: product.manufacturerId,
      manufacturer: product.manufacturer,
      productName: product.productName,
      productCode: product.productCode,
      tubesPerCase: product.tubesPerCase
    };
  }

  return caulkMetadataByProductId;
}

function buildNextCaulkRequirementLines(
  detail: JobDetail,
  nextRequirements: UpdateJobCaulkRequirementInput[],
  caulkProducts: CaulkProductEntry[]
) {
  const currentRequirementById = Object.fromEntries(
    detail.caulkRequirements.map((entry) => [entry.requirementId, entry])
  ) as Record<string, JobCaulkRequirementLine>;
  const currentRequirementByPhaseProduct = Object.fromEntries(
    detail.caulkRequirements.map((entry) => [buildCaulkRequirementPhaseProductKey(entry), entry])
  ) as Record<string, JobCaulkRequirementLine>;
  const caulkMetadataByProductId = buildCaulkMetadataLookup(detail, caulkProducts);
  const coverageByRequirementId = buildCaulkCoverageByRequirementId(detail);

  return nextRequirements
    .map((entry, index) => {
      const explicitRequirementId = String(entry.requirementId || '').trim();
      const currentRequirement = explicitRequirementId
        ? currentRequirementById[explicitRequirementId]
        : currentRequirementByPhaseProduct[buildCaulkRequirementPhaseProductKey(entry)];
      const productMetadata = caulkMetadataByProductId[entry.productId];
      const requiredTubes = Math.max(0, Math.floor(Number(entry.requiredTubes || 0)));
      const status = normalizeRequirementStatus(currentRequirement?.status);
      const actualUsedTubes = Math.max(0, Number(currentRequirement?.actualUsedTubes || 0));
      const allocatedTubes = Math.min(
        requiredTubes,
        status === 'COMPLETE'
          ? 0
          : Math.max(0, Number(coverageByRequirementId[explicitRequirementId || currentRequirement?.requirementId || ''] || 0))
      );

      const nextRequirement = {
        requirementId:
          explicitRequirementId ||
          currentRequirement?.requirementId ||
          `pending-caulk-req-update-${index + 1}`,
        jobNumber: detail.summary.jobNumber,
        phaseId: entry.phaseId || currentRequirement?.phaseId,
        phaseNumber: entry.phaseNumber || currentRequirement?.phaseNumber,
        phaseWorkScope: currentRequirement?.phaseWorkScope,
        phaseInstallDate: currentRequirement?.phaseInstallDate,
        phaseCrewLeader: currentRequirement?.phaseCrewLeader,
        productId: entry.productId,
        manufacturerId: productMetadata?.manufacturerId || currentRequirement?.manufacturerId || '',
        manufacturer: productMetadata?.manufacturer || currentRequirement?.manufacturer || '',
        productName: productMetadata?.productName || currentRequirement?.productName || '',
        productCode: productMetadata?.productCode || currentRequirement?.productCode || '',
        tubesPerCase: productMetadata?.tubesPerCase || currentRequirement?.tubesPerCase || 0,
        requiredTubes,
        status,
        isComplete: status === 'COMPLETE',
        actualUsedTubes,
        completedAt: currentRequirement?.completedAt || '',
        completedBy: currentRequirement?.completedBy || '',
        allocatedTubes,
        remainingTubes:
          status === 'COMPLETE' ? 0 : Math.max(0, requiredTubes - actualUsedTubes - allocatedTubes),
        notes: currentRequirement?.notes || '',
        updatedAt: new Date().toISOString()
      };

      return {
        ...nextRequirement,
        completionResult: deriveCaulkCompletionResult(nextRequirement)
      };
    })
    .sort((left, right) => {
      const manufacturerCompare = compareCatalogStrings(left.manufacturer, right.manufacturer);
      if (manufacturerCompare !== 0) {
        return manufacturerCompare;
      }

      const productCompare = compareCatalogStrings(left.productName, right.productName);
      if (productCompare !== 0) {
        return productCompare;
      }

      return compareCatalogStrings(left.productCode, right.productCode);
    });
}

export function createOptimisticJobDetailAfterJobUpdate(
  detail: JobDetail,
  payload: UpdateJobPayload,
  caulkProducts: CaulkProductEntry[] = []
) {
  const nextRequirements = payload.requirements
    ? buildNextRequirementLines(
        detail.requirements,
        payload.requirements as UpdateJobRequirementInput[]
      )
    : detail.requirements;
  const nextCaulkRequirements = payload.caulkRequirements
    ? buildNextCaulkRequirementLines(
        detail,
        payload.caulkRequirements as UpdateJobCaulkRequirementInput[],
        caulkProducts
      )
    : detail.caulkRequirements;
  const nextRequiredTubes = nextCaulkRequirements.reduce(
    (sum, entry) =>
      isCaulkRequirementComplete(entry) ? sum : sum + Math.max(0, Number(entry.requiredTubes || 0)),
    0
  );
  const nextAllocatedTubes = nextCaulkRequirements.reduce(
    (sum, entry) =>
      isCaulkRequirementComplete(entry) ? sum : sum + Math.max(0, Number(entry.allocatedTubes || 0)),
    0
  );
  const nextRemainingTubes = nextCaulkRequirements.reduce(
    (sum, entry) =>
      isCaulkRequirementComplete(entry) ? sum : sum + Math.max(0, Number(entry.remainingTubes || 0)),
    0
  );
  const nextInstallDate =
    payload.installDate !== undefined ? String(payload.installDate || '').trim() : detail.summary.installDate;
  const nextCrewLeader =
    payload.crewLeader !== undefined ? String(payload.crewLeader || '').trim() : detail.summary.crewLeader;
  const patchFilmOrder = (entry: FilmOrderEntry) =>
    entry.jobNumber === detail.summary.jobNumber && isUnresolvedFilmOrder(entry)
      ? {
          ...entry,
          ...(payload.installDate !== undefined ? { installDate: nextInstallDate } : {}),
          ...(payload.crewLeader !== undefined ? { crewLeader: nextCrewLeader } : {})
        }
      : entry;

  return recomputeOptimisticJobDetail({
    ...detail,
    summary: {
      ...detail.summary,
      ...(payload.warehouse !== undefined ? { warehouse: payload.warehouse } : {}),
      ...(payload.workScope !== undefined || payload.sections !== undefined
        ? {
            workScope:
              payload.workScope === null || payload.workScope === undefined || payload.workScope === ''
                ? payload.sections === null || payload.sections === undefined || payload.sections === ''
                  ? null
                  : String(payload.sections)
                : String(payload.workScope),
            sections:
              payload.workScope === null || payload.workScope === undefined || payload.workScope === ''
                ? payload.sections === null || payload.sections === undefined || payload.sections === ''
                  ? null
                  : String(payload.sections)
                : String(payload.workScope)
          }
        : {}),
      ...(payload.installDate !== undefined ? { installDate: nextInstallDate } : {}),
      ...(payload.crewLeader !== undefined ? { crewLeader: nextCrewLeader } : {}),
      ...(payload.isLaborOnly !== undefined ? { isLaborOnly: Boolean(payload.isLaborOnly) } : {}),
      ...(payload.notes !== undefined ? { notes: payload.notes || '' } : {}),
      requiredTubes: nextRequiredTubes,
      allocatedTubes: nextAllocatedTubes,
      remainingTubes: nextRemainingTubes,
      requirementCount: nextRequirements.length,
      updatedAt: new Date().toISOString()
    },
    requirements: nextRequirements,
    caulkRequirements: nextCaulkRequirements,
    filmOrders: detail.filmOrders.map(patchFilmOrder)
  });
}

export function reconcileJobDetailCaulkCoverage(detail: JobDetail): JobDetail {
  const coverageByRequirementId = buildCaulkCoverageByRequirementId(detail);
  const nextCaulkRequirements = detail.caulkRequirements.map((requirement) => {
    const requiredTubes = Math.max(0, Number(requirement.requiredTubes || 0));
    const status = normalizeRequirementStatus(requirement.status);
    const actualUsedTubes = Math.max(0, Number(requirement.actualUsedTubes || 0));
    const allocatedTubes = Math.min(
      requiredTubes,
      status === 'COMPLETE'
        ? 0
        : Math.max(0, Number(coverageByRequirementId[requirement.requirementId] || 0))
    );

    const nextRequirement = {
      ...requirement,
      requiredTubes,
      status,
      isComplete: status === 'COMPLETE',
      actualUsedTubes,
      allocatedTubes,
      remainingTubes:
        status === 'COMPLETE' ? 0 : Math.max(0, requiredTubes - actualUsedTubes - allocatedTubes)
    };

    return {
      ...nextRequirement,
      completionResult: deriveCaulkCompletionResult(nextRequirement)
    };
  });
  const requiredTubes = nextCaulkRequirements.reduce(
    (sum, entry) =>
      isCaulkRequirementComplete(entry) ? sum : sum + Math.max(0, Number(entry.requiredTubes || 0)),
    0
  );
  const allocatedTubes = nextCaulkRequirements.reduce(
    (sum, entry) =>
      isCaulkRequirementComplete(entry) ? sum : sum + Math.max(0, Number(entry.allocatedTubes || 0)),
    0
  );
  const remainingTubes = nextCaulkRequirements.reduce(
    (sum, entry) =>
      isCaulkRequirementComplete(entry) ? sum : sum + Math.max(0, Number(entry.remainingTubes || 0)),
    0
  );

  const detailWithReconciledCaulk = {
    ...detail,
    caulkRequirements: nextCaulkRequirements
  };

  // Purpose: defend page reads from mixed React Query state where allocation rows are fresh
  // but derived caulk requirement totals/status came from an older payload.
  return {
    ...detailWithReconciledCaulk,
    summary: {
      ...detail.summary,
      status: computeOptimisticExistingJobStatus(
        detailWithReconciledCaulk,
        detail.requirements,
        nextCaulkRequirements
      ),
      requiredTubes,
      allocatedTubes,
      remainingTubes
    }
  };
}

export function createOptimisticJobDetailAfterFilmOrderReceipt(
  detail: JobDetail,
  filmOrderId: string,
  box: Pick<{ boxId: string; dealer?: string; initialFeet: number }, 'boxId' | 'dealer' | 'initialFeet'>
) {
  let updated = false;
  const nextFilmOrders = detail.filmOrders.map((entry) => {
    if (entry.filmOrderId !== filmOrderId) {
      return entry;
    }

    updated = true;
    return addOptimisticLinkedBoxToFilmOrder(entry, {
      boxId: box.boxId,
      dealer: box.dealer,
      orderedFeet: Math.max(0, Number(box.initialFeet || 0)),
      autoAllocatedFeet: 0,
      isReceived: false
    });
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

export function createOptimisticJobDetailAfterOrderedBoxReceive(
  detail: JobDetail,
  boxId: string
) {
  let updated = false;
  const nextFilmOrders = detail.filmOrders.map((entry) => {
    const nextEntry = markFilmOrderLinkedBoxReceived(entry, boxId);
    if (nextEntry !== entry) {
      updated = true;
    }

    return nextEntry;
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

export function createOptimisticJobDetailAfterAllocationRemoval(detail: JobDetail, allocationId: string) {
  const removedAllocation = detail.allocations.find((entry) => entry.allocationId === allocationId) || null;
  if (!removedAllocation) {
    return {
      detail,
      removedAllocation: null
    };
  }

  return {
    detail: recomputeOptimisticJobDetail({
      ...detail,
      requirements:
        removedAllocation.allocationSource === 'AUTO_PLANNED' &&
        removedAllocation.allocationKind !== 'EXTRA' &&
        removedAllocation.requirementId
          ? detail.requirements.map((requirement) =>
              requirement.requirementId === removedAllocation.requirementId
                ? { ...requirement, autoPlanningSuppressed: true }
                : requirement
            )
          : detail.requirements,
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
    allocations: detail.allocations.filter((entry) => !(entry.filmOrderId === filmOrderId && entry.status === 'ACTIVE')),
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
