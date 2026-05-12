import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  validatePlannerSuppressionRequirementOwnership,
} from '../../../shared/domain/plannerSuppressionMutationIdentity.mjs';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_JOB_ID = '22222222-2222-4222-8222-222222222222';

test('shared planner suppression ownership accepts selected FILM requirement rows', () => {
  const result = validatePlannerSuppressionRequirementOwnership({
    requirement: {
      requirementId: 'req-film-1',
      jobId: JOB_ID,
      jobNumber: '19413',
    },
    requirementId: 'req-film-1',
    materialType: 'FILM',
    target: {
      jobId: JOB_ID,
      jobNumber: '19413',
    },
    normalizeJobNumberDigits: (value) => String(value || '').trim(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.materialType, 'FILM');
  assert.equal(result.jobId, JOB_ID);
  assert.equal(result.jobNumber, '19413');
});

test('shared planner suppression ownership accepts selected CAULK requirement rows', () => {
  const result = validatePlannerSuppressionRequirementOwnership({
    requirement: {
      requirementId: 'req-caulk-1',
      jobId: JOB_ID,
      jobNumber: '19413',
    },
    requirementId: 'req-caulk-1',
    materialType: 'CAULK',
    target: {
      jobId: JOB_ID,
      jobNumber: '19413',
    },
    normalizeJobNumberDigits: (value) => String(value || '').trim(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.materialType, 'CAULK');
  assert.equal(result.jobId, JOB_ID);
  assert.equal(result.jobNumber, '19413');
});

test('shared planner suppression ownership rejects rows from another job before clear', () => {
  const result = validatePlannerSuppressionRequirementOwnership({
    requirement: {
      requirementId: 'req-other',
      jobId: OTHER_JOB_ID,
      jobNumber: '19413',
    },
    requirementId: 'req-other',
    materialType: 'FILM',
    target: {
      jobId: JOB_ID,
      jobNumber: '19413',
    },
    normalizeJobNumberDigits: (value) => String(value || '').trim(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'REQUIREMENT_JOB_ID_MISMATCH');
  assert.match(result.message, /different job/);
});

test('shared planner suppression ownership rejects unsupported material types', () => {
  const result = validatePlannerSuppressionRequirementOwnership({
    requirement: {
      requirementId: 'req-unknown',
      jobId: JOB_ID,
      jobNumber: '19413',
    },
    requirementId: 'req-unknown',
    materialType: 'VINYL',
    target: {
      jobId: JOB_ID,
      jobNumber: '19413',
    },
    normalizeJobNumberDigits: (value) => String(value || '').trim(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'UNSUPPORTED_MATERIAL_TYPE');
});

test('backend clear suppression guards canonical jobId requirement ownership while preserving legacy path', () => {
  const runtimeMutations = readFileSync(
    new URL('../../src/app/services/runtime/runtimeJobsMutations.mjs', import.meta.url),
    'utf8'
  );
  const clearStart = runtimeMutations.indexOf('async function clearAllocationPlannerSuppression');
  const clearEnd = runtimeMutations.indexOf('async function deleteFilmOrder', clearStart);
  const clearBody = runtimeMutations.slice(clearStart, clearEnd);

  assert.match(clearBody, /resolveJobMutationTargetById\(client, orgId, payload\)/);
  assert.match(clearBody, /listJobRequirementsByJobId\(client, orgId, target\.jobId\)/);
  assert.match(clearBody, /listJobCaulkRequirementsByJobId\(client, orgId, target\.jobId\)/);
  assert.match(clearBody, /validatePlannerSuppressionRequirementOwnership/);
  assert.match(clearBody, /target\.usedJobId[\s\S]*buildJobDetailById\(client, orgId, target\.jobId\)/);
  assert.match(clearBody, /target\.usedJobId[\s\S]*requireString\(payload\.jobNumber, 'JobNumber'\)/);
});

test('planner suppression clear guard stays transition-only while planner/apply remain jobNumber-based', () => {
  const suppressionMigration = readFileSync(
    new URL('../../migrations/0107_caulk_auto_planner_suppression.sql', import.meta.url),
    'utf8'
  );
  const runtimePlanner = readFileSync(
    new URL('../../src/app/services/runtime/runtimeAutoAllocationPlanner.mjs', import.meta.url),
    'utf8'
  );
  const runtimeApply = readFileSync(
    new URL('../../src/app/services/runtime/runtimeAllocationApply.mjs', import.meta.url),
    'utf8'
  );
  const runtimeMutations = readFileSync(
    new URL('../../src/app/services/runtime/runtimeJobsMutations.mjs', import.meta.url),
    'utf8'
  );

  assert.match(
    suppressionMigration,
    /v_job_number text := app_api\.require_job_number_digits\(p_payload->>'jobNumber'/,
  );
  assert.match(suppressionMigration, /app_api\.reconcile_auto_planned_allocations/);
  assert.doesNotMatch(suppressionMigration, /p_payload->>'jobId'/);
  assert.match(runtimePlanner, /buildAutoPlannerScope/);
  assert.match(runtimeApply, /payload\.jobNumber/);
  assert.match(runtimeMutations, /Guarded transition only: the clear-suppression RPC/);
});
