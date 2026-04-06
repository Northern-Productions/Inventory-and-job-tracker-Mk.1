import { describe, expect, it } from 'vitest';
import {
  computeCoveredFeetForAllocation,
  computePhysicalFeetForCoverage,
  getAllocationCoverageMultiplier,
  isSplitCoveragePair,
  planCoverageAllocation
} from './allocationCoverageContract.mjs';

describe('allocationCoverageContract', () => {
  it('only applies split coverage to exact 72-to-36 matches', () => {
    expect(isSplitCoveragePair(72, 36)).toBe(true);
    expect(getAllocationCoverageMultiplier(72, 36)).toBe(2);
    expect(getAllocationCoverageMultiplier(60, 36)).toBe(1);
    expect(getAllocationCoverageMultiplier(72, 48)).toBe(1);
  });

  it('rounds physical feet up for odd 36-inch covered requests', () => {
    expect(computePhysicalFeetForCoverage(5, 72, 36)).toBe(3);
    expect(computeCoveredFeetForAllocation(3, 72, 36, 5)).toBe(5);
  });

  it('plans 20 covered LF from a 72-inch roll as 10 physical LF for a 36-inch requirement', () => {
    expect(planCoverageAllocation(20, 10, 72, 36)).toEqual({
      allocatedFeet: 10,
      coveredFeet: 20,
      remainingCoveredFeet: 0,
      usesSplitCoverage: true
    });
  });

  it('caps covered feet when the physical source roll cannot satisfy the full split request', () => {
    expect(planCoverageAllocation(20, 8, 72, 36)).toEqual({
      allocatedFeet: 8,
      coveredFeet: 16,
      remainingCoveredFeet: 4,
      usesSplitCoverage: true
    });
  });
});
