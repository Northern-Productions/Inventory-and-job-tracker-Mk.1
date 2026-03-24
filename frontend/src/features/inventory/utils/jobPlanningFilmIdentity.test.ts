import { describe, expect, it } from 'vitest';
import {
  buildJobPlanningFilmKey,
  canonicalizeJobPlanningManufacturerAndFilm
} from './jobPlanningFilmIdentity';

describe('jobPlanningFilmIdentity', () => {
  it('canonicalizes 3M Solar Night Vision aliases to friendly planning names', () => {
    expect(
      canonicalizeJobPlanningManufacturerAndFilm('3M Solar', 'Night Vision 15 (NV15)')
    ).toEqual({
      manufacturer: '3M Solar',
      filmName: 'Night Vision 15'
    });

    expect(canonicalizeJobPlanningManufacturerAndFilm('3M Solar', 'Ultra SNV25')).toEqual({
      manufacturer: '3M Solar',
      filmName: 'Night Vision 25'
    });

    expect(canonicalizeJobPlanningManufacturerAndFilm('3M Solar', 'Security 3M S35NV')).toEqual({
      manufacturer: '3M Solar',
      filmName: 'Night Vision 35'
    });
  });

  it('builds the same planning key for friendly and legacy Night Vision labels', () => {
    const friendlyKey = buildJobPlanningFilmKey('3M Solar', 'Night Vision 15');
    expect(buildJobPlanningFilmKey('3M Solar', 'Night Vision 15 (NV15)')).toBe(friendlyKey);
    expect(buildJobPlanningFilmKey('3M Solar', 'NV15')).toBe(friendlyKey);
  });

  it('leaves non-Night Vision films unchanged', () => {
    expect(canonicalizeJobPlanningManufacturerAndFilm('Madico', 'Graffiti Free 6MIL')).toEqual({
      manufacturer: 'Madico',
      filmName: 'Graffiti Free 6MIL'
    });
  });
});
