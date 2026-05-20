import { planCoverageAllocation } from '../../../../domain/allocationCoverageContract.mjs';
import type { AllocationPreview, FilmOrderEntry, JobRequirementLine, Warehouse } from '../../../../domain';
import { canJobPlanningFilmSatisfyRequirement } from '../../utils/jobPlanningFilmIdentity';

interface LocalSourceSelectionBox {
  boxId: string;
  widthIn?: number | null;
  planningFeet?: number | null;
  allocatableNowFeet?: number | null;
  allocationPlanningFeet?: number | null;
  feetAvailable?: number | null;
}

function getLocalSourcePlanningFeet(sourceBox: LocalSourceSelectionBox) {
  return Math.max(
    0,
    Math.floor(
      Number(
        (sourceBox.planningFeet ??
          sourceBox.allocatableNowFeet ??
          sourceBox.allocationPlanningFeet ??
          sourceBox.feetAvailable) ||
          0
      )
    )
  );
}

export function collectPreferredLinkedBoxIds(
  requirement: JobRequirementLine | null,
  filmOrders: FilmOrderEntry[]
) {
  if (!requirement) {
    return new Set<string>();
  }
  const preferred = new Set<string>();

  for (let index = 0; index < filmOrders.length; index += 1) {
    const order = filmOrders[index];
    if (order.status === 'CANCELLED') {
      continue;
    }

    if (
      !canJobPlanningFilmSatisfyRequirement(
        order.manufacturer,
        order.filmName,
        requirement.manufacturer,
        requirement.filmName
      )
    ) {
      continue;
    }

    if (order.widthIn < requirement.widthIn) {
      continue;
    }

    for (let linkIndex = 0; linkIndex < order.linkedBoxes.length; linkIndex += 1) {
      const boxId = String(order.linkedBoxes[linkIndex].boxId || '').trim();
      if (boxId) {
        preferred.add(boxId);
      }
    }
  }

  return preferred;
}

export function formatPlannedFeet(allocatedFeet: number, coveredFeet: number) {
  if (coveredFeet > 0 && coveredFeet !== allocatedFeet) {
    return `${allocatedFeet} physical / ${coveredFeet} covered`;
  }

  return String(allocatedFeet);
}

export function buildSelectionSummary(preview: AllocationPreview, selectedSuggestionBoxIds: string[]) {
  const selected = new Set(selectedSuggestionBoxIds);
  const allocations: Array<{ boxId: string; allocatedFeet: number; coveredFeet: number }> = [];
  let remaining = preview.requestedFeet;

  if (preview.sourceSuggestedFeet > 0) {
    const sourcePlan = planCoverageAllocation(
      remaining,
      preview.sourceSuggestedFeet,
      preview.sourceWidthIn,
      preview.requestedWidthIn
    );
    allocations.push({
      boxId: preview.sourceBoxId,
      allocatedFeet: sourcePlan.allocatedFeet,
      coveredFeet: sourcePlan.coveredFeet
    });
    remaining = sourcePlan.remainingCoveredFeet;
  }

  for (let index = 0; index < preview.suggestions.length; index += 1) {
    const suggestion = preview.suggestions[index];
    if (!selected.has(suggestion.boxId) || remaining <= 0) {
      continue;
    }

    const nextPlan = planCoverageAllocation(
      remaining,
      suggestion.planningFeet ?? suggestion.availableFeet,
      suggestion.widthIn,
      preview.requestedWidthIn
    );
    allocations.push({
      boxId: suggestion.boxId,
      allocatedFeet: nextPlan.allocatedFeet,
      coveredFeet: nextPlan.coveredFeet
    });
    remaining = nextPlan.remainingCoveredFeet;
  }

  return {
    allocations,
    coveredFeet: preview.requestedFeet - remaining,
    remainingFeet: remaining
  };
}

export function buildLocalSourceSelectionSummary(
  sourceBox: LocalSourceSelectionBox | null,
  requestedFeet: number,
  requestedWidthIn: number
) {
  const requested = Math.max(0, Math.floor(Number(requestedFeet) || 0));
  if (!sourceBox || requested <= 0) {
    return {
      allocations: [],
      coveredFeet: 0,
      remainingFeet: requested
    };
  }

  const sourcePlan = planCoverageAllocation(
    requested,
    getLocalSourcePlanningFeet(sourceBox),
    sourceBox.widthIn,
    requestedWidthIn
  );
  const allocations =
    sourcePlan.allocatedFeet > 0 && sourcePlan.coveredFeet > 0
      ? [
          {
            boxId: sourceBox.boxId,
            allocatedFeet: sourcePlan.allocatedFeet,
            coveredFeet: sourcePlan.coveredFeet
          }
        ]
      : [];

  return {
    allocations,
    coveredFeet: requested - sourcePlan.remainingCoveredFeet,
    remainingFeet: sourcePlan.remainingCoveredFeet
  };
}

export function previewMatchesPayload(
  preview: AllocationPreview | null | undefined,
  payload:
    | {
        boxId: string;
        jobNumber: string;
        installDate: string;
        crewLeader: string;
        requestedFeet: number;
        requestedWidthIn: number;
        requirementId: string;
        crossWarehouse: boolean;
        jobWarehouse: Warehouse;
      }
    | null
) {
  if (!preview || !payload) {
    return false;
  }

  return (
    preview.sourceBoxId === payload.boxId &&
    preview.jobNumber === payload.jobNumber &&
    String(preview.installDate || '') === String(payload.installDate || '') &&
    String(preview.crewLeader || '') === String(payload.crewLeader || '') &&
    preview.requestedFeet === payload.requestedFeet &&
    preview.requestedWidthIn === payload.requestedWidthIn
  );
}
