import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0126_caulk_update_jobid_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260513190000_caulk_update_jobid_scope.sql'
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
const frontendCachePath = path.join(
  repoRoot,
  'frontend',
  'src',
  'features',
  'inventory',
  'cache',
  'caulkAllocations.ts'
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

test('caulk update jobId scope migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('caulk update SQL derives exact job_id from allocation row and scopes planner by jobId', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_acl_allocations_caulk_update');

  assert.match(body, /from app\.caulk_job_allocations a\s+where a\.org_id = p_org_id\s+and a\.caulk_allocation_id = v_caulk_allocation_id\s+for update;/s);
  assert.match(body, /from app\.jobs j\s+where j\.org_id = p_org_id\s+and j\.id = v_allocation\.job_id\s+for update;/s);
  assert.match(body, /Job for caulk allocation %s was not found\./);
  assert.match(body, /Job %s is closed and cannot receive caulk allocations\./);
  assert.doesNotMatch(body, /require_active_job_for_caulk\(p_org_id, v_allocation\.job_number\)/);
  assert.match(body, /v_job\.id/);
  assert.match(body, /v_job\.job_number/);
  assert.match(body, /app_api\.reconcile_auto_planned_allocations\(/);
  assert.match(body, /'jobIds', jsonb_build_array\(v_job\.id\)/);
  assert.match(body, /'jobNumbers', jsonb_build_array\(v_job\.job_number\)/);
  assert.match(body, /'caulkProductWarehousePairs'/);
  assert.match(body, /'productId', v_allocation\.product_id/);
  assert.match(body, /'warehouse', v_allocation\.warehouse/);
  assert.match(body, /'productId', v_next_product_id/);
  assert.match(body, /'warehouse', v_next_warehouse/);
  assert.match(body, /'jobId', v_job\.id::text/);
});

test('caulk update SQL preserves existing validation, stock, transfer, warning, and response behavior', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_acl_allocations_caulk_update');

  assert.match(body, /Caulk allocation %s was not found\./);
  assert.match(body, /Caulk allocation %s is not active\./);
  assert.match(body, /Receive or cancel transfer %s before editing this allocation\./);
  assert.match(body, /allocatedTubes must be greater than zero\./);
  assert.match(body, /Product was not found\./);
  assert.match(body, /Product and warehouse cannot be changed after checkout starts\./);
  assert.match(body, /allocatedTubes can only increase after checkout starts\./);
  assert.match(body, /allocatedTubes cannot drop below already checked-out amount\./);
  assert.match(body, /app_api\.caulk_apply_stock_delta\(/);
  assert.match(body, /app_api\.caulk_reserve_local_tubes\(/);
  assert.match(body, /app_api\.caulk_start_pending_transfer\(/);
  assert.match(body, /v_warnings := coalesce\(v_transfer_result->'warnings'/);
  assert.match(body, /v_warnings := v_warnings \|\| coalesce\(v_planner_result->'warnings'/);
  assert.match(body, /'jobNumber', v_job\.job_number/);
  assert.match(body, /'caulkAllocationId', v_allocation\.caulk_allocation_id/);
  assert.match(body, /'warnings', v_warnings/);
});

test('caulk update jobId scope migration keeps non-scope workflows and duplicate guards unchanged', async () => {
  const [migration, baseSchemaMigration, duplicateGuardMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(baseSchemaMigrationPath, 'utf8'),
    readFile(duplicateGuardMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.doesNotMatch(migration, /api_acl_allocations_caulk_add/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_remove/);
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

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0167_manual_film_order_fulfill_public_permission_fix\.sql';/);

  assert.match(schemaCheck, /public\.api_acl_allocations_caulk_update\(uuid, text, jsonb\)/);
  assert.match(schemaCheck, /'jobIds', jsonb_build_array\(v_job\.id\)/);
  assert.match(schemaCheck, /'caulkProductWarehousePairs'/);
});

test('local caulk update derives jobId from allocation row without hidden planner allocation', async () => {
  const [runtime, planner] = await Promise.all([
    readFile(localCaulkRuntimePath, 'utf8'),
    readFile(localPlannerPath, 'utf8'),
  ]);
  const updateBody = extractBetween(runtime, 'export async function updateCaulkAllocation', 'export async function checkoutCaulkAllocation');

  assert.match(updateBody, /requireLockedAllocation\(client, orgId, caulkAllocationId\)/);
  assert.match(updateBody, /requireCaulkAllocationJobById\(\s*client,\s*orgId,\s*allocation\.job_id,/s);
  assert.match(updateBody, /assertActiveCaulkJob\(selectedJob\)/);
  assert.doesNotMatch(updateBody, /requireActiveJobForCaulk\(client, orgId, allocation\.job_number\)/);
  assert.match(updateBody, /jobId: selectedJob\.id/);
  assert.match(updateBody, /jobNumber: asTrimmedString\(selectedJob\.job_number\)/);
  assert.doesNotMatch(updateBody, /reconcileAutoPlannedAllocations/);
  assert.doesNotMatch(updateBody, /normalizePlannerWarnings/);
  assert.match(updateBody, /jobId: asTrimmedString\(selectedJob\.id\)/);
  assert.match(planner, /'\/allocations\/caulk\/update'/);
});

test('Edge caulk update strips request orgId and delegates planner ownership to SQL RPC', async () => {
  const edgeHandlers = await readFile(edgeMutationHandlersPath, 'utf8');
  const updateBody = extractBetween(edgeHandlers, '"/allocations/caulk/update": async', '"/allocations/caulk/checkout": async');

  assert.match(edgeHandlers, /"\/allocations\/caulk\/update"/);
  assert.match(updateBody, /const \{ orgId: _requestOrgId, \.\.\.payloadWithoutRequestOrg \} = normalizedPayload;/);
  assert.match(updateBody, /api_acl_allocations_caulk_update/);
  assert.match(updateBody, /payloadWithoutRequestOrg/);
});

test('frontend caulk update accepts optional jobId without unsafe same-number legacy detail patching', async () => {
  const [mutationSource, cacheSource] = await Promise.all([
    readFile(frontendMutationPath, 'utf8'),
    readFile(frontendCachePath, 'utf8'),
  ]);
  const updateMutationBody = extractBetween(
    mutationSource,
    'export function useUpdateCaulkJobAllocation',
    'export function useCheckoutCaulkJobAllocation'
  );
  const optimisticUpdateBody = extractBetween(
    cacheSource,
    'export function applyOptimisticUpdateCaulkAllocationToCaches',
    'export function applyOptimisticRemoveCaulkAllocationToCaches'
  );

  assert.match(updateMutationBody, /mutationFn: \(payload: UpdateCaulkJobAllocationPayload\) => updateCaulkJobAllocation\(payload\)/);
  assert.match(updateMutationBody, /applyOptimisticUpdateCaulkAllocationToCaches\(queryClient, payload\)/);
  assert.match(updateMutationBody, /inventoryKeys\.jobByIdRoot/);
  assert.match(updateMutationBody, /jobId: result\.jobId/);
  assert.match(updateMutationBody, /jobNumber: result\.jobNumber/);
  assert.match(cacheSource, /queryKey: inventoryKeys\.jobByIdRoot/);
  assert.match(optimisticUpdateBody, /currentMatch\.exactJobId/);
  assert.match(optimisticUpdateBody, /syncLegacyJobDetail: false/);
  assert.match(optimisticUpdateBody, /syncAllocationJobDetail: true/);
});
