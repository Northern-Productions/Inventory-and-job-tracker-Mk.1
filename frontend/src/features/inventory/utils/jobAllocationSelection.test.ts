import { describe, expect, it } from 'vitest';
import {
  autoSelectCandidateBoxIds,
  buildValidatedExtraAllocations,
  canSubmitAllocationRequest,
  getSelectedExtraBoxIds,
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

  it('detects selected boxes beyond requested coverage as extras', () => {
    const extraBoxIds = getSelectedExtraBoxIds(
      [buildCandidate('A', 25), buildCandidate('B', 25), buildCandidate('C', 80)],
      40,
      ['A', 'B', 'C']
    );

    expect(extraBoxIds).toEqual(['C']);
  });

  it('accepts requested 0 when valid extra allocations are provided', () => {
    const candidates = [buildCandidate('A', 25), buildCandidate('B', 25)];
    const extraBoxIds = getSelectedExtraBoxIds(candidates, 0, ['A']);
    const validation = buildValidatedExtraAllocations(candidates, extraBoxIds, { A: '12' });

    expect(validation.error).toBe('');
    expect(validation.extraAllocations).toEqual([{ boxId: 'A', allocatedFeet: 12 }]);
    expect(canSubmitAllocationRequest(0, validation.extraAllocations.length)).toBe(true);
  });

  it('blocks submit when extra LF is blank or invalid', () => {
    const candidates = [buildCandidate('A', 25)];
    const extraBoxIds = getSelectedExtraBoxIds(candidates, 0, ['A']);
    const blankValidation = buildValidatedExtraAllocations(candidates, extraBoxIds, { A: '' });
    expect(blankValidation.error).toContain('Enter Extra LF');

    const invalidValidation = buildValidatedExtraAllocations(candidates, extraBoxIds, { A: '100' });
    expect(invalidValidation.error).toContain('cannot exceed');
    expect(canSubmitAllocationRequest(0, invalidValidation.extraAllocations.length)).toBe(false);
  });
});
