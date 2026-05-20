import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0134_job_delete_jobid_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260514030000_job_delete_jobid_scope.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const domainPath = path.join(repoRoot, 'frontend', 'src', 'domain', 'inventory', 'planning.ts');
const workflowPath = path.join(
  repoRoot,
  'frontend',
  'src',
  'features',
  'inventory',
  'pages',
  'allocation-job',
  'useJobLifecycleWorkflow.ts'
);
const lifecycleMutationPath = path.join(
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
const runtimeMutationsPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeJobsMutations.mjs'
);
const runtimeCleanupPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeAllocationCleanup.mjs'
);
const jobsRepositoryPath = path.join(repoRoot, 'backend', 'src', 'app', 'repositories', 'jobsRepository.mjs');
const edgeHandlerPath = path.join(repoRoot, 'supabase', 'functions', '_shared', 'api-handler.ts');

function normalizeNewlines(source) {
  return source.replace(/\r\n/g, '\n');
}

function extractBetween(source, startMarker, endMarker) {
  const normalizedSource = normalizeNewlines(source);
  const start = normalizedSource.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected marker ${startMarker}.`);
  const end = normalizedSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Expected marker ${endMarker}.`);
  return normalizedSource.slice(start, end);
}

function extractFrom(source, startMarker) {
  const normalizedSource = normalizeNewlines(source);
  const start = normalizedSource.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected marker ${startMarker}.`);
  return normalizedSource.slice(start);
}

async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

test('job delete guarded transition remains runtime-only', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.equal(await fileExists(backendMigrationPath), false);
  assert.equal(await fileExists(supabaseMigrationPath), false);
  assert.match(schemaCheck, /const LATEST_MIGRATION = '0141_box_checkin_reconcile_same_job_allocations\.sql';/);
});

test('frontend job delete payload sends canonical jobId and avoids same-number detail removal', async () => {
  const [domain, workflow, mutation] = await Promise.all([
    readFile(domainPath, 'utf8'),
    readFile(workflowPath, 'utf8'),
    readFile(lifecycleMutationPath, 'utf8'),
  ]);
  const deleteWorkflowBody = extractBetween(workflow, 'async function handleDeleteJob()', 'function maybeOpenReturnCompletionPrompt');
  const deleteMutationBody = extractFrom(mutation, 'export function useDeleteJob()');

  assert.match(domain, /export interface DeleteJobPayload \{\s+jobId\?: string;\s+jobNumber: string;/);
  assert.match(domain, /export interface DeleteJobResult \{\s+jobId\?: string;\s+jobNumber: string;/);
  assert.match(deleteWorkflowBody, /\.\.\.\(canonicalJobId \? \{ jobId: canonicalJobId \} : \{\}\),\s+jobNumber: summary\.jobNumber/);
  assert.match(deleteMutationBody, /const jobId = String\(payload\.jobId \|\| ''\)\.trim\(\);/);
  assert.match(deleteMutationBody, /inventoryKeys\.jobById\(jobId\)/);
  assert.match(deleteMutationBody, /queryClient\.removeQueries\(\{ queryKey: inventoryKeys\.jobById\(jobId\), exact: true \}\);/);
  assert.match(deleteMutationBody, /if \(jobId\) \{/);
  assert.match(deleteMutationBody, /removeJobPlanningCaches\(queryClient, payload\.jobNumber\);/);
  assert.doesNotMatch(deleteMutationBody, /syncJobDetailCaches\(queryClient/);
});

test('backend local job delete resolves selected job before scoped side effects', async () => {
  const [runtime, cleanup, repository] = await Promise.all([
    readFile(runtimeMutationsPath, 'utf8'),
    readFile(runtimeCleanupPath, 'utf8'),
    readFile(jobsRepositoryPath, 'utf8'),
  ]);
  const deleteBody = extractBetween(runtime, 'async function deleteJob', 'async function createFilmOrder');
  const helperBody = extractBetween(cleanup, 'async function prepareDeletedJobCleanupByJobId', 'async function removeAllocationFromJob');

  assert.match(deleteBody, /requireUuid\(suppliedJobId, 'jobId'\);/);
  assert.match(deleteBody, /const suppliedJobNumber = normalizeJobNumberDigits\(payload\.jobNumber, 'Job ID number'\);/);
  assert.match(deleteBody, /resolveJobMutationTargetById\(client, orgId, \{\s+\.\.\.payload,\s+jobNumber: suppliedJobNumber\s+\}\)/);
  assert.ok(
    deleteBody.indexOf('resolveJobMutationTargetById(client, orgId, {') <
      deleteBody.indexOf('listBoxes(client, orgId)'),
    'Expected selected job validation before checked-out box blocker.'
  );
  assert.match(deleteBody, /listCaulkJobCheckoutsByJobId\(client, orgId, target\.jobId\)/);
  assert.match(deleteBody, /listJobRequirementsByJobId\(client, orgId, target\.jobId\)/);
  assert.match(deleteBody, /listJobCaulkRequirementsByJobId\(client, orgId, target\.jobId\)/);
  assert.match(deleteBody, /prepareDeletedJobCleanupByJobId\(/);
  assert.match(deleteBody, /deleteJobRecordById\(client, orgId, target\.jobId\)/);
  assert.match(deleteBody, /return ok\(target\.usedJobId \? \{ jobId: target\.jobId, jobNumber \} : \{ jobNumber \}, warnings\);/);
  assert.match(helperBody, /listAllocationsByJobId\(client, orgId, jobId\)/);
  assert.match(helperBody, /listFilmOrdersByJobId\(client, orgId, jobId\)/);
  assert.match(helperBody, /listCaulkJobCheckoutsByJobId\(client, orgId, jobId\)/);
  assert.match(helperBody, /jobId,\s+jobNumber,\s+reason: note/);
  assert.match(helperBody, /delete from app\.allocations\s+where org_id = \$1\s+and job_id = \$2/s);
  assert.match(helperBody, /delete from app\.caulk_job_allocations\s+where org_id = \$1\s+and job_id = \$2/s);
  assert.match(helperBody, /job_id = \$2[\s\S]*job_id is null[\s\S]*upper\(trim\(job_number\)\) = upper\(trim\(\$3\)\)/);
  assert.match(repository, /async function deleteJobRecordById\(client, orgId, jobId\)/);
});

test('Edge job delete validates canonical identity before selected-job scoped deletion', async () => {
  const edge = await readFile(edgeHandlerPath, 'utf8');
  const deleteBody = extractBetween(edge, 'async function deleteJob', 'async function recalculateFilmOrderAfterAllocationMutation');

  assert.match(deleteBody, /JOB_ID_PATTERN\.test\(suppliedJobId\)/);
  assert.match(deleteBody, /const suppliedJobNumber = normalizeJobNumberDigits\(requireString\(payload\.jobNumber, "Job ID number"\)\);/);
  assert.match(deleteBody, /resolveEdgeJobMutationTargetById\(client, orgId, \{\s+\.\.\.payload,\s+jobNumber: suppliedJobNumber,\s+\},/);
  assert.ok(
    deleteBody.indexOf('resolveEdgeJobMutationTargetById(client, orgId, {') <
      deleteBody.indexOf('listBoxes(client, orgId)'),
    'Expected Edge selected job validation before checked-out box blocker.'
  );
  assert.match(deleteBody, /listAllocationsByJobIdDirect\(orgId, targetJobId\)/);
  assert.match(deleteBody, /listFilmOrdersByJobIdDirect\(orgId, targetJobId\)/);
  assert.match(deleteBody, /listJobRequirementsByJobIdDirect\(orgId, canonicalHeader\)/);
  assert.match(deleteBody, /listJobCaulkRequirementsByJobIdDirect\(orgId, canonicalHeader\)/);
  assert.match(deleteBody, /listCaulkJobAllocationsByJobIdDirect\(orgId, targetJobId\)/);
  assert.match(deleteBody, /listCaulkJobCheckoutsByJobIdDirect\(orgId, targetJobId\)/);
  assert.match(deleteBody, /\.\.\.\(target\.usedJobId \? \{ jobId: targetJobId \} : \{\}\),\s+jobNumber,/);
  assert.match(deleteBody, /\.eq\(target\.usedJobId \? "job_id" : "job_number", target\.usedJobId \? targetJobId : jobNumber\)/);
  assert.match(deleteBody, /\.eq\("job_id", targetJobId\)/);
  assert.match(deleteBody, /\.is\("job_id", null\)\s+\.eq\("job_number", jobNumber\)/);
  assert.match(deleteBody, /return ok\(target\.usedJobId \? \{ jobId: targetJobId, jobNumber \} : \{ jobNumber \}, warnings\);/);
});
