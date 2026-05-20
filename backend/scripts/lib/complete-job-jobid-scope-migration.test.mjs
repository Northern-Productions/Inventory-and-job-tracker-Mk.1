import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0132_complete_job_jobid_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260514010000_complete_job_jobid_scope.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const runtimeMutationsPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeJobsMutations.mjs'
);
const edgeApiHandlerPath = path.join(repoRoot, 'supabase', 'functions', '_shared', 'api-handler.ts');
const frontendJobsClientPath = path.join(repoRoot, 'frontend', 'src', 'api', 'features', 'jobsClient.ts');
const frontendLifecycleWorkflowPath = path.join(
  repoRoot,
  'frontend',
  'src',
  'features',
  'inventory',
  'pages',
  'allocation-job',
  'useJobLifecycleWorkflow.ts'
);
const frontendLifecycleMutationPath = path.join(
  repoRoot,
  'frontend',
  'src',
  'features',
  'inventory',
  'hooks',
  'mutations',
  'planning',
  'jobLifecycleMutations.ts'
);

function normalizeNewlines(source) {
  return source.replace(/\r\n/g, '\n');
}

function extractBody(sql, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = normalizeNewlines(sql).match(
    new RegExp(`create or replace function ${escapedName}[\\s\\S]*?as \\$\\$\\n(?<body>[\\s\\S]*?)\\n\\$\\$;`)
  );
  assert.ok(match?.groups?.body, `Expected ${functionName} body.`);
  return match.groups.body;
}

function extractBetween(source, startMarker, endMarker) {
  const normalizedSource = normalizeNewlines(source);
  const start = normalizedSource.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected marker ${startMarker}.`);
  const end = normalizedSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Expected marker ${endMarker}.`);
  return normalizedSource.slice(start, end);
}

test('complete job jobId scope migration stays mirrored and advances schema latest', async () => {
  const [backendMigration, supabaseMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
  assert.match(schemaCheck, /const LATEST_MIGRATION = '0140_box_checkin_physical_lf_reconciliation_priority\.sql';/);
  assert.match(schemaCheck, /app_api\.cancel_active_caulk_allocations_for_job_id\(uuid, text, uuid, text, text, boolean\)/);
  assert.match(schemaCheck, /public\.api_acl_jobs_cancel_caulk_allocations\(uuid, text, jsonb\)/);
});

test('complete job caulk cancellation helper is jobId-scoped and preserves legacy jobNumber behavior', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const byIdBody = extractBody(migration, 'app_api.cancel_active_caulk_allocations_for_job_id');
  const aclBody = extractBody(migration, 'public.api_acl_jobs_cancel_caulk_allocations');

  assert.match(byIdBody, /from app\.jobs j\s+where j\.org_id = p_org_id\s+and j\.id = p_job_id\s+for update;/s);
  assert.match(byIdBody, /perform app_api\.raise_http\(400, 'jobId does not match jobNumber\.'\);/);
  assert.match(byIdBody, /and a\.job_id = v_job\.id\s+and c\.status = 'OPEN'/);
  assert.match(byIdBody, /where a\.org_id = p_org_id\s+and a\.job_id = v_job\.id\s+and a\.status = 'ACTIVE'\s+for update/s);
  assert.match(byIdBody, /app_api\.caulk_cancel_pending_transfer_internal\(/);
  assert.match(byIdBody, /'JOB_ALLOCATION_CANCEL_RETURN'/);
  assert.match(byIdBody, /'jobId', v_job\.id::text/);
  assert.doesNotMatch(byIdBody, /upper\(a\.job_number\) = upper\(v_job_number\)/);
  assert.match(aclBody, /v_job_id_text text := app_api\.trim_text\(v_payload->>'jobId'\);/);
  assert.match(aclBody, /app_api\.cancel_active_caulk_allocations_for_job_id\(/);
  assert.match(aclBody, /app_api\.cancel_active_caulk_allocations_for_job\(/);
  assert.doesNotMatch(migration, /alter table app\.jobs/i);
  assert.doesNotMatch(migration, /drop constraint/i);
  assert.doesNotMatch(migration, /api_jobs_create|api_jobs_check_duplicate/);
});

test('frontend complete job sends canonical jobId and avoids unsafe legacy cache patching', async () => {
  const [clientSource, workflowSource, mutationSource] = await Promise.all([
    readFile(frontendJobsClientPath, 'utf8'),
    readFile(frontendLifecycleWorkflowPath, 'utf8'),
    readFile(frontendLifecycleMutationPath, 'utf8'),
  ]);

  assert.match(clientSource, /export interface CompleteJobPayload \{\s+jobId\?: string;\s+jobNumber: string;/);
  assert.match(workflowSource, /completeJob\(\{\s+\.\.\.\(canonicalJobId \? \{ jobId: canonicalJobId \} : \{\}\),\s+jobNumber: summary\.jobNumber,/);
  assert.match(mutationSource, /mutationFn: \(payload: CompleteJobPayload\) => completeJob\(payload\)/);
  assert.match(mutationSource, /const jobId = String\(payload\.jobId \|\| ''\)\.trim\(\);/);
  assert.match(mutationSource, /inventoryKeys\.jobById\(jobId\)/);
  assert.match(mutationSource, /syncAllocationJobDetail: !jobId,\s+syncLegacyJobDetail: !jobId/);
  assert.match(mutationSource, /invalidateCaulkJobQueries\(queryClient, \{ jobId \}, \{ includeJobCollections: true \}\)/);
});

test('backend complete job validates selected job before side effects and scopes canonical reads by jobId', async () => {
  const runtimeSource = await readFile(runtimeMutationsPath, 'utf8');
  const body = extractBetween(runtimeSource, 'async function completeJob', 'async function reopenJob');

  assert.match(body, /const target = await resolveJobMutationTargetById\(client, orgId, payload\);/);
  assert.ok(
    body.indexOf('resolveJobMutationTargetById(client, orgId, payload)') < body.indexOf('listBoxes(client, orgId)'),
    'Expected selected job validation before checked-out box checks.'
  );
  assert.match(body, /listAllocationsByJobId\(client, orgId, target\.jobId\)/);
  assert.match(body, /listFilmOrdersByJobId\(client, orgId, target\.jobId\)/);
  assert.match(body, /boxJobId === normalizedTargetJobId/);
  assert.match(body, /!boxJobId && normalizeJobNumberKey\(box\.lastCheckoutJob\) === normalizedTargetJobNumber/);
  assert.match(body, /listCaulkJobCheckoutsByJobId\(client, orgId, target\.jobId\)/);
  assert.match(body, /cancelActiveCaulkAllocationsForCompleteJob\(client, orgId, actor, \{\s+jobId: target\.jobId,\s+jobNumber,/);
  assert.match(body, /saveJobRecordById\(client, orgId, existingJob\)/);
  assert.match(body, /target\.usedJobId \? await buildJobDetailById\(client, orgId, target\.jobId\) : await buildJobDetail\(client, orgId, jobNumber\)/);
});

test('Edge complete job validates canonical identity and scopes selected-job side effects', async () => {
  const edgeSource = await readFile(edgeApiHandlerPath, 'utf8');
  const body = extractBetween(edgeSource, 'async function completeJob', 'function formatDeletedJobCleanupWarning');

  assert.match(body, /const target = await resolveEdgeJobMutationTargetById\(client, orgId, payload,/);
  assert.ok(
    body.indexOf('resolveEdgeJobMutationTargetById(client, orgId, payload') < body.indexOf('.from("boxes")'),
    'Expected Edge selected job validation before complete-job blockers.'
  );
  assert.match(body, /\.select\("box_id, last_checkout_job, last_checkout_job_id"\)/);
  assert.match(body, /boxJobId === normalizedTargetJobId/);
  assert.match(body, /\.from\("caulk_job_allocations"\)[\s\S]*\.eq\("job_id", targetJobId\)/);
  assert.match(body, /\.eq\(target\.usedJobId \? "job_id" : "job_number", target\.usedJobId \? targetJobId : jobNumber\)/);
  assert.match(body, /\.\.\.\(target\.usedJobId \? \{ jobId: targetJobId \} : \{\}\),\s+jobNumber,/);
  assert.match(body, /target\.usedJobId \? await buildJobDetailById\(client, orgId, targetJobId\) : await buildJobDetail\(client, orgId, jobNumber\)/);
});

test('complete job jobId scope keeps unrelated lifecycle and mutation families out of scope', async () => {
  const [runtimeSource, edgeSource, clientSource] = await Promise.all([
    readFile(runtimeMutationsPath, 'utf8'),
    readFile(edgeApiHandlerPath, 'utf8'),
    readFile(frontendJobsClientPath, 'utf8'),
  ]);
  const runtimeBody = extractBetween(runtimeSource, 'async function completeJob', 'async function reopenJob');
  const edgeBody = extractBetween(edgeSource, 'async function completeJob', 'function formatDeletedJobCleanupWarning');
  const clientBody = extractBetween(clientSource, 'export interface CompleteJobPayload', 'export interface ReopenJobPayload');

  assert.doesNotMatch(runtimeBody, /cancelJob|deleteJob|deleteFilmOrder|createFilmOrder|checkoutAllJobMaterials|setJobStagedPickup|applyAllocationPlan/);
  assert.doesNotMatch(edgeBody, /cancelJob|deleteJob|deleteFilmOrder|createFilmOrder|executeCheckoutAllJobMaterials|setJobStagedPickup|allocation apply/i);
  assert.doesNotMatch(clientBody, /checkJobDuplicate|createJob\(/);
});
