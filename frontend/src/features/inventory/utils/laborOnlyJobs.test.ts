import { describe, expect, it } from 'vitest';
import {
  hasJobMaterialRequirements,
  hasNoJobMaterialRequirements,
  shouldPromptForLaborOnlyConfirmation
} from './laborOnlyJobs';

describe('laborOnlyJobs', () => {
  it('detects whether a draft has any material requirements', () => {
    expect(hasNoJobMaterialRequirements({ requirements: [], caulkRequirements: [] })).toBe(true);
    expect(
      hasJobMaterialRequirements({
        requirements: [{ requiredFeet: 0 }],
        caulkRequirements: [{ requiredTubes: 0 }]
      })
    ).toBe(false);
    expect(
      hasJobMaterialRequirements({
        requirements: [{ requiredFeet: 12 }],
        caulkRequirements: []
      })
    ).toBe(true);
    expect(
      hasJobMaterialRequirements({
        requirements: [],
        caulkRequirements: [{ requiredTubes: 4 }]
      })
    ).toBe(true);
  });

  it('only prompts for labor-only confirmation when the job is zero-material and not already flagged', () => {
    expect(
      shouldPromptForLaborOnlyConfirmation({
        requirements: [],
        caulkRequirements: []
      })
    ).toBe(true);

    expect(
      shouldPromptForLaborOnlyConfirmation(
        {
          requirements: [],
          caulkRequirements: []
        },
        true
      )
    ).toBe(false);

    expect(
      shouldPromptForLaborOnlyConfirmation({
        requirements: [{ requiredFeet: 8 }],
        caulkRequirements: []
      })
    ).toBe(false);
  });
});
