import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveJobMutationTargetById } from '../../src/app/services/runtime/jobMutationIdentity.mjs';
import {
  validateResolvedJobMutationIdentity,
} from '../../../shared/domain/jobMutationIdentity.mjs';

const JOB_ID = '11111111-1111-4111-8111-111111111111';

function buildJobRow(overrides = {}) {
  return {
    id: JOB_ID,
    org_id: 'org-1',
    job_number: '000123',
    warehouse: 'IL1',
    sections: 'Section 1',
    due_date: '2026-05-01',
    crew_leader: 'Crew A',
    lifecycle_status: 'COMPLETED',
    is_labor_only: false,
    is_staged_for_pickup: false,
    notes: '',
    created_at: '2026-05-01T00:00:00Z',
    created_by: 'tester',
    updated_at: '2026-05-01T00:00:00Z',
    updated_by: 'tester',
    ...overrides,
  };
}

function buildFakeClient(row = buildJobRow(), calls = []) {
  return {
    async query(_sql, params) {
      calls.push(params);
      return {
        rows: params[0] === 'org-from-auth' && params[1] === JOB_ID ? [row] : [],
      };
    },
  };
}

test('shared job mutation identity validates matching jobId and jobNumber', () => {
  const result = validateResolvedJobMutationIdentity(
    { jobId: JOB_ID, jobNumber: '000123' },
    { id: JOB_ID, jobNumber: '000123' },
    { normalizeJobNumberDigits: (value) => String(value || '').trim() }
  );

  assert.equal(result.ok, true);
  assert.equal(result.jobId, JOB_ID);
  assert.equal(result.jobNumber, '000123');
});

test('shared job mutation identity rejects mismatched jobId and jobNumber', () => {
  const result = validateResolvedJobMutationIdentity(
    { jobId: JOB_ID, jobNumber: '000999' },
    { id: JOB_ID, jobNumber: '000123' },
    { normalizeJobNumberDigits: (value) => String(value || '').trim() }
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'JOB_ID_JOB_NUMBER_MISMATCH');
  assert.match(result.message, /Job identity mismatch/);
});

test('backend job mutation identity resolves jobId with auth-derived org', async () => {
  const calls = [];
  const target = await resolveJobMutationTargetById(
    buildFakeClient(buildJobRow(), calls),
    'org-from-auth',
    {
      orgId: 'request-org-ignored',
      jobId: JOB_ID,
      jobNumber: '000123',
    }
  );

  assert.deepEqual(calls, [['org-from-auth', JOB_ID]]);
  assert.equal(target.usedJobId, true);
  assert.equal(target.jobId, JOB_ID);
  assert.equal(target.jobNumber, '000123');
});

test('backend job mutation identity rejects mismatched jobId and jobNumber', async () => {
  await assert.rejects(
    resolveJobMutationTargetById(
      buildFakeClient(),
      'org-from-auth',
      {
        jobId: JOB_ID,
        jobNumber: '000999',
      }
    ),
    /Job identity mismatch/
  );
});

test('backend reopenJob accepts jobId and reloads jobId detail without changing duplicate create guard', () => {
  const runtimeMutations = readFileSync(
    new URL('../../src/app/services/runtime/runtimeJobsMutations.mjs', import.meta.url),
    'utf8'
  );
  const reopenStart = runtimeMutations.indexOf('async function reopenJob');
  const reopenEnd = runtimeMutations.indexOf('async function deleteJob', reopenStart);
  const reopenBody = runtimeMutations.slice(reopenStart, reopenEnd);

  assert.match(reopenBody, /resolveJobMutationTargetById\(client, orgId, payload\)/);
  assert.match(reopenBody, /target\.usedJobId \? await buildJobDetailById/);
  assert.match(runtimeMutations, /`Job \$\{jobNumber\} already exists\.`/);
});

test('backend updateJob guards jobId identity while preserving legacy jobNumber behavior', () => {
  const runtimeMutations = readFileSync(
    new URL('../../src/app/services/runtime/runtimeJobsMutations.mjs', import.meta.url),
    'utf8'
  );
  const updateStart = runtimeMutations.indexOf('async function updateJob');
  const updateEnd = runtimeMutations.indexOf('async function completeJob', updateStart);
  const updateBody = runtimeMutations.slice(updateStart, updateEnd);

  assert.match(updateBody, /resolveJobMutationTargetById\(client, orgId, payload\)/);
  assert.match(updateBody, /target\.usedJobId[\s\S]*saveJobRecordById/);
  assert.match(updateBody, /target\.usedJobId[\s\S]*listJobRequirementsByJobId/);
  assert.match(updateBody, /target\.usedJobId[\s\S]*buildJobDetailById/);
  assert.match(updateBody, /ensureJobHeaderForUpdate\(client, orgId, jobNumber, updatePayload/);
  assert.match(runtimeMutations, /`Job \$\{jobNumber\} already exists\.`/);
});
