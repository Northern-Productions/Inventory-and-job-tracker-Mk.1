import type {
  CaulkJobAllocationEntry,
  CaulkStockEntry,
  JobCaulkRequirementLine,
  Warehouse
} from '../../../domain';

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

interface CaulkAllocationTransferPlanArgs {
  mode: 'add' | 'edit';
  productId: string;
  warehouse: Warehouse | '';
  allocatedTubesInput: string;
  stockEntries: CaulkStockEntry[];
  existingAllocation?: Pick<
    CaulkJobAllocationEntry,
    'productId' | 'warehouse' | 'allocatedTubes' | 'reservedTubesRemaining' | 'checkedOutTubesTotal'
  > | null;
}

export interface CaulkAllocationTransferPlan {
  reserveDeltaTubes: number;
  targetWarehouseTubesOnHand: number;
  shortageTubes: number;
  eligibleSourceStock: CaulkStockEntry[];
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

export function getCaulkAllocationTransferPlan({
  mode,
  productId,
  warehouse,
  allocatedTubesInput,
  stockEntries,
  existingAllocation = null
}: CaulkAllocationTransferPlanArgs): CaulkAllocationTransferPlan {
  const normalizedWarehouse = String(warehouse || '').trim().toUpperCase();
  const normalizedProductId = String(productId || '').trim();
  const nextAllocatedTubes = normalizeWholeNumber(Number(allocatedTubesInput));

  if (!normalizedWarehouse || !normalizedProductId || nextAllocatedTubes <= 0) {
    return {
      reserveDeltaTubes: 0,
      targetWarehouseTubesOnHand: 0,
      shortageTubes: 0,
      eligibleSourceStock: []
    };
  }

  const targetWarehouseTubesOnHand = Math.max(
    stockEntries.find((entry) => entry.warehouse === normalizedWarehouse)?.tubesOnHand || 0,
    0
  );

  let reserveDeltaTubes = nextAllocatedTubes;
  if (mode === 'edit' && existingAllocation) {
    const changingProductOrWarehouse =
      existingAllocation.productId !== normalizedProductId ||
      existingAllocation.warehouse !== normalizedWarehouse;
    const currentlyCoveredTubes = normalizeWholeNumber(
      existingAllocation.reservedTubesRemaining + existingAllocation.checkedOutTubesTotal
    );

    reserveDeltaTubes = changingProductOrWarehouse
      ? nextAllocatedTubes
      : Math.max(nextAllocatedTubes - currentlyCoveredTubes, 0);
  }

  const shortageTubes = Math.max(reserveDeltaTubes - targetWarehouseTubesOnHand, 0);
  const eligibleSourceStock =
    shortageTubes <= 0
      ? []
      : stockEntries
          .filter(
            (entry) =>
              entry.productId === normalizedProductId &&
              entry.warehouse !== normalizedWarehouse &&
              Math.max(entry.tubesOnHand, 0) >= shortageTubes
          )
          .sort((left, right) => {
            if (right.tubesOnHand !== left.tubesOnHand) {
              return right.tubesOnHand - left.tubesOnHand;
            }

            return left.warehouse.localeCompare(right.warehouse, undefined, { sensitivity: 'base' });
          });

  return {
    reserveDeltaTubes,
    targetWarehouseTubesOnHand,
    shortageTubes,
    eligibleSourceStock
  };
}
