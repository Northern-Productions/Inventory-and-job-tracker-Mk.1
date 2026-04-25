import { describe, expect, it } from 'vitest';
import {
  autoSelectCandidateBoxIds,
  buildFullBoxExtraAllocations,
  buildValidatedExtraAllocations,
  canSubmitAllocationRequest,
  getSelectedExtraBoxIds,
  planSelectedCandidateAllocation,
  prioritizeCandidateBoxes,
  type AllocationCandidateBox
} from './jobAllocationSelection';

function buildCandidate(
  boxId: string,
  feetAvailable: number,
  overrides: Partial<AllocationCandidateBox> = {}
): AllocationCandidateBox {
  return {
    boxId,
    warehouse: 'IL1',
    feetAvailable,
    widthIn: 60,
    ...overrides
  };
}

describe('jobAllocationSelection', () => {
  it('prioritizes preferred boxes while preserving relative order within each group', () => {
    const candidates = [
      { ...buildCandidate('A', 25), warehouse: 'MS1' },
      { ...buildCandidate('B', 25), warehouse: 'MS1' },
      { ...buildCandidate('C', 25), warehouse: 'MS1' },
      { ...buildCandidate('D', 25), warehouse: 'MS1' }
    ];

    const prioritized = prioritizeCandidateBoxes(candidates, ['C', 'A']);
    expect(prioritized.map((entry) => entry.boxId)).toEqual(['A', 'C', 'B', 'D']);
  });

  it('prioritizes the selected warehouse before other warehouse groups', () => {
    const candidates = [
      { boxId: 'A', warehouse: 'MS1', feetAvailable: 25 },
      { boxId: 'B', warehouse: 'IL1', feetAvailable: 25 },
      { boxId: 'C', warehouse: 'IL1', feetAvailable: 25 },
      { boxId: 'D', warehouse: 'MS1', feetAvailable: 25 }
    ];

    const prioritized = prioritizeCandidateBoxes(candidates, [], 'IL1');
    expect(prioritized.map((entry) => entry.boxId)).toEqual(['B', 'C', 'A', 'D']);
  });

  it('keeps existing within-warehouse ranking while moving the preferred warehouse group first', () => {
    const candidates = [
      { boxId: 'MS1-exact', warehouse: 'MS1', feetAvailable: 25 },
      { boxId: 'IL1-broader', warehouse: 'IL1', feetAvailable: 25 },
      { boxId: 'IL1-legacy', warehouse: 'IL1', feetAvailable: 25 },
      { boxId: 'MS1-broader', warehouse: 'MS1', feetAvailable: 25 }
    ];

    const prioritized = prioritizeCandidateBoxes(candidates, [], 'IL1');
    expect(prioritized.map((entry) => entry.boxId)).toEqual([
      'IL1-broader',
      'IL1-legacy',
      'MS1-exact',
      'MS1-broader'
    ]);
  });

  it('ranks in-stock boxes ahead of transfer boxes, and transfer boxes ahead of ordered boxes', () => {
    const prioritized = prioritizeCandidateBoxes([
      buildCandidate('ordered', 50, { status: 'ORDERED' }),
      buildCandidate('transfer', 50, { status: 'TRANSFER' }),
      buildCandidate('in-stock', 50, { status: 'IN_STOCK' })
    ]);

    expect(prioritized.map((entry) => entry.boxId)).toEqual(['in-stock', 'transfer', 'ordered']);
  });

  it('auto-selects enough boxes to satisfy requested LF', () => {
    const selected = autoSelectCandidateBoxIds(
      [
        { ...buildCandidate('A', 25), warehouse: 'MS1' },
        { ...buildCandidate('B', 25), warehouse: 'IL1' },
        { ...buildCandidate('C', 80), warehouse: 'IL1' }
      ],
      85
    );

    expect(selected).toEqual(['A', 'B', 'C']);
  });

  it('uses allocatableNowFeet ahead of stale display planning LF', () => {
    const selected = autoSelectCandidateBoxIds(
      [
        buildCandidate('stale-display', 100, {
          allocatableNowFeet: 0,
          allocationPlanningFeet: 100
        }),
        buildCandidate('leftover', 100, {
          allocatableNowFeet: 25,
          allocationPlanningFeet: 100
        })
      ],
      20
    );

    expect(selected).toEqual(['leftover']);
  });

  it('auto-selects preferred boxes first when they are linked to the job film order', () => {
    const selected = autoSelectCandidateBoxIds(
      [
        { ...buildCandidate('A', 25), warehouse: 'MS1' },
        { ...buildCandidate('B', 25), warehouse: 'IL1' },
        { ...buildCandidate('C', 80), warehouse: 'IL1' }
      ],
      85,
      ['C']
    );

    expect(selected).toEqual(['C', 'A']);
  });

  it('auto-selects boxes from the preferred warehouse before other warehouses', () => {
    const selected = autoSelectCandidateBoxIds(
      [
        { boxId: 'A', warehouse: 'MS1', feetAvailable: 25 },
        { boxId: 'B', warehouse: 'IL1', feetAvailable: 25 },
        { boxId: 'C', warehouse: 'MS1', feetAvailable: 80 }
      ],
      25,
      [],
      'IL1'
    );

    expect(selected).toEqual(['B']);
  });

  it('calculates planned allocations using selected boxes and candidate order', () => {
    const plan = planSelectedCandidateAllocation(
      [buildCandidate('A', 25), buildCandidate('B', 25), buildCandidate('C', 80)],
      85,
      ['B', 'C']
    );

    expect(plan.allocations).toEqual([
      { boxId: 'B', allocatedFeet: 25, coveredFeet: 25 },
      { boxId: 'C', allocatedFeet: 60, coveredFeet: 60 }
    ]);
    expect(plan.coveredFeet).toBe(85);
    expect(plan.remainingFeet).toBe(0);
  });

  it('uses 72-inch rolls as 2x coverage for bound 36-inch requirements', () => {
    const plan = planSelectedCandidateAllocation(
      [
        { ...buildCandidate('A', 10), widthIn: 72 },
        { ...buildCandidate('B', 10), widthIn: 60 }
      ],
      20,
      ['A'],
      36
    );

    expect(plan.allocations).toEqual([{ boxId: 'A', allocatedFeet: 10, coveredFeet: 20 }]);
    expect(plan.coveredFeet).toBe(20);
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
    expect(validation.extraAllocations).toEqual([{ boxId: 'A', allocatedFeet: 12, coveredFeet: 12 }]);
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

  it('validates extra LF against leftover allocatable capacity, not display planning LF', () => {
    const validation = buildValidatedExtraAllocations(
      [
        buildCandidate('A', 100, {
          allocatableNowFeet: 12,
          allocationPlanningFeet: 100
        })
      ],
      ['A'],
      { A: '13' }
    );

    expect(validation.error).toContain('cannot exceed 12 planning LF');
  });

  it('builds full-box extra allocations in the user selected order', () => {
    const validation = buildFullBoxExtraAllocations(
      [
        { ...buildCandidate('A', 25), planningFeet: 20 },
        buildCandidate('B', 40),
        { ...buildCandidate('C', 15), status: 'ORDERED', planningFeet: 15 }
      ],
      ['C', 'A']
    );

    expect(validation.error).toBe('');
    expect(validation.extraAllocations).toEqual([
      { boxId: 'C', allocatedFeet: 15, coveredFeet: 15 },
      { boxId: 'A', allocatedFeet: 20, coveredFeet: 20 }
    ]);
  });
});
