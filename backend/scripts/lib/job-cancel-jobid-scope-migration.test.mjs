import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0133_job_cancel_jobid_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260514020000_job_cancel_jobid_scope.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const domainPath = path.join(repoRoot, 'frontend', 'src', 'domain', 'inventory', 'planning.ts');
const filmOrdersClientPath = path.join(repoRoot, 'frontend', 'src', 'api', 'features', 'filmOrdersClient.ts');
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
const edgeHandlersPath = path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'mutationHandlers.ts');

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

test('job cancel jobId scope migration stays mirrored and advances schema latest', async () => {
  const [backendMigration, supabaseMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
  assert.match(schemaCheck, /const LATEST_MIGRATION = '0143_multi_phase_jobs\.sql';/);
  assert.match(schemaCheck, /public\.api_film_orders_cancel\(uuid, text, jsonb\)/);
});

test('job cancel SQL scopes canonical branch by selected job id and preserves legacy branch', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const cancelBody = extractBody(migration, 'public.api_film_orders_cancel');
  const aclBody = extractBody(migration, 'public.api_acl_film_orders_cancel');

  assert.match(cancelBody, /v_job_id_text text := app_api\.trim_text\(v_payload->>'jobId'\);/);
  assert.match(cancelBody, /v_job_id_text !~\* '\^\[0-9a-f\]\{8\}-/);
  assert.match(cancelBody, /from app\.jobs j\s+where j\.org_id = p_org_id\s+and j\.id = v_job_id\s+for update;/s);
  assert.match(cancelBody, /Job identity mismatch: jobId %s belongs to job %s, not %s\./);
  assert.match(cancelBody, /and a\.job_id = v_selected_job\.id/);
  assert.match(cancelBody, /upper\(a\.job_number\) = upper\(v_job_number\)/);
  assert.match(cancelBody, /and f\.job_id = v_selected_job\.id/);
  assert.match(cancelBody, /upper\(f\.job_number\) = upper\(v_job_number\)/);
  assert.match(cancelBody, /and id = v_selected_job\.id/);
  assert.match(cancelBody, /and job_number = v_job_number/);
  assert.match(cancelBody, /jsonb_build_object\('jobId', v_selected_job\.id::text\)/);
  assert.match(aclBody, /v_job_id_text text := app_api\.trim_text\(v_payload->>'jobId'\);/);
  assert.match(aclBody, /return public\.api_film_orders_cancel\(p_org_id, p_actor, v_payload\);/);
  assert.doesNotMatch(migration, /app_api\.cancel_active_caulk_allocations_for_job\(/);
  assert.doesNotMatch(migration, /JOB_ALLOCATION_CANCEL_RETURN/);
  assert.doesNotMatch(migration, /caulk_job_allocations/);
  assert.doesNotMatch(migration, /api_film_orders_delete|api_jobs_create|api_jobs_check_duplicate|api_jobs_complete/);
  assert.doesNotMatch(migration, /alter table app\.jobs/i);
  assert.doesNotMatch(migration, /drop constraint/i);
});

test('frontend cancel payload accepts jobId and canonical cache avoids legacy detail patching', async () => {
  const [domain, client, mutation] = await Promise.all([
    readFile(domainPath, 'utf8'),
    readFile(filmOrdersClientPath, 'utf8'),
    readFile(lifecycleMutationPath, 'utf8'),
  ]);
  const cancelMutationBody = extractBetween(
    mutation,
    'export function useCancelJob()',
    'export function useCompleteJob()'
  );

  assert.match(domain, /export interface CancelJobPayload \{\s+jobId\?: string;\s+jobNumber: string;/);
  assert.match(domain, /export interface CancelJobResult \{\s+jobId\?: string;\s+jobNumber: string;/);
  assert.match(client, /payload: CancelJobPayload/);
  assert.match(client, /request<CancelJobResult>\('POST', '\/film-orders\/cancel'/);
  assert.match(cancelMutationBody, /mutationFn: \(payload: CancelJobPayload\) => cancelJob\(payload\)/);
  assert.match(cancelMutationBody, /const jobId = String\(payload\.jobId \|\| ''\)\.trim\(\);/);
  assert.match(cancelMutationBody, /inventoryKeys\.jobById\(jobId\)/);
  assert.match(cancelMutationBody, /if \(jobId\) \{/);
  assert.match(cancelMutationBody, /queryClient\.invalidateQueries\(\{ queryKey: inventoryKeys\.jobById\(jobId\) \}\)/);
  assert.match(cancelMutationBody, /queryClient\.invalidateQueries\(\{ queryKey: inventoryKeys\.allocationJob\(variables\.jobNumber\) \}\)/);
  assert.doesNotMatch(cancelMutationBody, /syncJobDetailCaches\(queryClient/);
});

test('backend local cancel validates selected job before canonical side effects', async () => {
  const [runtime, cleanup] = await Promise.all([
    readFile(runtimeMutationsPath, 'utf8'),
    readFile(runtimeCleanupPath, 'utf8'),
  ]);
  const cancelBody = extractBetween(runtime, 'async function cancelJob', 'async function removeJobBoxAllocation');
  const helperBody = extractBetween(cleanup, 'async function cancelJobAndReleaseAllocationsByJobId', 'function formatDeletedJobCleanupWarning');

  assert.match(cancelBody, /requireUuid\(suppliedJobId, 'jobId'\);/);
  assert.match(cancelBody, /const target = await resolveJobMutationTargetById\(client, orgId, payload\);/);
  assert.ok(
    cancelBody.indexOf('resolveJobMutationTargetById(client, orgId, payload)') <
      cancelBody.indexOf('cancelJobAndReleaseAllocationsByJobId'),
    'Expected selected job validation before canonical cancel side effects.'
  );
  assert.match(cancelBody, /cancelJobAndReleaseAllocationsByJobId\(client, orgId, target\.jobId, jobNumber, actor, payload\.reason\)/);
  assert.match(cancelBody, /saveJobRecordById\(client, orgId, existingJob\)/);
  assert.match(cancelBody, /return ok\(target\.usedJobId \? \{ jobId: target\.jobId, jobNumber \} : \{ jobNumber \}, warnings\);/);
  assert.match(helperBody, /listAllocationsByJobId\(client, orgId, jobId\)/);
  assert.match(helperBody, /listFilmOrdersByJobId\(client, orgId, jobId\)/);
  assert.doesNotMatch(helperBody, /cancel_active_caulk|caulk_job_allocations/);
});

test('Edge cancel validates canonical identity before SQL RPC and preserves org-wide planner ownership', async () => {
  const edgeHandlers = await readFile(edgeHandlersPath, 'utf8');
  const cancelBody = extractBetween(edgeHandlers, '"/film-orders/cancel": async', '"/film-orders/delete": async');
  const sqlPlannerRoutes = extractBetween(
    edgeHandlers,
    'const SQL_PLANNER_HANDLED_ROUTES = new Set([',
    ']);\n\nconst ORG_WIDE_MUTATION_ROUTES'
  );
  const orgWideRoutes = extractBetween(
    edgeHandlers,
    'const ORG_WIDE_MUTATION_ROUTES = new Set([',
    ']);\n\nconst JOB_DETAIL_RELOAD_ROUTES'
  );

  assert.match(cancelBody, /const suppliedJobId = deps\.asTrimmedString\(payloadWithoutRequestOrg\.jobId\);/);
  assert.match(cancelBody, /JOB_ID_PATTERN\.test\(suppliedJobId\)/);
  assert.match(cancelBody, /deps\.requireString\(payloadWithoutRequestOrg\.jobNumber, "JobNumber"\);/);
  assert.match(cancelBody, /resolveEdgeJobMutationTargetById\(client, orgId, payloadWithoutRequestOrg,/);
  assert.match(cancelBody, /rpcPayload = \{ \.\.\.payloadWithoutRequestOrg, jobId: target\.jobId, jobNumber: target\.jobNumber \};/);
  assert.match(cancelBody, /callMutationRpc\(client, "api_acl_film_orders_cancel", orgId, actor, rpcPayload\)/);
  assert.match(cancelBody, /\.\.\.\(jobId \? \{ jobId \} : \{\}\), jobNumber:/);
  assert.match(orgWideRoutes, /"\/film-orders\/cancel"/);
  assert.doesNotMatch(sqlPlannerRoutes, /"\/film-orders\/cancel"/);
});
