export interface AllocationCandidateBox {
  boxId: string;
  feetAvailable: number;
}

export interface PlannedCandidateAllocation {
  boxId: string;
  allocatedFeet: number;
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

export function prioritizeCandidateBoxes<T extends AllocationCandidateBox>(
  candidates: T[],
  preferredBoxIds: Iterable<string> = []
): T[] {
  const preferred = new Set<string>();
  for (const boxId of preferredBoxIds) {
    const normalized = String(boxId || '').trim();
    if (normalized) {
      preferred.add(normalized);
    }
  }

  return candidates.slice().sort((left, right) => {
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
  preferredBoxIds: Iterable<string> = []
): string[] {
  const requested = toRequestedFeet(requestedFeet);
  if (requested <= 0) {
    return [];
  }

  const prioritized = prioritizeCandidateBoxes(candidates, preferredBoxIds);
  const selected: string[] = [];
  let remaining = requested;

  for (let index = 0; index < prioritized.length; index += 1) {
    if (remaining <= 0) {
      break;
    }

    const candidate = prioritized[index];
    const availableFeet = Math.max(0, Math.floor(Number(candidate.feetAvailable || 0)));
    if (availableFeet <= 0) {
      continue;
    }

    selected.push(candidate.boxId);
    remaining -= Math.min(availableFeet, remaining);
  }

  return selected;
}

export function planSelectedCandidateAllocation(
  candidates: AllocationCandidateBox[],
  requestedFeet: number,
  selectedBoxIds: Iterable<string>
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
  let remaining = requested;

  for (let index = 0; index < candidates.length; index += 1) {
    if (remaining <= 0) {
      break;
    }

    const candidate = candidates[index];
    if (!selected.has(candidate.boxId)) {
      continue;
    }

    const availableFeet = Math.max(0, Math.floor(Number(candidate.feetAvailable || 0)));
    if (availableFeet <= 0) {
      continue;
    }

    const allocatedFeet = Math.min(availableFeet, remaining);
    allocations.push({
      boxId: candidate.boxId,
      allocatedFeet
    });
    remaining -= allocatedFeet;
  }

  return {
    allocations,
    coveredFeet: requested - remaining,
    remainingFeet: remaining
  };
}

export function getSelectedExtraBoxIds(
  candidates: AllocationCandidateBox[],
  requestedFeet: number,
  selectedBoxIds: Iterable<string>
): string[] {
  const selected = toNormalizedSelectedSet(selectedBoxIds);
  if (!selected.size) {
    return [];
  }

  const planned = planSelectedCandidateAllocation(candidates, requestedFeet, selected);
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
    const availableFeet = Math.max(0, Math.floor(Number(candidate.feetAvailable || 0)));
    if (allocatedFeet > availableFeet) {
      return {
        extraAllocations: [],
        error: `Extra LF for box ${boxId} cannot exceed ${availableFeet}.`
      };
    }

    extras.push({ boxId, allocatedFeet });
  }

  return {
    extraAllocations: extras,
    error: ''
  };
}

export function canSubmitAllocationRequest(requestedFeet: number, extraAllocationCount: number): boolean {
  return toRequestedFeet(requestedFeet) > 0 || extraAllocationCount > 0;
}
