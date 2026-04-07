import { describe, expect, it } from 'vitest';
import {
  buildJobPlanningFilmFamilyKey,
  canJobPlanningFilmSatisfyRequirement,
  compareJobPlanningFilmMatches,
  getJobPlanningFilmMatch
} from './jobPlanningFilmMatcher.mjs';

describe('jobPlanningFilmMatcher', () => {
  it('collapses RN07 shorthand variants into the same compatible family', () => {
    const baseFamilyKey = buildJobPlanningFilmFamilyKey('Llumar', 'RN 07');

    expect(buildJobPlanningFilmFamilyKey('Llumar', 'RN07')).toBe(baseFamilyKey);
    expect(buildJobPlanningFilmFamilyKey('Llumar', 'Llumar RN07')).toBe(baseFamilyKey);
  });

  it('lets shorthand requirements match longer same-code variants from the same manufacturer', () => {
    expect(
      canJobPlanningFilmSatisfyRequirement(
        'Llumar',
        'RN 07 Refl. One Way Mirror',
        'Llumar',
        'RN 07'
      )
    ).toBe(true);
  });

  it('does not let descriptive requirements automatically match shorter base labels', () => {
    expect(
      canJobPlanningFilmSatisfyRequirement(
        'Llumar',
        'RN 07',
        'Llumar',
        'RN 07 Refl. One Way Mirror'
      )
    ).toBe(false);
  });

  it('keeps manufacturer matching strict', () => {
    expect(
      canJobPlanningFilmSatisfyRequirement(
        'SOLYX',
        'RN 07 Refl. One Way Mirror',
        'Llumar',
        'RN 07'
      )
    ).toBe(false);
  });

  it('ranks exact or base matches ahead of longer descriptive variants', () => {
    const exactMatch = getJobPlanningFilmMatch('Llumar', 'RN07', 'Llumar', 'RN 07');
    const descriptiveMatch = getJobPlanningFilmMatch(
      'Llumar',
      'RN 07 Reflective One Way Mirror',
      'Llumar',
      'RN 07'
    );

    expect(exactMatch).not.toBeNull();
    expect(descriptiveMatch).not.toBeNull();
    expect(compareJobPlanningFilmMatches(exactMatch!, descriptiveMatch!)).toBeLessThan(0);
  });

  it('preserves the Night Vision and exterior regressions', () => {
    expect(
      buildJobPlanningFilmFamilyKey('3M Solar', 'Night Vision 15 Exterior')
    ).toBe(buildJobPlanningFilmFamilyKey('3M Solar', 'NV15 Exterior'));
    expect(
      canJobPlanningFilmSatisfyRequirement(
        '3M Solar',
        'Prestige 60 Exterior',
        '3M Solar',
        'Prestige 60'
      )
    ).toBe(true);
    expect(
      canJobPlanningFilmSatisfyRequirement(
        '3M Solar',
        'Prestige 60',
        '3M Solar',
        'Prestige 60 Exterior'
      )
    ).toBe(false);
  });
});
