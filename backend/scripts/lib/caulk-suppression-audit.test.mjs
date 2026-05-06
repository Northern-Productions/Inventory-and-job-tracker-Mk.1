import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifySuppression,
  summarizeReports,
  validateDevDatabaseSelection,
} from '../audit-caulk-suppressions-dev.mjs';

const DEV_REF = 'uxiltcpbhthhinonttrc';
const PROD_REF = 'tiwpulgvxtwlmqdnyuzd';

describe('caulk suppression audit helpers', () => {
  it('blocks PROD database selections', () => {
    assert.throws(
      () =>
        validateDevDatabaseSelection({
          DEV_SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
          DEV_DATABASE_URL: `postgresql://postgres:secret@db.${PROD_REF}.supabase.co:5432/postgres?sslmode=require`,
        }),
      /PROD Supabase project/
    );
  });

  it('accepts only provable DEV database selections', () => {
    const selection = validateDevDatabaseSelection({
      DEV_SUPABASE_URL: `https://${DEV_REF}.supabase.co`,
      DEV_DATABASE_URL: `postgresql://postgres:secret@db.${DEV_REF}.supabase.co:5432/postgres?sslmode=require`,
    });

    assert.equal(selection.projectRef, DEV_REF);
    assert.equal(selection.databasePort, '5432');
  });

  it('classifies blocked planner recreation', () => {
    const result = classifySuppression({
      requirementId: 'req-1',
      neededTubes: 20,
      availablePlannerTubes: 20,
      activeAutoPlannedRows: [],
    });

    assert.equal(result.state, 'blocked_by_suppression');
    assert.equal(result.plannerWouldRecreateWithoutSuppression, true);
    assert.deepEqual(result.projectedBlockedAutoPlannedRows, [{ allocatedTubes: 20 }]);
  });

  it('classifies stale and leaked suppressions', () => {
    assert.equal(
      classifySuppression({
        requirementId: '',
        neededTubes: 20,
        availablePlannerTubes: 20,
        activeAutoPlannedRows: [],
      }).state,
      'stale_suppression'
    );

    assert.equal(
      classifySuppression({
        requirementId: 'req-1',
        neededTubes: 20,
        availablePlannerTubes: 0,
        activeAutoPlannedRows: [{ caulkAllocationId: 'alloc-1', createdAfterSuppression: true }],
      }).state,
      'leaked_active_row_after_suppression'
    );
  });

  it('summarizes projected blocked rows and tubes', () => {
    const blocked = {
      ...classifySuppression({
        requirementId: 'req-1',
        neededTubes: 12,
        availablePlannerTubes: 8,
        activeAutoPlannedRows: [],
      }),
    };
    const stale = {
      ...classifySuppression({
        requirementId: '',
        neededTubes: 0,
        availablePlannerTubes: 0,
        activeAutoPlannedRows: [],
      }),
    };

    assert.deepEqual(summarizeReports([blocked, stale]), {
      activeSuppressions: 2,
      blockedSuppressions: 1,
      staleSuppressions: 1,
      leakedSuppressions: 0,
      plannerWouldRecreateWithoutSuppression: 1,
      projectedBlockedRows: 1,
      projectedBlockedTubes: 8,
    });
  });
});
