import type { Box } from './boxes';

type PhysicalStockBox = Pick<Box, 'feetAvailable'> & Partial<Pick<Box, 'physicalFeetAvailable'>>;
type AllocatableStockBox = Pick<Box, 'feetAvailable'> &
  Partial<Pick<Box, 'allocatableNowFeet' | 'allocationPlanningFeet'>>;

function normalizeFeetValue(value: unknown): number {
  const numericValue = Number(value ?? 0);
  return Number.isFinite(numericValue) ? Math.max(0, numericValue) : 0;
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
export function getPhysicalStockFeet(box: PhysicalStockBox): number {
  return normalizeFeetValue(box.physicalFeetAvailable ?? box.feetAvailable);
}

export function getAllocatableStockFeet(box: AllocatableStockBox): number {
  return normalizeFeetValue(box.allocatableNowFeet ?? box.allocationPlanningFeet ?? box.feetAvailable);
}
