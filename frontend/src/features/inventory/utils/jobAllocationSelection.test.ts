import { describe, expect, it } from 'vitest';
import {
  autoSelectCandidateBoxIds,
  planSelectedCandidateAllocation,
  prioritizeCandidateBoxes,
  type AllocationCandidateBox
} from './jobAllocationSelection';

function buildCandidate(boxId: string, feetAvailable: number): AllocationCandidateBox {
  return {
    boxId,
    feetAvailable
  };
}

describe('jobAllocationSelection', () => {
  it('prioritizes preferred boxes while preserving relative order within each group', () => {
    const candidates = [
      buildCandidate('A', 25),
      buildCandidate('B', 25),
      buildCandidate('C', 25),
      buildCandidate('D', 25)
    ];

    const prioritized = prioritizeCandidateBoxes(candidates, ['C', 'A']);
    expect(prioritized.map((entry) => entry.boxId)).toEqual(['A', 'C', 'B', 'D']);
  });

  it('auto-selects enough boxes to satisfy requested LF', () => {
    const selected = autoSelectCandidateBoxIds(
      [buildCandidate('A', 25), buildCandidate('B', 25), buildCandidate('C', 80)],
      85
    );

    expect(selected).toEqual(['A', 'B', 'C']);
  });

  it('auto-selects preferred boxes first when they are linked to the job film order', () => {
    const selected = autoSelectCandidateBoxIds(
      [buildCandidate('A', 25), buildCandidate('B', 25), buildCandidate('C', 80)],
      85,
      ['C']
    );

    expect(selected).toEqual(['C', 'A']);
  });

  it('calculates planned allocations using selected boxes and candidate order', () => {
    const plan = planSelectedCandidateAllocation(
      [buildCandidate('A', 25), buildCandidate('B', 25), buildCandidate('C', 80)],
      85,
      ['B', 'C']
    );

    expect(plan.allocations).toEqual([
      { boxId: 'B', allocatedFeet: 25 },
      { boxId: 'C', allocatedFeet: 60 }
    ]);
    expect(plan.coveredFeet).toBe(85);
    expect(plan.remainingFeet).toBe(0);
  });
});
