import { planCoverageAllocation } from '../../../domain/allocationCoverageContract.mjs';

export interface AllocationCandidateBox {
  boxId: string;
  warehouse?: string;
  feetAvailable: number;
  planningFeet?: number;
  allocationPlanningFeet?: number;
  boxStatus?: string;
  status?: string;
  widthIn?: number;
}

export interface PlannedCandidateAllocation {
  boxId: string;
  allocatedFeet: number;
  coveredFeet: number;
}

export interface BuildExtraAllocationsResult {
  extraAllocations: PlannedCandidateAllocation[];
  error: string;
}

function toRequestedFeet(requestedFeet: number) {
  if (!Number.isFinite(requestedFeet) || requestedFeet <= 0) {
    return 0;
  }

  return Math.floor(requestedFeet);
}

function toNormalizedSelectedSet(selectedBoxIds: Iterable<string>) {
  const selected = new Set<string>();
  for (const boxId of selectedBoxIds) {
    const normalized = String(boxId || '').trim();
    if (normalized) {
      selected.add(normalized);
    }
  }
  return selected;
}

function getCandidatePlanningFeet(candidate: AllocationCandidateBox) {
  return Math.max(
    0,
    Math.floor(Number((candidate.planningFeet ?? candidate.allocationPlanningFeet ?? candidate.feetAvailable) || 0))
  );
}

function getCandidateStatusRank(candidate: AllocationCandidateBox) {
  const normalizedStatus = String(candidate.boxStatus || candidate.status || '').trim().toUpperCase();
  if (normalizedStatus === 'IN_STOCK') {
    return 0;
  }

  if (normalizedStatus === 'ORDERED') {
    return 1;
  }

  return 2;
}

function isAllocatableCandidate(candidate: AllocationCandidateBox) {
  const normalizedStatus = String(candidate.boxStatus || candidate.status || '').trim().toUpperCase();
  return normalizedStatus === '' || normalizedStatus === 'IN_STOCK' || normalizedStatus === 'ORDERED';
}

export function prioritizeCandidateBoxes<T extends AllocationCandidateBox>(
  candidates: T[],
  preferredBoxIds: Iterable<string> = [],
  preferredWarehouse = ''
): T[] {
  const preferred = new Set<string>();
  for (const boxId of preferredBoxIds) {
    const normalized = String(boxId || '').trim();
    if (normalized) {
      preferred.add(normalized);
    }
  }

  return candidates.slice().sort((left, right) => {
    const leftStatusRank = getCandidateStatusRank(left);
    const rightStatusRank = getCandidateStatusRank(right);
    if (leftStatusRank !== rightStatusRank) {
      return leftStatusRank - rightStatusRank;
    }

    const leftPreferredWarehouse = String(left.warehouse || '').trim() === preferredWarehouse;
    const rightPreferredWarehouse = String(right.warehouse || '').trim() === preferredWarehouse;
    if (leftPreferredWarehouse !== rightPreferredWarehouse) {
      return leftPreferredWarehouse ? -1 : 1;
    }

    const leftPreferred = preferred.has(left.boxId);
    const rightPreferred = preferred.has(right.boxId);
    if (leftPreferred === rightPreferred) {
      return 0;
    }
    return leftPreferred ? -1 : 1;
  });
}

export function autoSelectCandidateBoxIds(
  candidates: AllocationCandidateBox[],
  requestedFeet: number,
  preferredBoxIds: Iterable<string> = [],
  preferredWarehouse = '',
  requirementWidthIn = 0
): string[] {
  const requested = toRequestedFeet(requestedFeet);
  if (requested <= 0) {
    return [];
  }

  const prioritized = prioritizeCandidateBoxes(candidates, preferredBoxIds, preferredWarehouse);
  const selected: string[] = [];
  let remainingCoverageFeet = requested;

  for (let index = 0; index < prioritized.length; index += 1) {
    if (remainingCoverageFeet <= 0) {
      break;
    }

    const candidate = prioritized[index];
    const planningFeet = getCandidatePlanningFeet(candidate);
    if (!isAllocatableCandidate(candidate) || planningFeet <= 0) {
      continue;
    }

    selected.push(candidate.boxId);
    remainingCoverageFeet = planCoverageAllocation(
      remainingCoverageFeet,
      planningFeet,
      candidate.widthIn,
      requirementWidthIn
    ).remainingCoveredFeet;
  }

  return selected;
}

export function planSelectedCandidateAllocation(
  candidates: AllocationCandidateBox[],
  requestedFeet: number,
  selectedBoxIds: Iterable<string>,
  requirementWidthIn = 0
): {
  allocations: PlannedCandidateAllocation[];
  coveredFeet: number;
  remainingFeet: number;
} {
  const selected = toNormalizedSelectedSet(selectedBoxIds);

  const requested = toRequestedFeet(requestedFeet);
  if (requested <= 0) {
    return {
      allocations: [],
      coveredFeet: 0,
      remainingFeet: 0
    };
  }

  const allocations: PlannedCandidateAllocation[] = [];
  let remainingCoverageFeet = requested;

  for (let index = 0; index < candidates.length; index += 1) {
    if (remainingCoverageFeet <= 0) {
      break;
    }

    const candidate = candidates[index];
    if (!selected.has(candidate.boxId)) {
      continue;
    }

    const planningFeet = getCandidatePlanningFeet(candidate);
    if (!isAllocatableCandidate(candidate) || planningFeet <= 0) {
      continue;
    }

    const nextPlan = planCoverageAllocation(
      remainingCoverageFeet,
      planningFeet,
      candidate.widthIn,
      requirementWidthIn
    );
    const allocatedFeet = nextPlan.allocatedFeet;
    const coveredFeet = nextPlan.coveredFeet;
    if (allocatedFeet <= 0 || coveredFeet <= 0) {
      continue;
    }

    allocations.push({
      boxId: candidate.boxId,
      allocatedFeet,
      coveredFeet
    });
    remainingCoverageFeet = nextPlan.remainingCoveredFeet;
  }

  return {
    allocations,
    coveredFeet: requested - remainingCoverageFeet,
    remainingFeet: remainingCoverageFeet
  };
}

export function getSelectedExtraBoxIds(
  candidates: AllocationCandidateBox[],
  requestedFeet: number,
  selectedBoxIds: Iterable<string>,
  requirementWidthIn = 0
): string[] {
  const selected = toNormalizedSelectedSet(selectedBoxIds);
  if (!selected.size) {
    return [];
  }

  const planned = planSelectedCandidateAllocation(candidates, requestedFeet, selected, requirementWidthIn);
  const plannedByBoxId = new Set(planned.allocations.map((entry) => entry.boxId));
  const extras: string[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!selected.has(candidate.boxId) || plannedByBoxId.has(candidate.boxId)) {
      continue;
    }
    extras.push(candidate.boxId);
  }

  return extras;
}

export function buildValidatedExtraAllocations(
  candidates: AllocationCandidateBox[],
  extraBoxIds: Iterable<string>,
  extraFeetByBoxId: Record<string, string | number | null | undefined>
): BuildExtraAllocationsResult {
  const candidateById = new Map<string, AllocationCandidateBox>();
  for (let index = 0; index < candidates.length; index += 1) {
    candidateById.set(candidates[index].boxId, candidates[index]);
  }

  const extras: PlannedCandidateAllocation[] = [];
  const seen = new Set<string>();
  for (const rawBoxId of extraBoxIds) {
    const boxId = String(rawBoxId || '').trim();
    if (!boxId || seen.has(boxId)) {
      continue;
    }
    seen.add(boxId);

    const candidate = candidateById.get(boxId);
    if (!candidate) {
      return {
        extraAllocations: [],
        error: `Box ${boxId} is not a valid extra-allocation candidate.`
      };
    }

    if (!isAllocatableCandidate(candidate)) {
      return {
        extraAllocations: [],
        error: `Box ${boxId} is no longer allocatable.`
      };
    }

    const rawFeet = String(extraFeetByBoxId[boxId] ?? '').trim();
    if (!rawFeet) {
      return {
        extraAllocations: [],
        error: `Enter Extra LF for box ${boxId}.`
      };
    }

    const parsedFeet = Number(rawFeet);
    if (!Number.isFinite(parsedFeet) || Math.floor(parsedFeet) !== parsedFeet || parsedFeet <= 0) {
      return {
        extraAllocations: [],
        error: `Extra LF for box ${boxId} must be a whole number greater than zero.`
      };
    }

    const allocatedFeet = Math.floor(parsedFeet);
    const planningFeet = getCandidatePlanningFeet(candidate);
    if (allocatedFeet > planningFeet) {
      return {
        extraAllocations: [],
        error: `Extra LF for box ${boxId} cannot exceed ${planningFeet} planning LF.`
      };
    }

    extras.push({ boxId, allocatedFeet, coveredFeet: allocatedFeet });
  }

  return {
    extraAllocations: extras,
    error: ''
  };
}

export function buildFullBoxExtraAllocations(
  candidates: AllocationCandidateBox[],
  selectedBoxIds: Iterable<string>
): BuildExtraAllocationsResult {
  const candidateById = new Map<string, AllocationCandidateBox>();
  for (let index = 0; index < candidates.length; index += 1) {
    candidateById.set(candidates[index].boxId, candidates[index]);
  }

  const extras: PlannedCandidateAllocation[] = [];
  const seen = new Set<string>();
  for (const rawBoxId of selectedBoxIds) {
    const boxId = String(rawBoxId || '').trim();
    if (!boxId || seen.has(boxId)) {
      continue;
    }
    seen.add(boxId);

    const candidate = candidateById.get(boxId);
    if (!candidate) {
      return {
        extraAllocations: [],
        error: `Box ${boxId} is not a valid extra-allocation candidate.`
      };
    }

    if (!isAllocatableCandidate(candidate)) {
      return {
        extraAllocations: [],
        error: `Box ${boxId} is no longer allocatable.`
      };
    }

    const allocatedFeet = getCandidatePlanningFeet(candidate);
    if (allocatedFeet <= 0) {
      return {
        extraAllocations: [],
        error: `Box ${boxId} does not have planning LF available for extra allocation.`
      };
    }

    extras.push({ boxId, allocatedFeet, coveredFeet: allocatedFeet });
  }

  return {
    extraAllocations: extras,
    error: ''
  };
}

export function canSubmitAllocationRequest(requestedFeet: number, extraAllocationCount: number): boolean {
  return toRequestedFeet(requestedFeet) > 0 || extraAllocationCount > 0;
}
