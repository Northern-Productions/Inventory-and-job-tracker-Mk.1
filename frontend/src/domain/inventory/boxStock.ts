import type { Box } from './boxes';

type PhysicalStockBox = Pick<Box, 'feetAvailable'> &
  Partial<
    Pick<
      Box,
      | 'physicalFeetAvailable'
      | 'initialFeet'
      | 'lastRollWeightLbs'
      | 'coreWeightLbs'
      | 'lfWeightLbsPerFt'
    >
  >;
type AllocatableStockBox = Pick<Box, 'feetAvailable'> &
  Partial<Pick<Box, 'allocatableNowFeet' | 'allocationPlanningFeet'>>;

function normalizeFeetValue(value: unknown): number {
  const numericValue = Number(value ?? 0);
  return Number.isFinite(numericValue) ? Math.max(0, numericValue) : 0;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function normalizeOptionalFeetValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.max(0, numericValue) : null;
}

function derivePhysicalFeetFromRollWeight(box: PhysicalStockBox): number | null {
  const lastRollWeightLbs = normalizeOptionalFeetValue(box.lastRollWeightLbs);
  const coreWeightLbs = normalizeOptionalFeetValue(box.coreWeightLbs);
  const lfWeightLbsPerFt = normalizeOptionalFeetValue(box.lfWeightLbsPerFt);
  const initialFeet = normalizeOptionalFeetValue(box.initialFeet);

  if (
    lastRollWeightLbs === null ||
    coreWeightLbs === null ||
    lfWeightLbsPerFt === null ||
    initialFeet === null ||
    lfWeightLbsPerFt <= 0
  ) {
    return null;
  }

  const rawFeet = roundTo((lastRollWeightLbs - coreWeightLbs) / lfWeightLbsPerFt, 2);
  if (rawFeet <= 0) {
    return 0;
  }

  return Math.min(Math.floor(rawFeet), Math.max(0, Math.floor(initialFeet)));
}

/**
 * PURPOSE:
 * Centralizes inventory stock feet semantics after physical and allocatable LF split.
 *
 * AFFECTS:
 * Inventory list rows, offline inventory ordering, and low-stock badges.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * /boxes/search mapping, box detail stock display, allocation planner box candidates, and offline filters.
 *
 * COMMON FAILURE MODES:
 * Hiding fully reserved boxes, showing allocatable LF as physical stock, or flagging low stock from reserved-adjusted LF.
 */
export function getPhysicalStockFeetValue(box: PhysicalStockBox): number | null {
  return (
    derivePhysicalFeetFromRollWeight(box) ??
    normalizeOptionalFeetValue(box.physicalFeetAvailable) ??
    normalizeOptionalFeetValue(box.feetAvailable)
  );
}

export function getPhysicalStockFeet(box: PhysicalStockBox): number {
  return getPhysicalStockFeetValue(box) ?? 0;
}

export function getAllocatableStockFeet(box: AllocatableStockBox): number {
  return normalizeFeetValue(box.allocatableNowFeet ?? box.allocationPlanningFeet ?? box.feetAvailable);
}
