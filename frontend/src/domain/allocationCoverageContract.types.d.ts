declare module './allocationCoverageContract.mjs' {
  export function isSplitCoveragePair(sourceWidthIn: unknown, requirementWidthIn: unknown): boolean;
  export function getAllocationCoverageMultiplier(sourceWidthIn: unknown, requirementWidthIn: unknown): number;
  export function computePhysicalFeetForCoverage(
    requestedCoveredFeet: unknown,
    sourceWidthIn: unknown,
    requirementWidthIn: unknown
  ): number;
  export function computeCoveredFeetForAllocation(
    allocatedFeet: unknown,
    sourceWidthIn: unknown,
    requirementWidthIn: unknown,
    maxCoveredFeet?: unknown
  ): number;
  export function planCoverageAllocation(
    requestedCoveredFeet: unknown,
    availablePhysicalFeet: unknown,
    sourceWidthIn: unknown,
    requirementWidthIn: unknown
  ): {
    allocatedFeet: number;
    coveredFeet: number;
    remainingCoveredFeet: number;
    usesSplitCoverage: boolean;
  };
}
