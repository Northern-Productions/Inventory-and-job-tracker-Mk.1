import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0131_checkout_all_jobid_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260514000000_checkout_all_jobid_scope.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const baseSchemaMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0001_supabase_inventory_schema.sql');
const duplicateGuardMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0117_duplicate_job_creation_guard.sql');
const checkoutFlowPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'checkout',
  'checkoutFlow.mjs'
);
const runtimePlannerPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeAutoAllocationPlanner.mjs'
);
const edgeApiHandlerPath = path.join(repoRoot, 'supabase', 'functions', '_shared', 'api-handler.ts');
const edgeMutationHandlersPath = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'routes',
  'mutationHandlers.ts'
);
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
const frontendCheckoutMutationPath = path.join(
  repoRoot,
  'frontend',
  'src',
  'features',
  'inventory',
  'hooks',
  'mutations',
  'planning',
  'jobMaterialWorkflowMutations.ts'
);
const stagedPickupFlowPath = path.join(repoRoot, 'backend', 'scripts', 'lib', 'staged-pickup-flow.test.mjs');

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

test('checkout-all jobId scope migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('checkout-all jobId scope migration updates schema latest without changing duplicate constraints', async () => {
  const [migration, schemaCheck, baseSchemaMigration, duplicateGuardMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
    readFile(baseSchemaMigrationPath, 'utf8'),
    readFile(duplicateGuardMigrationPath, 'utf8'),
  ]);

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0131_checkout_all_jobid_scope\.sql';/);
  assert.match(schemaCheck, /public\.api_acl_boxes_resolve_checkout_allocations\(uuid, text, jsonb\)/);
  assert.match(schemaCheck, /app_api\.resolve_allocations_for_checkout\(uuid, text, text, text, uuid\)/);
  assert.match(migration, /create or replace function app_api\.resolve_allocations_for_checkout\(\s+p_org_id uuid,\s+p_box_id text,\s+p_job_number text,\s+p_actor text,\s+p_job_id uuid\s+\)/);
  assert.match(migration, /create or replace function public\.api_acl_boxes_resolve_checkout_allocations\(\s+p_org_id uuid,\s+p_actor text,\s+p_payload jsonb\s+\)/);
  assert.doesNotMatch(migration, /alter table app\.jobs/i);
  assert.doesNotMatch(migration, /drop constraint/i);
  assert.doesNotMatch(migration, /update app\./i);
  assert.match(baseSchemaMigration, /unique\s*\(\s*org_id\s*,\s*job_number\s*\)/i);
  assert.match(duplicateGuardMigration, /Job %s already exists/);
});

test('checkout allocation resolver is jobId-preferred and keeps legacy jobNumber fallback', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'app_api.resolve_allocations_for_checkout');

  assert.match(body, /when p_job_id is not null then v_entry\.job_id = p_job_id/);
  assert.match(body, /else upper\(v_entry\.job_number\) = upper\(app_api\.trim_text\(p_job_number\)\)/);
  assert.match(body, /perform app_api\.save_allocation\(v_entry\);/);
  assert.match(body, /v_other_jobs := array_append\(v_other_jobs, v_entry\.job_number\);/);
});

test('box status canonical checkout passes jobId into SQL allocation resolution', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(
    migration,
    /v_resolution := app_api\.resolve_allocations_for_checkout\(p_org_id, v_box\.box_id, v_checkout_job, p_actor, v_checkout_job_id\);/
  );
  assert.match(
    migration,
    /public\.api_boxes_set_status checkout jobId resolver patch did not match expected snippet/
  );
});

test('no-audit checkout-all resolve helper validates canonical identity and owns narrow planner scope', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_acl_boxes_resolve_checkout_allocations');

  assert.match(body, /perform app_api\.require_effective_feature_access\(p_org_id, 'inventory', 'write'\);/);
  assert.match(body, /v_payload_job_id_text !~\* '\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$'/);
  assert.match(body, /from app\.jobs j\s+where j\.org_id = p_org_id\s+and j\.id = v_job_id;/s);
  assert.match(body, /perform app_api\.raise_http\(400, 'jobId does not match jobNumber\.'\);/);
  assert.match(body, /v_existing\.last_checkout_job_id is not null and v_existing\.last_checkout_job_id <> v_job_id/);
  assert.match(body, /upper\(coalesce\(v_existing\.last_checkout_job, ''\)\) <> upper\(trim\(v_job_number\)\)/);
  assert.match(body, /app_api\.resolve_allocations_for_checkout\(\s+p_org_id,\s+v_lookup_box_id,\s+v_job_number,\s+p_actor,\s+v_job_id\s+\)/);
  assert.match(body, /'boxIds', jsonb_build_array\(v_lookup_box_id\)/);
  assert.match(body, /'jobNumbers', jsonb_build_array\(v_job_number\)/);
  assert.match(body, /'jobIds', jsonb_build_array\(v_job_id::text\)/);
  assert.match(body, /perform app_api\.reconcile_auto_planned_allocations\(/);
  assert.match(body, /v_result := v_result \|\| jsonb_build_object\(\s+'jobId', v_job_id::text,\s+'jobNumber', v_job_number\s+\);/);
});

test('backend checkout-all validates selected job before side effects and loads canonical data by jobId', async () => {
  const [checkoutFlow, plannerSource] = await Promise.all([
    readFile(checkoutFlowPath, 'utf8'),
    readFile(runtimePlannerPath, 'utf8'),
  ]);

  assert.match(checkoutFlow, /async function resolveCheckoutAllTarget\(client, orgId, payloadOrJobNumber, user\)/);
  assert.match(checkoutFlow, /const jobId = requireUuid\(suppliedJobId, 'jobId'\);/);
  assert.match(checkoutFlow, /const selectedJob = await findJobById\(client, orgId, jobId\);/);
  assert.match(checkoutFlow, /Job identity mismatch: jobId/);
  assert.match(checkoutFlow, /listAllocationsByJobId\(client, orgId, target\.jobId\)/);
  assert.match(checkoutFlow, /listFilmOrdersByJobId\(client, orgId, target\.jobId\)/);
  assert.match(checkoutFlow, /listJobRequirementsByJobId\(client, orgId, target\.jobId\)/);
  assert.match(checkoutFlow, /listJobCaulkRequirementsByJobId\(client, orgId, target\.jobId\)/);
  assert.match(checkoutFlow, /listCaulkJobAllocationsByJobId\(client, orgId, target\.jobId\)/);
  assert.match(checkoutFlow, /checkoutBoxForJob\([\s\S]*jobId: target\.jobId,[\s\S]*selectedJob: target\.existingJob/);
  assert.match(checkoutFlow, /resolveAllocationsForCheckout\([\s\S]*selectedJobId[\s\S]*\)/);
  assert.match(checkoutFlow, /return \{\s+\.\.\.\(target\.jobId \? \{ jobId: target\.jobId \} : \{\}\),\s+jobNumber: normalizedJobNumber,/);
  assert.match(plannerSource, /const JOB_ID_SHADOW_SCOPE_ROUTES = new Set\(\[[\s\S]*'\/jobs\/checkout-all'/);
  assert.match(plannerSource, /Array\.isArray\(responseData\?\.caulkAllocations\)/);
  assert.match(plannerSource, /addCaulkProductWarehousePair\(caulkProductWarehousePairs, allocation\?\.productId, allocation\?\.warehouse\)/);
});

test('Edge checkout-all validates jobId, uses jobId-aware film and caulk subflows, and keeps SQL planner ownership', async () => {
  const [edgeSource, routeSource] = await Promise.all([
    readFile(edgeApiHandlerPath, 'utf8'),
    readFile(edgeMutationHandlersPath, 'utf8'),
  ]);
  const routeBody = extractBetween(routeSource, '"/jobs/checkout-all": async', '"/jobs/complete": async');

  assert.match(edgeSource, /const target = await resolveEdgeJobMutationTargetById\(client, orgId, payload,/);
  assert.match(edgeSource, /const targetJobId = target\.usedJobId \? requireString\(target\.jobId, "jobId"\) : "";/);
  assert.match(edgeSource, /listAllocationsByJobIdDirect\(orgId, targetJobId\)/);
  assert.match(edgeSource, /listFilmOrdersByJobIdDirect\(orgId, targetJobId\)/);
  assert.match(edgeSource, /listJobRequirementsByJobIdDirect\(orgId, canonicalHeader\)/);
  assert.match(edgeSource, /listJobCaulkRequirementsByJobIdDirect\(orgId, canonicalHeader\)/);
  assert.match(edgeSource, /listCaulkJobAllocationsByJobIdDirect\(orgId, targetJobId\)/);
  assert.match(edgeSource, /const boxLastCheckoutJobId = asTrimmedString\(box\.lastCheckoutJobId\)\.toLowerCase\(\);/);
  assert.match(edgeSource, /boxLastCheckoutJobId === targetJobId\.toLowerCase\(\)/);
  assert.match(edgeSource, /api_acl_boxes_resolve_checkout_allocations/);
  assert.match(edgeSource, /api_acl_boxes_set_status[\s\S]*\.\.\.\(target\.usedJobId \? \{ jobId: targetJobId, jobNumber \} : \{\}\)/);
  assert.match(edgeSource, /api_acl_allocations_caulk_checkout/);
  assert.match(routeSource, /const SQL_PLANNER_HANDLED_ROUTES = new Set\(\[[\s\S]*"\/jobs\/checkout-all"/);
  assert.match(routeBody, /const jobId = deps\.asTrimmedString\(result\.jobId\);/);
  assert.match(routeBody, /jobId\s+\? await deps\.buildJobDetailById\(client, identity\.orgId, jobId\)\s+: await deps\.buildJobDetail\(client, identity\.orgId, jobNumber\)/);
});

test('frontend checkout-all sends canonical jobId and avoids unsafe legacy detail patching', async () => {
  const [clientSource, workflowSource, mutationSource] = await Promise.all([
    readFile(frontendJobsClientPath, 'utf8'),
    readFile(frontendLifecycleWorkflowPath, 'utf8'),
    readFile(frontendCheckoutMutationPath, 'utf8'),
  ]);

  assert.match(clientSource, /export interface CheckoutAllJobMaterialsPayload \{\s+jobId\?: string;\s+jobNumber: string;\s+\}/);
  assert.match(workflowSource, /checkoutAllJobMaterials\(\{\s+\.\.\.\(canonicalJobId \? \{ jobId: canonicalJobId \} : \{\}\),\s+jobNumber: summary\.jobNumber\s+\}\)/);
  assert.match(mutationSource, /const jobId = String\(payload\.jobId \|\| ''\)\.trim\(\);/);
  assert.match(mutationSource, /inventoryKeys\.jobById\(jobId\)/);
  assert.match(mutationSource, /if \(!jobId\) \{\s+applyCheckoutAllToCaches\(queryClient, payload\.jobNumber\);\s+\}/);
  assert.match(mutationSource, /syncAllocationJobDetail: !jobId,\s+syncLegacyJobDetail: !jobId/);
  assert.match(mutationSource, /invalidateCaulkJobQueries\(/);
});

test('checkout-all jobId scope keeps staged pickup and unrelated mutation families out of scope', async () => {
  const [migration, stagedPickupSource, checkoutFlow, edgeRouteSource] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(stagedPickupFlowPath, 'utf8'),
    readFile(checkoutFlowPath, 'utf8'),
    readFile(edgeMutationHandlersPath, 'utf8'),
  ]);
  const stagedPickupRouteBody = extractBetween(
    edgeRouteSource,
    '"/jobs/set-staged-pickup": async',
    '"/jobs/checkout-all": async'
  );

  assert.doesNotMatch(migration, /api_jobs_set_staged_pickup/);
  assert.doesNotMatch(migration, /api_jobs_complete/);
  assert.doesNotMatch(migration, /api_film_orders_(cancel|delete|create)/);
  assert.doesNotMatch(migration, /api_allocations_(apply|preview)/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_(add|update|remove|checkin|checkout)/);
  assert.doesNotMatch(migration, /api_jobs_create/);
  assert.doesNotMatch(migration, /api_jobs_check_duplicate/);
  assert.doesNotMatch(checkoutFlow, /setJobStagedPickup/);
  assert.doesNotMatch(stagedPickupRouteBody, /buildJobDetailById/);
  assert.match(stagedPickupSource, /checkoutAllJobMaterials: async \(\) =>/);
});
