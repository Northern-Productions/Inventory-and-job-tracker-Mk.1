import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0127_caulk_add_jobid_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260513200000_caulk_add_jobid_scope.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const baseSchemaMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0001_supabase_inventory_schema.sql');
const duplicateGuardMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0117_duplicate_job_creation_guard.sql');
const localCaulkRuntimePath = path.join(repoRoot, 'backend', 'src', 'app', 'services', 'caulkAllocations.mjs');
const localPlannerPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeAutoAllocationPlanner.mjs'
);
const edgeMutationHandlersPath = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'routes',
  'mutationHandlers.ts'
);
const frontendCaulkDomainPath = path.join(repoRoot, 'frontend', 'src', 'domain', 'inventory', 'caulk.ts');
const frontendCaulkWorkflowPath = path.join(
  repoRoot,
  'frontend',
  'src',
  'features',
  'inventory',
  'pages',
  'allocation-job',
  'useCaulkWorkflow.ts'
);
const frontendMutationPath = path.join(
  repoRoot,
  'frontend',
  'src',
  'features',
  'inventory',
  'hooks',
  'mutations',
  'allocationMutations.ts'
);

function extractBody(sql, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sql.match(
    new RegExp(`create or replace function ${escapedName}[\\s\\S]*?as \\$\\$\\r?\\n(?<body>[\\s\\S]*?)\\r?\\n\\$\\$;`)
  );
  assert.ok(match?.groups?.body, `Expected ${functionName} body.`);
  return match.groups.body;
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected marker ${startMarker}.`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Expected marker ${endMarker}.`);
  return source.slice(start, end);
}

test('caulk add jobId scope migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('caulk add SQL validates canonical jobId before mutation and preserves legacy add', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_acl_allocations_caulk_add');

  assert.match(body, /v_job_id_text text := app_api\.trim_text\(p_payload->>'jobId'\)/);
  assert.match(body, /v_has_job_id boolean := v_job_id_text <> ''/);
  assert.match(body, /v_job_id := v_job_id_text::uuid/);
  assert.match(body, /jobId must be a valid UUID\./);
  assert.match(body, /from app\.jobs j\s+where j\.org_id = p_org_id\s+and j\.id = v_job_id\s+for update;/s);
  assert.match(body, /Job was not found\./);
  assert.match(body, /Job identity mismatch: selected job does not match jobNumber\./);
  assert.match(body, /normalize_job_lifecycle_status\(v_job\.lifecycle_status::text\) <> 'ACTIVE'::app\.job_lifecycle_status/);
  assert.match(body, /Job %s is closed and cannot receive caulk allocations\./);
  assert.match(body, /else\s+v_job := app_api\.require_active_job_for_caulk\(p_org_id, v_job_number\);/s);
  assert.match(body, /and r\.job_id = v_job\.id/);
  assert.match(body, /RequirementId was not found for this job\./);
  assert.match(body, /v_job\.id/);
  assert.match(body, /v_job\.job_number/);
  assert.doesNotMatch(body, /get_or_resolve_job_id/);
});

test('caulk add SQL preserves stock, transfer, warning, response, and planner behavior', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_acl_allocations_caulk_add');

  assert.match(body, /productId is required\./);
  assert.match(body, /allocatedTubes must be greater than zero\./);
  assert.match(body, /Product was not found\./);
  assert.match(body, /app_api\.caulk_reserve_local_tubes\(/);
  assert.match(body, /insert into app\.caulk_job_allocations/);
  assert.match(body, /app_api\.caulk_start_pending_transfer\(/);
  assert.match(body, /v_warnings := coalesce\(v_transfer_result->'warnings'/);
  assert.match(body, /app_api\.reconcile_auto_planned_allocations\(/);
  assert.match(body, /'jobIds', jsonb_build_array\(v_job\.id\)/);
  assert.match(body, /'jobNumbers', jsonb_build_array\(v_job\.job_number\)/);
  assert.match(body, /'caulkProductWarehousePairs'/);
  assert.match(body, /'productId', v_product\.id/);
  assert.match(body, /'warehouse', v_warehouse/);
  assert.match(body, /v_warnings := v_warnings \|\| coalesce\(v_planner_result->'warnings'/);
  assert.match(body, /'jobId', v_job\.id::text/);
  assert.match(body, /'jobNumber', v_job\.job_number/);
  assert.match(body, /'caulkAllocationId', v_allocation_id/);
  assert.match(body, /'warnings', v_warnings/);
});

test('caulk add jobId scope migration keeps non-scope workflows and duplicate guards unchanged', async () => {
  const [migration, baseSchemaMigration, duplicateGuardMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(baseSchemaMigrationPath, 'utf8'),
    readFile(duplicateGuardMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.doesNotMatch(migration, /api_acl_allocations_caulk_remove/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_update/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_checkout/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_checkin/);
  assert.doesNotMatch(migration, /api_acl_caulk_transfer_receive/);
  assert.doesNotMatch(migration, /api_acl_caulk_transfer_cancel/);
  assert.doesNotMatch(migration, /api_jobs_set_staged_pickup/);
  assert.doesNotMatch(migration, /api_jobs_checkout_all/);
  assert.doesNotMatch(migration, /api_jobs_complete/);
  assert.doesNotMatch(migration, /api_film_orders_/);
  assert.doesNotMatch(migration, /api_allocations_apply/);
  assert.doesNotMatch(migration, /api_jobs_create/);
  assert.doesNotMatch(migration, /api_jobs_check_duplicate/);
  assert.doesNotMatch(migration, /alter table app\.jobs/i);
  assert.doesNotMatch(migration, /drop constraint/i);
  assert.match(baseSchemaMigration, /unique\s*\(\s*org_id\s*,\s*job_number\s*\)/i);
  assert.match(duplicateGuardMigration, /Job %s already exists/);

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0192_atomic_cross_warehouse_affected_box_scan\.sql';/);

  assert.match(schemaCheck, /public\.api_acl_allocations_caulk_add\(uuid, text, jsonb\)/);
});

test('local caulk add validates canonical jobId without hidden planner allocation', async () => {
  const [runtime, planner] = await Promise.all([
    readFile(localCaulkRuntimePath, 'utf8'),
    readFile(localPlannerPath, 'utf8'),
  ]);
  const addBody = extractBetween(runtime, 'export async function addCaulkAllocation', 'export async function updateCaulkAllocation');

  assert.match(addBody, /const jobIdRaw = asTrimmedString\(payload\?\.jobId\)/);
  assert.match(addBody, /requireCaulkAllocationJobById\(client, orgId, requireUuid\(jobIdRaw, 'jobId'\), 'Job was not found\.'\)/);
  assert.match(addBody, /Job identity mismatch: selected job does not match jobNumber\./);
  assert.match(addBody, /assertActiveCaulkJob\(job\)/);
  assert.match(addBody, /requireActiveJobForCaulk\(client, orgId, payloadJobNumber\)/);
  assert.match(addBody, /requireCaulkRequirementForJob\(client, orgId, requireUuid\(requirementIdRaw, 'requirementId'\), job\.id\)/);
  assert.match(addBody, /jobId: job\.id/);
  assert.match(addBody, /jobNumber: asTrimmedString\(job\.job_number\)/);
  assert.doesNotMatch(addBody, /reconcileAutoPlannedAllocations/);
  assert.doesNotMatch(addBody, /normalizePlannerWarnings/);
  assert.match(addBody, /jobId: asTrimmedString\(job\.id\)/);
  assert.match(planner, /'\/allocations\/caulk\/add'/);
});

test('Edge caulk add strips request orgId, validates canonical jobId, and skips redundant planner', async () => {
  const edgeHandlers = await readFile(edgeMutationHandlersPath, 'utf8');
  const addBody = extractBetween(edgeHandlers, '"/allocations/caulk/add": async', '"/allocations/caulk/update": async');

  assert.match(edgeHandlers, /"\/allocations\/caulk\/add"/);
  assert.match(addBody, /const \{ orgId: _requestOrgId, \.\.\.payloadWithoutRequestOrg \} = normalizedPayload;/);
  assert.match(addBody, /JOB_ID_PATTERN\.test\(jobId\)/);
  assert.match(addBody, /resolveEdgeJobMutationTargetById\(/);
  assert.match(addBody, /jobId: target\.jobId/);
  assert.match(addBody, /jobNumber: target\.jobNumber/);
  assert.match(addBody, /api_acl_allocations_caulk_add/);
  assert.match(addBody, /rpcPayload/);
});

test('frontend caulk add sends canonical jobId and avoids unsafe legacy optimistic patching', async () => {
  const [domainSource, workflowSource, mutationSource] = await Promise.all([
    readFile(frontendCaulkDomainPath, 'utf8'),
    readFile(frontendCaulkWorkflowPath, 'utf8'),
    readFile(frontendMutationPath, 'utf8'),
  ]);
  const addMutationBody = extractBetween(
    mutationSource,
    'export function useAddCaulkJobAllocation',
    'export function useUpdateCaulkJobAllocation'
  );

  assert.match(domainSource, /export interface AddCaulkJobAllocationPayload \{\s+jobId\?: string;/);
  assert.match(workflowSource, /canonicalJobId\?: string;/);
  assert.match(workflowSource, /jobId: canonicalJobId \|\| undefined/);
  assert.match(addMutationBody, /const canonicalJobId = String\(payload\.jobId \|\| ''\)\.trim\(\)/);
  assert.match(addMutationBody, /inventoryKeys\.jobById\(canonicalJobId\)/);
  assert.match(addMutationBody, /if \(canonicalJobId\)/);
  assert.match(addMutationBody, /applyOptimisticAddCaulkAllocationToCaches/);
  assert.match(addMutationBody, /result\.jobId \|\| variables\.jobId/);
  assert.match(addMutationBody, /jobId: resultJobId/);
  assert.match(addMutationBody, /jobNumber: result\.jobNumber/);
});
