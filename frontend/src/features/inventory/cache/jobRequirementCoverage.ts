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

type UpdateJobRequirementInput = NonNullable<UpdateJobPayload['requirements']>[number] & {
  requirementId?: string;
};
type UpdateJobCaulkRequirementInput = NonNullable<UpdateJobPayload['caulkRequirements']>[number] & {
  requirementId?: string;
};

function shouldIgnoreOptimisticAllocationCoverage(allocation: AllocationJobDetailEntry) {
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

function normalizeJobNumberKey(value: string) {
  return String(value || '').trim().toUpperCase();
}

function rebuildRequirementCoverage(
  requirements: JobRequirementLine[],
  allocations: AllocationJobDetailEntry[],
  jobNumber: string
) {
  const coverageByRequirementId: Record<string, number> = {};
  const requirementById: Record<string, JobRequirementLine> = {};
  const expectedJobNumber = normalizeJobNumberKey(jobNumber);

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    requirementById[requirement.requirementId] = requirement;
  }

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    const boundRequirementId = String(allocation.requirementId || '').trim();
    const boundRequirement = boundRequirementId ? requirementById[boundRequirementId] : null;
    const coveredFeet = getAllocationCoveredFeet(allocation);
    if (
      allocation.status === 'CANCELLED' ||
      coveredFeet <= 0 ||
      allocation.allocationKind === 'EXTRA' ||
      shouldIgnoreOptimisticAllocationCoverage(allocation) ||
      !boundRequirement
    ) {
      continue;
    }

    if (
      expectedJobNumber &&
      normalizeJobNumberKey(allocation.jobNumber) !== expectedJobNumber
    ) {
      continue;
    }

    if (boundRequirement && allocationMatchesRequirement(allocation, boundRequirement)) {
      const nextCoveredFeet = Math.min(
        Math.max(0, Number(boundRequirement.requiredFeet || 0)),
        Math.max(0, Number(coverageByRequirementId[boundRequirementId] || 0)) + coveredFeet
      );
      coverageByRequirementId[boundRequirementId] = nextCoveredFeet;
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

  if (detail.filmOrders.some((entry) => isUnresolvedFilmOrder(entry))) {
    return 'FILM_ORDER' as const;
  }

  return 'FILM_ORDER';
}

function recomputeOptimisticJobDetail(detail: JobDetail): JobDetail {
  const nextRequirements = rebuildRequirementCoverage(
    detail.requirements,
    detail.allocations,
    detail.summary.jobNumber
  );
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
      filmOrderCount: countUnresolvedFilmOrders(detail.filmOrders),
      hasOrderedAllocations
    },
    requirements: nextRequirements
  };
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

function buildRequirementSuppressionSignature(
  requirement: Pick<JobRequirementLine, 'manufacturer' | 'filmName' | 'widthIn' | 'requiredFeet'>
) {
  return `${buildRequirementIdentityKey(requirement)}|${Math.max(0, Number(requirement.requiredFeet || 0))}`;
}

function compareCatalogStrings(left: string, right: string) {
  return normalizeLookupSegment(left).localeCompare(normalizeLookupSegment(right));
}

function buildCaulkCoverageByRequirementId(detail: JobDetail) {
  const coverageByRequirementId: Record<string, number> = {};
  const requirementById = Object.fromEntries(
    detail.caulkRequirements.map((entry) => [entry.requirementId, entry])
  ) as Record<string, JobCaulkRequirementLine>;

  for (let index = 0; index < detail.caulkAllocations.length; index += 1) {
    const allocation = detail.caulkAllocations[index];
    const requirementId = String(allocation.requirementId || '').trim();
    const requirement = requirementId ? requirementById[requirementId] : null;
    if (
      !requirement ||
      String(allocation.status || '').trim().toUpperCase() === 'CANCELLED' ||
      Number(allocation.allocatedTubes || 0) <= 0 ||
      String(allocation.productId || '').trim() !== String(requirement.productId || '').trim()
    ) {
      continue;
    }

    coverageByRequirementId[requirementId] =
      Math.max(0, Number(coverageByRequirementId[requirementId] || 0)) +
      Math.max(0, Number(allocation.allocatedTubes || 0));
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
    const key = buildRequirementIdentityKey(requirement);
    const currentMatches = unusedCurrentByKey.get(key) || [];
    currentMatches.push(requirement);
    unusedCurrentByKey.set(key, currentMatches);
  }

  return nextRequirements.map((entry, index) => {
    const explicitRequirementId = String(entry.requirementId || '').trim();
    const matchedRequirement = explicitRequirementId
      ? currentRequirementById[explicitRequirementId]
      : (unusedCurrentByKey.get(
          buildRequirementIdentityKey({
            manufacturer: entry.manufacturer,
            filmName: entry.filmName,
            widthIn: entry.widthIn
          })
        ) || [])[0];
    if (!explicitRequirementId && matchedRequirement) {
      const key = buildRequirementIdentityKey(matchedRequirement);
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
      manufacturer: entry.manufacturer,
      filmName: entry.filmName,
      widthIn: entry.widthIn,
      requiredFeet: entry.requiredFeet,
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
      remainingFeet: entry.requiredFeet
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
  const currentRequirementByProductId = Object.fromEntries(
    detail.caulkRequirements.map((entry) => [entry.productId, entry])
  ) as Record<string, JobCaulkRequirementLine>;
  const caulkMetadataByProductId = buildCaulkMetadataLookup(detail, caulkProducts);
  const coverageByRequirementId = buildCaulkCoverageByRequirementId(detail);

  return nextRequirements
    .map((entry, index) => {
      const explicitRequirementId = String(entry.requirementId || '').trim();
      const currentRequirement = explicitRequirementId
        ? currentRequirementById[explicitRequirementId]
        : currentRequirementByProductId[entry.productId];
      const productMetadata = caulkMetadataByProductId[entry.productId];
      const requiredTubes = Math.max(0, Math.floor(Number(entry.requiredTubes || 0)));
      const allocatedTubes = Math.max(0, Number(coverageByRequirementId[explicitRequirementId || currentRequirement?.requirementId || ''] || 0));

      return {
        requirementId:
          explicitRequirementId ||
          currentRequirement?.requirementId ||
          `pending-caulk-req-update-${index + 1}`,
        jobNumber: detail.summary.jobNumber,
        productId: entry.productId,
        manufacturerId: productMetadata?.manufacturerId || currentRequirement?.manufacturerId || '',
        manufacturer: productMetadata?.manufacturer || currentRequirement?.manufacturer || '',
        productName: productMetadata?.productName || currentRequirement?.productName || '',
        productCode: productMetadata?.productCode || currentRequirement?.productCode || '',
        tubesPerCase: productMetadata?.tubesPerCase || currentRequirement?.tubesPerCase || 0,
        requiredTubes,
        allocatedTubes,
        remainingTubes: Math.max(0, requiredTubes - allocatedTubes),
        notes: currentRequirement?.notes || '',
        updatedAt: new Date().toISOString()
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
    (sum, entry) => sum + Math.max(0, Number(entry.requiredTubes || 0)),
    0
  );
  const nextAllocatedTubes = nextCaulkRequirements.reduce(
    (sum, entry) => sum + Math.max(0, Number(entry.allocatedTubes || 0)),
    0
  );
  const nextRemainingTubes = nextCaulkRequirements.reduce(
    (sum, entry) => sum + Math.max(0, Number(entry.remainingTubes || 0)),
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
      ...(payload.sections !== undefined
        ? {
            sections:
              payload.sections === null || payload.sections === undefined || payload.sections === ''
                ? null
                : String(payload.sections)
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
