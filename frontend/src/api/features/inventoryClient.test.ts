import { describe, expect, it } from 'vitest';
import { normalizeHasLabel, normalizeOrderedForJobs } from './inventoryClient';

describe('normalizeOrderedForJobs', () => {
  it('returns an empty list when the field is missing or empty', () => {
    expect(normalizeOrderedForJobs(undefined)).toEqual([]);
    expect(normalizeOrderedForJobs([])).toEqual([]);
  });

  it('normalizes one or more structured ordered-for jobs', () => {
    expect(
      normalizeOrderedForJobs([
        { jobNumber: ' 4953 ', filmOrderId: ' FO-1 ', orderedFeet: '120.9' },
        { jobNumber: '16242', filmOrderId: '', orderedFeet: null },
      ])
    ).toEqual([
      { jobNumber: '4953', filmOrderId: 'FO-1', orderedFeet: 120 },
      { jobNumber: '16242', filmOrderId: undefined, orderedFeet: null },
    ]);
  });

  it('ignores legacy note-only or malformed entries without a structured job number', () => {
    expect(normalizeOrderedForJobs([{ notes: 'Ordered for job 4953 via FO-1' }, null])).toEqual([]);
  });
});

describe('normalizeHasLabel', () => {
  it('defaults legacy missing values to labeled', () => {
    expect(normalizeHasLabel(undefined)).toBe(true);
    expect(normalizeHasLabel(null)).toBe(true);
  });

  it('preserves explicit unlabeled boxes', () => {
    expect(normalizeHasLabel(false)).toBe(false);
    expect(normalizeHasLabel(true)).toBe(true);
  });
});
