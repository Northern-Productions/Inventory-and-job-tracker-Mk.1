import { describe, expect, it } from 'vitest';
import {
  canonicalizeJobNumberSearchDigits,
  getJobNumberSearchMatch,
  rankJobNumberSearchCandidates
} from './jobNumberSearchMatcher.mjs';

interface SearchEntry {
  jobNumber: string;
  dueDate: string;
}

function buildEntry(jobNumber: string, dueDate = '2026-04-10'): SearchEntry {
  return {
    jobNumber,
    dueDate
  };
}

describe('jobNumberSearchMatcher', () => {
  it('prioritizes exact, then prefix, then contains matches', () => {
    const ranked = rankJobNumberSearchCandidates(
      [
        buildEntry('2171705'),
        buildEntry('171700'),
        buildEntry('17170')
      ],
      '17170'
    ) as SearchEntry[];

    expect(ranked.map((entry: SearchEntry) => entry.jobNumber)).toEqual(['17170', '171700', '2171705']);
  });

  it('treats leading zeros as equivalent for exact matching', () => {
    expect(canonicalizeJobNumberSearchDigits('000123')).toBe('123');
    expect(getJobNumberSearchMatch('000123', '123')?.kind).toBe('exact');
    expect(getJobNumberSearchMatch('123', '000123')?.kind).toBe('exact');
  });

  it('does not return unrelated near-number neighbors', () => {
    const ranked = rankJobNumberSearchCandidates(
      [
        buildEntry('4217'),
        buildEntry('17045')
      ],
      '1854'
    ) as SearchEntry[];

    expect(ranked).toEqual([]);
  });

  it('uses the provided tie-breaker inside the same match tier', () => {
    const ranked = rankJobNumberSearchCandidates(
      [
        buildEntry('171701', '2026-04-09'),
        buildEntry('171700', '2026-04-12')
      ],
      '17170',
      {
        compareWithinMatch: (left: SearchEntry, right: SearchEntry) =>
          right.dueDate.localeCompare(left.dueDate)
      }
    ) as SearchEntry[];

    expect(ranked.map((entry: SearchEntry) => entry.jobNumber)).toEqual(['171700', '171701']);
  });
});
