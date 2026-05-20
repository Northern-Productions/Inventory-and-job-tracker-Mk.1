import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0128_caulk_remove_jobid_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260513210000_caulk_remove_jobid_scope.sql'
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

test('caulk remove jobId scope migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('caulk remove SQL derives exact job_id from allocation row and scopes planner by jobId', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_acl_allocations_caulk_remove');

  assert.match(body, /from app\.caulk_job_allocations a\s+where a\.org_id = p_org_id\s+and a\.caulk_allocation_id = v_caulk_allocation_id\s+for update;/s);
  assert.match(body, /from app\.jobs j\s+where j\.org_id = p_org_id\s+and j\.id = v_allocation\.job_id\s+for update;/s);
  assert.match(body, /Job for caulk allocation %s was not found\./);
  assert.doesNotMatch(body, /require_active_job_for_caulk\(p_org_id, v_allocation\.job_number\)/);
  assert.doesNotMatch(body, /Job %s is closed and cannot receive caulk allocations\./);
  assert.match(body, /app_api\.reconcile_auto_planned_allocations\(/);
  assert.match(body, /'jobIds', jsonb_build_array\(v_job\.id\)/);
  assert.match(body, /'jobNumbers', jsonb_build_array\(v_job\.job_number\)/);
  assert.match(body, /'caulkProductWarehousePairs'/);
  assert.match(body, /'productId', v_allocation\.product_id/);
  assert.match(body, /'warehouse', v_allocation\.warehouse/);
  assert.match(body, /'jobId', v_job\.id::text/);
  assert.match(body, /'jobNumber', v_job\.job_number/);
});

test('caulk remove SQL preserves remove side effects, warnings, and response compatibility', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_acl_allocations_caulk_remove');

  assert.match(body, /Caulk allocation %s was not found\./);
  assert.match(body, /Caulk allocation %s is not active\./);
  assert.match(body, /Caulk allocation %s has %s open checkout%s\. Check in first\./);
  assert.match(body, /app_api\.record_auto_planned_caulk_allocation_suppression\(/);
  assert.match(body, /app_api\.caulk_cancel_pending_transfer_internal\(/);
  assert.match(body, /JOB_ALLOCATION_CANCEL_RETURN/);
  assert.match(body, /status = 'CANCELLED'/);
  assert.match(body, /reserved_tubes_remaining = 0/);
  assert.match(body, /v_warnings := v_warnings \|\| coalesce\(v_cancel_result->'warnings'/);
  assert.match(body, /v_warnings := v_warnings \|\| coalesce\(v_planner_result->'warnings'/);
  assert.match(body, /'caulkAllocationId', v_allocation\.caulk_allocation_id/);
  assert.match(body, /'releasedReservedTubes', v_released_reserved_tubes/);
  assert.match(body, /'autoPlanningSuppressed', v_auto_planning_suppressed/);
  assert.match(body, /'warnings', v_warnings/);
});

test('caulk remove jobId scope migration keeps non-scope workflows and duplicate guards unchanged', async () => {
  const [migration, baseSchemaMigration, duplicateGuardMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(baseSchemaMigrationPath, 'utf8'),
    readFile(duplicateGuardMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.doesNotMatch(migration, /api_acl_allocations_caulk_add/);
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
  assert.match(schemaCheck, /const LATEST_MIGRATION = '0141_box_checkin_reconcile_same_job_allocations\.sql';/);
  assert.match(schemaCheck, /public\.api_acl_allocations_caulk_remove\(uuid, text, jsonb\)/);
  assert.match(schemaCheck, /'jobIds', jsonb_build_array\(v_job\.id\)/);
  assert.match(schemaCheck, /'caulkProductWarehousePairs'/);
});

test('local caulk remove still delegates to SQL RPC planner ownership', async () => {
  const [runtime, planner] = await Promise.all([
    readFile(localCaulkRuntimePath, 'utf8'),
    readFile(localPlannerPath, 'utf8'),
  ]);
  const removeBody = extractBetween(runtime, 'export function removeCaulkAllocation', 'export async function receiveCaulkTransfer');

  assert.match(removeBody, /callCaulkAllocationMutation\(client, 'public\.api_acl_allocations_caulk_remove', orgId, actor, payload\)/);
  assert.doesNotMatch(removeBody, /requireActiveJobForCaulk/);
  assert.doesNotMatch(removeBody, /reconcileAutoPlannedAllocations/);
  assert.match(planner, /'\/allocations\/caulk\/remove'/);
});

test('Edge caulk remove strips request orgId and delegates planner ownership to SQL RPC', async () => {
  const edgeHandlers = await readFile(edgeMutationHandlersPath, 'utf8');
  const removeBody = extractBetween(edgeHandlers, '"/allocations/caulk/remove": async', '"/caulk/transfers/receive": async');

  assert.match(edgeHandlers, /"\/allocations\/caulk\/remove"/);
  assert.match(removeBody, /const \{ orgId: _requestOrgId, \.\.\.payloadWithoutRequestOrg \} = normalizedPayload;/);
  assert.match(removeBody, /api_acl_allocations_caulk_remove/);
  assert.match(removeBody, /payloadWithoutRequestOrg/);
});

test('frontend caulk remove accepts optional jobId without unsafe same-number legacy detail patching', async () => {
  const [domainSource, mutationSource, cacheSource] = await Promise.all([
    readFile(frontendCaulkDomainPath, 'utf8'),
    readFile(frontendMutationPath, 'utf8'),
    readFile(frontendCachePath, 'utf8'),
  ]);
  const removeMutationBody = extractBetween(
    mutationSource,
    'export function useRemoveCaulkJobAllocation',
    'export function useReceiveCaulkTransfer'
  );
  const optimisticRemoveBody = extractBetween(
    cacheSource,
    'export function applyOptimisticRemoveCaulkAllocationToCaches',
    'export function replacePendingCaulkAllocationIdInCaches'
  );

  assert.match(domainSource, /export interface RemoveCaulkJobAllocationPayload \{\s+caulkAllocationId: string;\s+reason\?: string;/s);
  assert.match(domainSource, /export interface CaulkJobAllocationMutationResult \{\s+jobId\?: string;/s);
  assert.match(removeMutationBody, /mutationFn: \(payload: RemoveCaulkJobAllocationPayload\) => removeCaulkJobAllocation\(payload\)/);
  assert.match(removeMutationBody, /inventoryKeys\.jobByIdRoot/);
  assert.match(removeMutationBody, /jobId: result\.jobId/);
  assert.match(removeMutationBody, /jobNumber: result\.jobNumber/);
  assert.match(optimisticRemoveBody, /findJobDetailByCaulkAllocationIdForUpdate/);
  assert.match(optimisticRemoveBody, /currentMatch\.exactJobId/);
  assert.match(optimisticRemoveBody, /syncLegacyJobDetail: false/);
  assert.match(optimisticRemoveBody, /syncAllocationJobDetail: true/);
});
