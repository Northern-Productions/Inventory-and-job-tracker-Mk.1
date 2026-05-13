import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const jobsUpdateJobIdScopeMigration = readFileSync(
  new URL('../../../supabase/migrations/20260513150000_jobs_update_jobid_scope.sql', import.meta.url),
  'utf8'
);
const edgeMutationHandlers = readFileSync(
  new URL('../../../supabase/functions/_shared/routes/mutationHandlers.ts', import.meta.url),
  'utf8'
);

test('api_jobs_update supports canonical jobId targeting while preserving legacy jobNumber fallback', () => {
  const apiJobsUpdateStart = jobsUpdateJobIdScopeMigration.indexOf('create or replace function public.api_jobs_update');
  const apiJobsUpdateEnd = jobsUpdateJobIdScopeMigration.indexOf(
    'create or replace function public.api_acl_jobs_update',
    apiJobsUpdateStart
  );
  const apiJobsUpdateBody = jobsUpdateJobIdScopeMigration.slice(apiJobsUpdateStart, apiJobsUpdateEnd);

  assert.match(apiJobsUpdateBody, /p_payload->>'jobNumber'/);
  assert.match(apiJobsUpdateBody, /p_payload->>'jobId'/);
  assert.match(apiJobsUpdateBody, /where j\.org_id = p_org_id\s+and j\.id = v_job_id/s);
  assert.match(apiJobsUpdateBody, /Job identity mismatch: selected job does not match jobNumber\./);
  assert.match(apiJobsUpdateBody, /else\s+select \*\s+into v_job\s+from app\.jobs j\s+where j\.org_id = p_org_id\s+and j\.job_number = v_job_number/s);
  assert.match(apiJobsUpdateBody, /if not found then\s+v_job\.id := gen_random_uuid\(\);/s);
});

test('api_acl_jobs_update scopes canonical planner reconciliation by jobId', () => {
  const apiAclJobsUpdateStart = jobsUpdateJobIdScopeMigration.indexOf(
    'create or replace function public.api_acl_jobs_update'
  );
  const apiAclJobsUpdateEnd = jobsUpdateJobIdScopeMigration.indexOf('comment on function public.api_jobs_update', apiAclJobsUpdateStart);
  const apiAclJobsUpdateBody = jobsUpdateJobIdScopeMigration.slice(apiAclJobsUpdateStart, apiAclJobsUpdateEnd);

  assert.match(apiAclJobsUpdateBody, /p_payload->>'jobId'/);
  assert.match(apiAclJobsUpdateBody, /perform app_api\.sync_active_job_schedule_allocations_by_job_id\(/);
  assert.match(apiAclJobsUpdateBody, /'jobIds', jsonb_build_array\(v_updated_job\.id\)/);
  assert.match(apiAclJobsUpdateBody, /'jobNumbers', jsonb_build_array\(v_updated_job\.job_number\)/);
  assert.match(apiAclJobsUpdateBody, /v_scope := jsonb_build_object\('jobNumbers', jsonb_build_array\(v_job_number\)\);/);
});

test('edge jobs update documents guarded jobId SQL behavior before calling RPC', () => {
  const updateStart = edgeMutationHandlers.indexOf('"/jobs/update": async');
  const updateEnd = edgeMutationHandlers.indexOf('"/jobs/set-staged-pickup"', updateStart);
  const updateBody = edgeMutationHandlers.slice(updateStart, updateEnd);

  assert.match(updateBody, /resolveEdgeJobMutationTargetById/);
  assert.match(updateBody, /Guarded transition only/);
  assert.match(updateBody, /targets exact jobId only/);
  assert.match(updateBody, /api_acl_jobs_update/);
  assert.match(updateBody, /buildJobDetailById/);
});
