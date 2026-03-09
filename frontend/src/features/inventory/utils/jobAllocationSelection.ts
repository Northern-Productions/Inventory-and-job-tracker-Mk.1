export interface AllocationCandidateBox {
  boxId: string;
  feetAvailable: number;
}

export interface PlannedCandidateAllocation {
  boxId: string;
  allocatedFeet: number;
}

function toRequestedFeet(requestedFeet: number) {
  if (!Number.isFinite(requestedFeet) || requestedFeet <= 0) {
    return 0;
  }

  return Math.floor(requestedFeet);
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
  const selected = new Set<string>();
  for (const boxId of selectedBoxIds) {
    const normalized = String(boxId || '').trim();
    if (normalized) {
      selected.add(normalized);
    }
  }

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
