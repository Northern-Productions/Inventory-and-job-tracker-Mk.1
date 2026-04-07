import { describe, expect, it } from 'vitest';
import {
  getBoxSearchMatch,
  matchesBoxSearchQuery,
  rankBoxSearchCandidates
} from './boxSearchMatcher.mjs';

function createCandidate(overrides: Partial<{
  boxId: string;
  manufacturer: string;
  filmName: string;
  lotRun: string;
  filmKey: string;
}> = {}) {
  return {
    boxId: 'IL1-1000',
    manufacturer: 'SOLYX',
    filmName: 'Frosted Stripes',
    lotRun: '',
    filmKey: 'SOLYX|FROSTED STRIPES',
    ...overrides
  };
}

describe('boxSearchMatcher', () => {
  it('matches ordered subsequences so sx-1418 finds SXC-1418 labels', () => {
    const match = getBoxSearchMatch(
      createCandidate({
        filmName: 'Frosted Stripes SXC-1418',
        filmKey: 'SOLYX|FROSTED STRIPES SXC-1418'
      }),
      'sx-1418'
    );

    expect(match).toMatchObject({
      kind: 'subsequence',
      field: 'filmName'
    });
  });

  it('ranks exact and prefix matches ahead of contains and subsequence matches', () => {
    const ranked = rankBoxSearchCandidates(
      [
        createCandidate({ boxId: 'contains', filmName: 'Frosted SX-1418' }),
        createCandidate({ boxId: 'subsequence', filmName: 'SXC-1418' }),
        createCandidate({ boxId: 'prefix', filmName: 'SX-1418 Frosted' }),
        createCandidate({ boxId: 'exact', filmName: 'SX-1418' })
      ],
      'sx-1418'
    );

    expect(ranked.map((entry: { boxId: string }) => entry.boxId)).toEqual([
      'exact',
      'prefix',
      'contains',
      'subsequence'
    ]);
  });

  it('matches separator-insensitive queries across box ids and film names', () => {
    expect(
      matchesBoxSearchQuery(
        createCandidate({
          boxId: 'IL1-SXC-1418'
        }),
        'sxc1418'
      )
    ).toBe(true);

    expect(
      matchesBoxSearchQuery(
        createCandidate({
          filmName: 'Frosted Stripes SXC-1418',
          filmKey: 'SOLYX|FROSTED STRIPES SXC-1418'
        }),
        'sxc1418'
      )
    ).toBe(true);
  });

  it('does not match unrelated codes', () => {
    expect(
      matchesBoxSearchQuery(
        createCandidate({
          filmName: 'Whiteout SXWF-WO',
          filmKey: 'SOLYX|WHITEOUT SXWF-WO'
        }),
        'sx-1418'
      )
    ).toBe(false);
  });
});
