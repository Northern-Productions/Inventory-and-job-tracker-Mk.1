import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0129_caulk_transfer_jobid_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260513220000_caulk_transfer_jobid_scope.sql'
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

function extractBody(sql, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sql.match(
    new RegExp(`create or replace function ${escapedName}[\\s\\S]*?as \\$\\$\\r?\\n(?<body>[\\s\\S]*?)\\r?\\n\\$\\$;`)
  );
  assert.ok(match?.groups?.body, `Expected ${functionName} body.`);
  return match.groups.body;
}

function extractBetween(source, startMarker, endMarker) {
  const normalizedSource = source.replace(/\r\n/g, '\n');
  const start = normalizedSource.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected marker ${startMarker}.`);
  const end = normalizedSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Expected marker ${endMarker}.`);
  return normalizedSource.slice(start, end);
}

function extractFrom(source, startMarker) {
  const normalizedSource = source.replace(/\r\n/g, '\n');
  const start = normalizedSource.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected marker ${startMarker}.`);
  return normalizedSource.slice(start);
}

test('caulk transfer jobId scope migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('caulk transfer receive SQL derives selected job and preserves receive side effects', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'app_api.caulk_receive_pending_transfer_internal');

  assert.match(body, /from app\.caulk_transfers t\s+where t\.org_id = p_org_id\s+and t\.transfer_id = app_api\.require_text\(p_transfer_id, 'TransferId'\)\s+for update;/s);
  assert.match(body, /Caulk transfer not found\./);
  assert.match(body, /Caulk transfer %s is already %s\./);
  assert.match(body, /from app\.caulk_job_allocations a\s+where a\.org_id = p_org_id\s+and a\.id = v_transfer\.caulk_allocation_id\s+for update;/s);
  assert.match(body, /Parent caulk allocation was not found\./);
  assert.match(body, /from app\.jobs j\s+where j\.org_id = p_org_id\s+and j\.id = v_allocation\.job_id\s+for update;/s);
  assert.match(body, /Job for caulk transfer %s was not found\./);
  assert.match(body, /Parent caulk allocation is no longer active\./);
  assert.match(body, /TRANSFER_IN/);
  assert.match(body, /JOB_ALLOCATE_EDIT_INC/);
  assert.match(body, /reserved_tubes_remaining = reserved_tubes_remaining \+ v_pending_tubes/);
  assert.match(body, /'RECEIVED'/);
  assert.match(body, /'jobId', v_job\.id::text/);
  assert.match(body, /'jobNumber', v_job\.job_number/);
  assert.match(body, /'productId', v_transfer\.product_id::text/);
  assert.match(body, /'sourceWarehouse', v_transfer\.source_warehouse/);
  assert.match(body, /'destinationWarehouse', v_destination_warehouse/);
  assert.doesNotMatch(body, /require_active_job_for_caulk/);
});

test('caulk transfer cancel SQL derives selected job without adding new lifecycle guards', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'app_api.caulk_cancel_pending_transfer_internal');

  assert.match(body, /from app\.caulk_transfers t\s+where t\.org_id = p_org_id\s+and t\.transfer_id = app_api\.require_text\(p_transfer_id, 'TransferId'\)\s+for update;/s);
  assert.match(body, /Caulk transfer not found\./);
  assert.match(body, /Caulk transfer %s is already %s\./);
  assert.match(body, /from app\.caulk_job_allocations a\s+where a\.org_id = p_org_id\s+and a\.id = v_transfer\.caulk_allocation_id\s+for update;/s);
  assert.match(body, /Parent caulk allocation was not found\./);
  assert.match(body, /from app\.jobs j\s+where j\.org_id = p_org_id\s+and j\.id = v_allocation\.job_id\s+for update;/s);
  assert.match(body, /Job for caulk transfer %s was not found\./);
  assert.match(body, /TRANSFER_IN/);
  assert.match(body, /'CANCELLED'/);
  assert.match(body, /'jobId', v_job\.id::text/);
  assert.match(body, /'jobNumber', v_job\.job_number/);
  assert.match(body, /'productId', v_transfer\.product_id::text/);
  assert.match(body, /'sourceWarehouse', v_transfer\.source_warehouse/);
  assert.match(body, /'destinationWarehouse', v_transfer\.destination_warehouse/);
  assert.doesNotMatch(body, /Parent caulk allocation is no longer active\./);
  assert.doesNotMatch(body, /normalize_job_lifecycle_status/);
  assert.doesNotMatch(body, /require_active_job_for_caulk/);
});

test('caulk transfer public wrappers own jobId planner scope without putting planner in shared cancel', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const receiveWrapper = extractBody(migration, 'public.api_acl_caulk_transfer_receive');
  const cancelWrapper = extractBody(migration, 'public.api_acl_caulk_transfer_cancel');
  const cancelInternal = extractBody(migration, 'app_api.caulk_cancel_pending_transfer_internal');

  for (const body of [receiveWrapper, cancelWrapper]) {
    assert.match(body, /perform app_api\.require_effective_feature_access\(p_org_id, 'inventory', 'write'\)/);
    assert.match(body, /app_api\.reconcile_auto_planned_allocations\(/);
    assert.match(body, /'jobIds', jsonb_build_array\(v_result->>'jobId'\)/);
    assert.match(body, /'jobNumbers', jsonb_build_array\(v_result->>'jobNumber'\)/);
    assert.match(body, /'caulkProductWarehousePairs'/);
    assert.match(body, /'productId', v_result->>'productId'/);
    assert.match(body, /'warehouse', v_result->>'sourceWarehouse'/);
    assert.match(body, /'warehouse', v_result->>'destinationWarehouse'/);
    assert.match(body, /jsonb_set\(v_result, '\{warnings\}', v_warnings, true\)/);
  }
  assert.doesNotMatch(cancelInternal, /reconcile_auto_planned_allocations\(/);
});

test('caulk transfer jobId scope migration keeps non-scope workflows and duplicate guards unchanged', async () => {
  const [migration, baseSchemaMigration, duplicateGuardMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(baseSchemaMigrationPath, 'utf8'),
    readFile(duplicateGuardMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.doesNotMatch(migration, /api_acl_allocations_caulk_add/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_update/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_remove/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_checkout/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_checkin/);
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

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0179_film_weight_initial_values_only\.sql';/);

  assert.match(schemaCheck, /public\.api_acl_caulk_transfer_receive\(uuid, text, jsonb\)/);
  assert.match(schemaCheck, /public\.api_acl_caulk_transfer_cancel\(uuid, text, jsonb\)/);
});

test('local caulk transfer receive and cancel return additive jobId while preserving route-owned planner', async () => {
  const [runtime, planner] = await Promise.all([
    readFile(localCaulkRuntimePath, 'utf8'),
    readFile(localPlannerPath, 'utf8'),
  ]);
  const receiveBody = extractBetween(runtime, 'export async function receiveCaulkTransfer', 'export async function cancelCaulkTransfer');
  const cancelBody = extractFrom(runtime, 'export async function cancelCaulkTransfer');
  const localSqlPlannerRoutes = extractBetween(
    planner,
    'const SQL_PLANNER_HANDLED_ROUTES',
    'const JOB_DETAIL_RELOAD_ROUTES'
  );

  assert.match(receiveBody, /requireLockedTransfer\(client, orgId, transferId\)/);
  assert.match(receiveBody, /requireLockedAllocationByRowId\(client, orgId, transfer\.caulk_allocation_id\)/);
  assert.match(receiveBody, /requireCaulkAllocationJobById\(/);
  assert.match(receiveBody, /allocation\.job_id/);
  assert.match(receiveBody, /jobId: result\.jobId/);
  assert.match(receiveBody, /sourceWarehouse: result\.sourceWarehouse/);
  assert.match(receiveBody, /destinationWarehouse: result\.destinationWarehouse/);
  assert.match(cancelBody, /requireLockedTransfer\(client, orgId, transferId\)/);
  assert.match(cancelBody, /requireLockedAllocationByRowId\(client, orgId, transfer\.caulk_allocation_id\)/);
  assert.match(cancelBody, /requireCaulkAllocationJobById\(/);
  assert.match(cancelBody, /allocation\.job_id/);
  assert.match(cancelBody, /jobId: result\.jobId/);
  assert.doesNotMatch(localSqlPlannerRoutes, /'\/caulk\/transfers\/receive'/);
  assert.doesNotMatch(localSqlPlannerRoutes, /'\/caulk\/transfers\/cancel'/);
  assert.match(planner, /addJobId\(jobIds, responseData\.jobId\)/);
});

test('Edge caulk transfer routes strip request orgId and leave planner ownership with SQL', async () => {
  const edgeHandlers = await readFile(edgeMutationHandlersPath, 'utf8');
  const receiveBody = extractBetween(edgeHandlers, '"/caulk/transfers/receive": async', '"/caulk/transfers/cancel": async');
  const cancelBody = extractBetween(edgeHandlers, '"/caulk/transfers/cancel": async', '"/jobs/create": async');

  assert.match(edgeHandlers, /const SQL_PLANNER_HANDLED_ROUTES = new Set\(\[[\s\S]*"\/caulk\/transfers\/receive"[\s\S]*"\/caulk\/transfers\/cancel"/);
  for (const body of [receiveBody, cancelBody]) {
    assert.match(body, /const \{ orgId: _requestOrgId, \.\.\.payloadWithoutRequestOrg \} = normalizedPayload;/);
    assert.match(body, /payloadWithoutRequestOrg/);
  }
});

test('frontend caulk transfer cache accepts additive jobId without unsafe legacy detail patching', async () => {
  const [domainSource, mutationSource] = await Promise.all([
    readFile(frontendCaulkDomainPath, 'utf8'),
    readFile(frontendMutationPath, 'utf8'),
  ]);
  const receiveMutationBody = extractBetween(
    mutationSource,
    'export function useReceiveCaulkTransfer',
    'export function useCancelCaulkTransfer'
  );
  const cancelMutationBody = extractBetween(
    mutationSource,
    'export function useCancelCaulkTransfer',
    '});\n}'
  );

  assert.match(domainSource, /export interface ReceiveCaulkTransferPayload \{\s+transferId: string;\s+\}/s);
  assert.match(domainSource, /export interface CancelCaulkTransferPayload \{\s+transferId: string;\s+reason\?: string;\s+\}/s);
  assert.match(domainSource, /export interface CaulkTransferMutationResult extends CaulkJobAllocationMutationResult \{\s+transferId: string;\s+sourceWarehouse\?: Warehouse;\s+destinationWarehouse\?: Warehouse;/s);
  for (const body of [receiveMutationBody, cancelMutationBody]) {
    assert.match(body, /const resultJobId = String\(result\.jobId \|\| ''\)\.trim\(\);/);
    assert.match(body, /const resultJobNumber = String\(result\.jobNumber \|\| ''\)\.trim\(\);/);
    assert.match(body, /resultJobId \? \{ jobId: resultJobId, jobNumber: resultJobNumber \} : resultJobNumber/);
    assert.match(body, /inventoryKeys\.caulkTransfersRoot/);
    assert.doesNotMatch(body, /syncJobDetailCaches/);
    assert.doesNotMatch(body, /setQueryData/);
  }
});
