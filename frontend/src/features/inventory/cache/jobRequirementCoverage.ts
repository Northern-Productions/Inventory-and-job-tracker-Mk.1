import type {
  AllocationJobDetailEntry,
  FilmOrderEntry,
  JobDetail,
  JobRequirementLine
} from '../../../domain';
import {
  compareJobPlanningFilmMatches,
  canJobPlanningFilmSatisfyRequirement,
  describeJobPlanningFilm,
  getJobPlanningFilmMatch
} from '../utils/jobPlanningFilmIdentity';
import { isUnresolvedFilmOrder } from '../utils/filmOrders';
import { getAllocationCoveredFeet } from './jobSummaryMath';

function getPlanningManufacturerGroupKey(manufacturer: string, filmName: string) {
  return describeJobPlanningFilm(manufacturer, filmName).manufacturerKey;
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

function compareCoveragePoolsForRequirement(
  left: {
    manufacturer: string;
    filmName: string;
    widthIn: number;
    isExterior: boolean;
    index: number;
  },
  right: {
    manufacturer: string;
    filmName: string;
    widthIn: number;
    isExterior: boolean;
    index: number;
  },
  requirement: Pick<JobRequirementLine, 'manufacturer' | 'filmName'>
) {
  const leftMatch = getJobPlanningFilmMatch(
    left.manufacturer,
    left.filmName,
    requirement.manufacturer,
    requirement.filmName
  );
  const rightMatch = getJobPlanningFilmMatch(
    right.manufacturer,
    right.filmName,
    requirement.manufacturer,
    requirement.filmName
  );

  if (leftMatch && rightMatch) {
    const matchComparison = compareJobPlanningFilmMatches(leftMatch, rightMatch);
    if (matchComparison !== 0) {
      return matchComparison;
    }
  }

  const requirementIsExterior = isExteriorPlanningFilm(requirement.manufacturer, requirement.filmName);
  if (!requirementIsExterior && left.isExterior !== right.isExterior) {
    return left.isExterior ? 1 : -1;
  }

  if (left.widthIn !== right.widthIn) {
    return left.widthIn - right.widthIn;
  }

  return left.index - right.index;
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
        manufacturer: string;
        filmName: string;
        widthIn: number;
        requiredFeet: number;
        isExterior: boolean;
        specificity: number;
        index: number;
      }>;
      pools: Array<{
        manufacturer: string;
        filmName: string;
        widthIn: number;
        remainingFeet: number;
        isExterior: boolean;
        index: number;
      }>;
    }
  > = {};
  const coverageByRequirementId: Record<string, number> = {};
  const requirementById: Record<string, JobRequirementLine> = {};

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const groupKey = getPlanningManufacturerGroupKey(requirement.manufacturer, requirement.filmName);
    requirementById[requirement.requirementId] = requirement;
    if (!grouped[groupKey]) {
      grouped[groupKey] = {
        requirements: [],
        pools: []
      };
    }

    grouped[groupKey].requirements.push({
      requirementId: requirement.requirementId,
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: Number(requirement.widthIn) || 0,
      requiredFeet: Math.max(0, Number(requirement.requiredFeet || 0)),
      isExterior: isExteriorPlanningFilm(requirement.manufacturer, requirement.filmName),
      specificity: describeJobPlanningFilm(requirement.manufacturer, requirement.filmName).compactFamilyFilmName.length,
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

    const groupKey = getPlanningManufacturerGroupKey(allocation.manufacturer, allocation.filmName);
    if (!grouped[groupKey]) {
      grouped[groupKey] = {
        requirements: [],
        pools: []
      };
    }

    grouped[groupKey].pools.push({
      manufacturer: allocation.manufacturer,
      filmName: allocation.filmName,
      widthIn: Number(allocation.widthIn) || 0,
      remainingFeet: coveredFeet,
      isExterior: isExteriorPlanningFilm(allocation.manufacturer, allocation.filmName),
      index
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

      if (left.specificity !== right.specificity) {
        return right.specificity - left.specificity;
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
      let remainingNeed = Math.max(0, requirement.requiredFeet - coveredBeforePools);
      const compatiblePools = group.pools
        .filter(
          (pool) =>
            pool.remainingFeet > 0 &&
            pool.widthIn >= requirement.widthIn &&
            Boolean(
              getJobPlanningFilmMatch(
                pool.manufacturer,
                pool.filmName,
                requirement.manufacturer,
                requirement.filmName
              )
            )
        )
        .sort((left, right) => compareCoveragePoolsForRequirement(left, right, requirement));

      for (let poolIndex = 0; poolIndex < compatiblePools.length && remainingNeed > 0; poolIndex += 1) {
        const pool = compatiblePools[poolIndex];
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

function computeOptimisticExistingJobStatus(detail: JobDetail, nextRequirements: JobRequirementLine[]) {
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

function recomputeOptimisticJobDetail(detail: JobDetail): JobDetail {
  const nextRequirements = rebuildRequirementCoverage(detail.requirements, detail.allocations);
  const requiredFeet = nextRequirements.reduce((sum, entry) => sum + entry.requiredFeet, 0);
  const allocatedFeet = nextRequirements.reduce((sum, entry) => sum + entry.allocatedFeet, 0);
  const remainingFeet = nextRequirements.reduce((sum, entry) => sum + entry.remainingFeet, 0);
  const hasOrderedAllocations = detail.allocations.some(
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
      filmOrderCount: detail.filmOrders.length,
      hasOrderedAllocations
    },
    requirements: nextRequirements
  };
}

function buildOptimisticFilmOrderAfterBoxReceipt(
  entry: FilmOrderEntry,
  box: Pick<{ boxId: string; initialFeet: number }, 'boxId' | 'initialFeet'>
): FilmOrderEntry {
  if (entry.status === 'CANCELLED' || entry.status === 'FULFILLED') {
    return entry;
  }

  const nextOrderedFeet =
    Math.max(0, Number(entry.orderedFeet || 0)) + Math.max(0, Number(box.initialFeet || 0));
  const nextRemainingToOrderFeet = Math.max(Math.max(0, Number(entry.requestedFeet || 0)) - nextOrderedFeet, 0);
  const nextStatus =
    nextOrderedFeet >= Math.max(0, Number(entry.requestedFeet || 0)) ? 'FILM_ON_THE_WAY' : 'FILM_ORDER';

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

export function createOptimisticJobDetailAfterFilmOrderReceipt(
  detail: JobDetail,
  filmOrderId: string,
  box: Pick<{ boxId: string; initialFeet: number }, 'boxId' | 'initialFeet'>
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
