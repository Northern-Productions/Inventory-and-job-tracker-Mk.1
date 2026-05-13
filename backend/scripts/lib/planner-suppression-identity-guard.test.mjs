import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { clearAllocationPlannerSuppression } from '../../src/app/services/runtime/runtimeJobsMutations.mjs';
import {
  validatePlannerSuppressionRequirementOwnership,
} from '../../../shared/domain/plannerSuppressionMutationIdentity.mjs';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_JOB_ID = '22222222-2222-4222-8222-222222222222';
const FILM_REQUIREMENT_ID = '33333333-3333-4333-8333-333333333333';
const CAULK_REQUIREMENT_ID = '44444444-4444-4444-8444-444444444444';

function buildJobRow(overrides = {}) {
  return {
    id: JOB_ID,
    org_id: 'org-1',
    job_number: '19413',
    warehouse: 'IL1',
    sections: 'Section 1',
    due_date: '2026-04-24',
    crew_leader: 'Crew',
    lifecycle_status: 'ACTIVE',
    is_labor_only: false,
    is_staged_for_pickup: false,
    notes: '',
    created_at: '2026-04-20T10:00:00Z',
    created_by: 'tester',
    updated_at: '2026-04-20T10:00:00Z',
    updated_by: 'tester',
    ...overrides,
  };
}

function buildFilmRequirementRow(overrides = {}) {
  return {
    id: FILM_REQUIREMENT_ID,
    org_id: 'org-1',
    job_id: JOB_ID,
    job_number: '19413',
    manufacturer: '3M Solar',
    film_name: 'Prestige 40',
    width_in: 48,
    required_feet: 40,
    notes: '',
    created_at: '2026-04-20T10:00:00Z',
    created_by: 'tester',
    updated_at: '2026-04-20T10:00:00Z',
    updated_by: 'tester',
    auto_planning_suppressed: true,
    ...overrides,
  };
}

function buildCaulkRequirementRow(overrides = {}) {
  return {
    requirement_id: CAULK_REQUIREMENT_ID,
    org_id: 'org-1',
    job_id: JOB_ID,
    job_number: '19413',
    product_id: '55555555-5555-4555-8555-555555555555',
    manufacturer_id: '66666666-6666-4666-8666-666666666666',
    manufacturer: 'Dow',
    product_name: '790 Black',
    product_code: '790-BLK',
    tubes_per_case: 12,
    required_tubes: 12,
    notes: '',
    updated_at: '2026-04-20T10:00:00Z',
    auto_planning_suppressed: true,
    ...overrides,
  };
}

function createRuntimeClearClient({
  job = buildJobRow(),
  filmRequirement = buildFilmRequirementRow(),
  caulkRequirement = buildCaulkRequirementRow(),
} = {}) {
  const state = {
    rpcPayloads: [],
    calls: [],
  };

  return {
    state,
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
      state.calls.push({ sql, params });

      if (sql.includes('api_acl_clear_allocation_planner_suppression')) {
        state.rpcPayloads.push(JSON.parse(params[2]));
        return { rows: [{ result: { jobNumber: '19413' } }] };
      }

      if (sql.includes('from app.jobs') && sql.includes('and id = $2')) {
        return {
          rows: job && job.id === params[1] ? [{ ...job }] : [],
        };
      }

      if (sql.includes('from app.job_requirements') && sql.includes('r.job_id = $2')) {
        return {
          rows:
            filmRequirement &&
            filmRequirement.job_id === params[1] &&
            filmRequirement.org_id === params[0]
              ? [{ ...filmRequirement }]
              : [],
        };
      }

      if (sql.includes('from app.job_caulk_requirements') && sql.includes('r.job_id = $2')) {
        return {
          rows:
            caulkRequirement &&
            caulkRequirement.job_id === params[1] &&
            caulkRequirement.org_id === params[0]
              ? [{ ...caulkRequirement }]
              : [],
        };
      }

      return { rows: [] };
    },
  };
}

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

test('backend clearAllocationPlannerSuppression allows selected FILM requirement through existing clear behavior', async () => {
  const client = createRuntimeClearClient();

  const response = await clearAllocationPlannerSuppression(
    client,
    'org-1',
    {
      jobId: JOB_ID,
      jobNumber: '19413',
      requirementId: FILM_REQUIREMENT_ID,
      materialType: 'FILM',
      reason: 'Resume film planning.',
    },
    'tester'
  );

  assert.equal(response.ok, true);
  assert.equal(response.data.summary.jobId, JOB_ID);
  assert.deepEqual(client.state.rpcPayloads, [
    {
      jobId: JOB_ID,
      jobNumber: '19413',
      requirementId: FILM_REQUIREMENT_ID,
      materialType: 'FILM',
      reason: 'Resume film planning.',
    },
  ]);
});

test('backend clearAllocationPlannerSuppression allows selected CAULK requirement through existing clear behavior', async () => {
  const client = createRuntimeClearClient();

  const response = await clearAllocationPlannerSuppression(
    client,
    'org-1',
    {
      jobId: JOB_ID,
      jobNumber: '19413',
      requirementId: CAULK_REQUIREMENT_ID,
      materialType: 'CAULK',
      reason: 'Resume caulk planning.',
    },
    'tester'
  );

  assert.equal(response.ok, true);
  assert.equal(response.data.summary.jobId, JOB_ID);
  assert.deepEqual(client.state.rpcPayloads, [
    {
      jobId: JOB_ID,
      jobNumber: '19413',
      requirementId: CAULK_REQUIREMENT_ID,
      materialType: 'CAULK',
      reason: 'Resume caulk planning.',
    },
  ]);
});

test('backend clearAllocationPlannerSuppression rejects mismatched jobId and jobNumber before RPC', async () => {
  const client = createRuntimeClearClient();

  await assert.rejects(
    () =>
      clearAllocationPlannerSuppression(
        client,
        'org-1',
        {
          jobId: JOB_ID,
          jobNumber: '99999',
          requirementId: FILM_REQUIREMENT_ID,
          materialType: 'FILM',
        },
        'tester'
      ),
    /Job identity mismatch/
  );

  assert.deepEqual(client.state.rpcPayloads, []);
});

test('backend clearAllocationPlannerSuppression rejects unowned FILM requirement before RPC', async () => {
  const client = createRuntimeClearClient({
    filmRequirement: buildFilmRequirementRow({
      id: FILM_REQUIREMENT_ID,
      job_id: OTHER_JOB_ID,
    }),
  });

  await assert.rejects(
    () =>
      clearAllocationPlannerSuppression(
        client,
        'org-1',
        {
          jobId: JOB_ID,
          jobNumber: '19413',
          requirementId: FILM_REQUIREMENT_ID,
          materialType: 'FILM',
        },
        'tester'
      ),
    /was not found/
  );

  assert.deepEqual(client.state.rpcPayloads, []);
});

test('backend clearAllocationPlannerSuppression rejects unowned CAULK requirement before RPC', async () => {
  const client = createRuntimeClearClient({
    caulkRequirement: buildCaulkRequirementRow({
      requirement_id: CAULK_REQUIREMENT_ID,
      job_id: OTHER_JOB_ID,
    }),
  });

  await assert.rejects(
    () =>
      clearAllocationPlannerSuppression(
        client,
        'org-1',
        {
          jobId: JOB_ID,
          jobNumber: '19413',
          requirementId: CAULK_REQUIREMENT_ID,
          materialType: 'CAULK',
        },
        'tester'
      ),
    /was not found/
  );

  assert.deepEqual(client.state.rpcPayloads, []);
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

test('planner suppression clear passes canonical jobId while apply remains jobNumber-based', () => {
  const suppressionMigration = readFileSync(
    new URL('../../migrations/0121_planner_suppression_jobid_scope.sql', import.meta.url),
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

  assert.match(suppressionMigration, /v_job_id_text text := app_api\.trim_text\(v_payload->>'jobId'\);/);
  assert.match(suppressionMigration, /where j\.org_id = p_org_id\s+and j\.id = v_job_id/s);
  assert.match(suppressionMigration, /'jobIds', jsonb_build_array\(v_job\.id\)/);
  assert.match(suppressionMigration, /app_api\.reconcile_auto_planned_allocations/);
  assert.doesNotMatch(suppressionMigration, /auto_planner_scope_job_numbers\(/);
  assert.match(runtimePlanner, /buildAutoPlannerScope/);
  assert.match(runtimeApply, /payload\.jobNumber/);
  assert.match(runtimeMutations, /\.\.\.\(target\.usedJobId \? \{ jobId: target\.jobId \} : \{\}\)/);
});
