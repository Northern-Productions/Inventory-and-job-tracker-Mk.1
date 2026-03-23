import type { CaulkStockEntry, JobCaulkRequirementLine, Warehouse } from '../../../domain';

export interface CaulkTubeBreakdown {
  totalTubes: number;
  fullCases: number;
  looseTubes: number;
}

interface CaulkAllocationBreakdownMessageArgs {
  selectedRequirementRemainingTubes?: number | null;
  allocationTubeCount: number;
  tubesPerCase: number;
}

interface AddCaulkAllocationDefaultsArgs {
  requirements: JobCaulkRequirementLine[];
  fallbackProductId: string;
  defaultWarehouse: Warehouse | '';
}

interface AddCaulkAllocationDefaults {
  requirementId: string;
  productId: string;
  warehouse: Warehouse | '';
  allocatedTubes: string;
}

function normalizeWholeNumber(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(Math.floor(value), 0);
}

export function findFirstUnmetCaulkRequirement(requirements: JobCaulkRequirementLine[]) {
  return requirements.find((entry) => entry.remainingTubes > 0) || null;
}

export function buildAddCaulkAllocationDefaults({
  requirements,
  fallbackProductId,
  defaultWarehouse
}: AddCaulkAllocationDefaultsArgs): AddCaulkAllocationDefaults {
  const firstUnmetRequirement = findFirstUnmetCaulkRequirement(requirements);

  if (firstUnmetRequirement) {
    return {
      requirementId: firstUnmetRequirement.requirementId,
      productId: firstUnmetRequirement.productId,
      warehouse: defaultWarehouse,
      allocatedTubes: String(firstUnmetRequirement.remainingTubes)
    };
  }

  return {
    requirementId: '',
    productId: fallbackProductId || requirements[0]?.productId || '',
    warehouse: defaultWarehouse,
    allocatedTubes: '1'
  };
}

export function buildCaulkAllocationValuesForRequirement(requirement: JobCaulkRequirementLine | null) {
  if (!requirement) {
    return null;
  }

  return {
    productId: requirement.productId,
    allocatedTubes: String(normalizeWholeNumber(requirement.remainingTubes))
  };
}

export function getCaulkTubeBreakdown(totalTubes: number, tubesPerCase: number): CaulkTubeBreakdown {
  const safeTotalTubes = normalizeWholeNumber(totalTubes);
  const safeTubesPerCase = normalizeWholeNumber(tubesPerCase);

  if (safeTubesPerCase <= 0) {
    return {
      totalTubes: safeTotalTubes,
      fullCases: 0,
      looseTubes: safeTotalTubes
    };
  }

  return {
    totalTubes: safeTotalTubes,
    fullCases: Math.floor(safeTotalTubes / safeTubesPerCase),
    looseTubes: safeTotalTubes % safeTubesPerCase
  };
}

export function formatCaulkTubeBreakdown(totalTubes: number, tubesPerCase: number) {
  const breakdown = getCaulkTubeBreakdown(totalTubes, tubesPerCase);
  return `${breakdown.totalTubes} tubes | ${breakdown.fullCases} full case${breakdown.fullCases === 1 ? '' : 's'} | ${breakdown.looseTubes} loose tube${breakdown.looseTubes === 1 ? '' : 's'}`;
}

export function buildCaulkAllocationBreakdownMessage({
  selectedRequirementRemainingTubes,
  allocationTubeCount,
  tubesPerCase
}: CaulkAllocationBreakdownMessageArgs) {
  const breakdownLabel = formatCaulkTubeBreakdown(allocationTubeCount, tubesPerCase);

  if (
    typeof selectedRequirementRemainingTubes === 'number' &&
    Number.isFinite(selectedRequirementRemainingTubes) &&
    selectedRequirementRemainingTubes >= 0
  ) {
    return `Prefilled from remaining requirement: ${normalizeWholeNumber(selectedRequirementRemainingTubes)} tubes still needed on this job. ${breakdownLabel}`;
  }

  return `Current allocation breakdown: ${breakdownLabel}`;
}

export function sortCaulkStockEntriesForAllocation(
  entries: CaulkStockEntry[],
  selectedWarehouse: Warehouse | ''
) {
  const normalizedSelectedWarehouse = String(selectedWarehouse || '').trim().toUpperCase();

  return [...entries].sort((left, right) => {
    const leftSelected = left.warehouse === normalizedSelectedWarehouse ? 0 : 1;
    const rightSelected = right.warehouse === normalizedSelectedWarehouse ? 0 : 1;

    if (leftSelected !== rightSelected) {
      return leftSelected - rightSelected;
    }

    return left.warehouse.localeCompare(right.warehouse, undefined, { sensitivity: 'base' });
  });
}
