import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workScopeMigration = readFileSync(
  new URL('../../../supabase/migrations/20260510180000_job_work_scope.sql', import.meta.url),
  'utf8'
);
const edgeMutationHandlers = readFileSync(
  new URL('../../../supabase/functions/_shared/routes/mutationHandlers.ts', import.meta.url),
  'utf8'
);

test('api_acl_jobs_update remains jobNumber-targeted until a future RPC migration', () => {
  const apiJobsUpdateStart = workScopeMigration.indexOf('create or replace function public.api_jobs_update');
  const apiJobsUpdateEnd = workScopeMigration.indexOf('create or replace function public.api_acl_jobs_update', apiJobsUpdateStart);
  const apiJobsUpdateBody = workScopeMigration.slice(apiJobsUpdateStart, apiJobsUpdateEnd);

  assert.match(apiJobsUpdateBody, /p_payload->>'jobNumber'/);
  assert.match(apiJobsUpdateBody, /where j\.org_id = p_org_id\s+and j\.job_number =/);
  assert.doesNotMatch(apiJobsUpdateBody, /p_payload->>'jobId'/);
  assert.doesNotMatch(apiJobsUpdateBody, /where j\.org_id = p_org_id\s+and j\.id =/);
});

test('edge jobs update documents guarded transition before calling existing RPC', () => {
  const updateStart = edgeMutationHandlers.indexOf('"/jobs/update": async');
  const updateEnd = edgeMutationHandlers.indexOf('"/jobs/set-staged-pickup"', updateStart);
  const updateBody = edgeMutationHandlers.slice(updateStart, updateEnd);

  assert.match(updateBody, /resolveEdgeJobMutationTargetById/);
  assert.match(updateBody, /Guarded transition only/);
  assert.match(updateBody, /api_acl_jobs_update/);
  assert.match(updateBody, /buildJobDetailById/);
});
