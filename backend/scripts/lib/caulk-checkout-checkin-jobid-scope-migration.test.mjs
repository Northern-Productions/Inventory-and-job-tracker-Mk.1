import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0125_caulk_checkout_checkin_jobid_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260513180000_caulk_checkout_checkin_jobid_scope.sql'
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
const frontendCaulkTypesPath = path.join(repoRoot, 'frontend', 'src', 'domain', 'inventory', 'caulk.ts');
const frontendInvalidationPath = path.join(
  repoRoot,
  'frontend',
  'src',
  'features',
  'inventory',
  'hooks',
  'inventoryInvalidation.ts'
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

test('caulk checkout/check-in jobId scope migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('caulk checkout derives exact job_id from allocation row before mutation and scopes planner by jobId', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_acl_allocations_caulk_checkout');

  assert.match(body, /from app\.caulk_job_allocations a\s+where a\.org_id = p_org_id\s+and a\.caulk_allocation_id = v_caulk_allocation_id\s+for update;/s);
  assert.match(body, /from app\.jobs j\s+where j\.org_id = p_org_id\s+and j\.id = v_allocation\.job_id\s+for update;/s);
  assert.match(body, /Job for caulk allocation %s was not found\./);
  assert.match(body, /Job %s is closed and cannot receive caulk allocations\./);
  assert.doesNotMatch(body, /require_active_job_for_caulk\(p_org_id, v_allocation\.job_number\)/);
  assert.match(body, /v_job\.job_number/);
  assert.match(body, /app_api\.reconcile_auto_planned_allocations\(/);
  assert.match(body, /'jobIds', jsonb_build_array\(v_job\.id\)/);
  assert.match(body, /'jobNumbers', jsonb_build_array\(v_job\.job_number\)/);
  assert.match(body, /'caulkProductWarehousePairs'/);
  assert.match(body, /'jobId', v_job\.id::text/);
  assert.match(body, /'productId', v_allocation\.product_id::text/);
  assert.match(body, /'warehouse', v_allocation\.warehouse/);
});

test('caulk check-in derives exact job_id through checkout allocation while preserving closed-job return semantics', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_acl_allocations_caulk_checkin');

  assert.match(body, /from app\.caulk_job_checkouts c\s+where c\.org_id = p_org_id\s+and c\.caulk_checkout_id = v_caulk_checkout_id\s+for update;/s);
  assert.match(body, /from app\.caulk_job_allocations a\s+where a\.org_id = p_org_id\s+and a\.id = v_checkout\.caulk_allocation_id\s+for update;/s);
  assert.match(body, /from app\.jobs j\s+where j\.org_id = p_org_id\s+and j\.id = v_allocation\.job_id\s+for update;/s);
  assert.match(body, /Job for caulk checkout %s was not found\./);
  assert.doesNotMatch(body, /require_active_job_for_caulk\(p_org_id, v_allocation\.job_number\)/);
  assert.doesNotMatch(body, /Job %s is closed and cannot receive caulk allocations\./);
  assert.match(body, /format\('Checked in unused caulk from job %s\.', v_job\.job_number\)/);
  assert.match(body, /app_api\.reconcile_auto_planned_allocations\(/);
  assert.match(body, /'jobIds', jsonb_build_array\(v_job\.id\)/);
  assert.match(body, /'jobNumbers', jsonb_build_array\(v_job\.job_number\)/);
  assert.match(body, /'caulkProductWarehousePairs'/);
  assert.match(body, /'jobId', v_job\.id::text/);
  assert.match(body, /'productId', v_allocation\.product_id::text/);
  assert.match(body, /'warehouse', v_allocation\.warehouse/);
});

test('caulk checkout/check-in jobId scope migration keeps non-scope workflows and duplicate guards unchanged', async () => {
  const [migration, baseSchemaMigration, duplicateGuardMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(baseSchemaMigrationPath, 'utf8'),
    readFile(duplicateGuardMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.doesNotMatch(migration, /api_acl_allocations_caulk_add/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_update/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_remove/);
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
  assert.match(schemaCheck, /const LATEST_MIGRATION = '0128_caulk_remove_jobid_scope\.sql';/);
  assert.match(schemaCheck, /'jobIds', jsonb_build_array\(v_job\.id\)/);
  assert.match(schemaCheck, /'caulkProductWarehousePairs'/);
});

test('local runtime checkout derives jobId from the allocation row and planner scope accepts returned jobId', async () => {
  const [runtime, planner] = await Promise.all([
    readFile(localCaulkRuntimePath, 'utf8'),
    readFile(localPlannerPath, 'utf8'),
  ]);
  const checkoutBody = extractBetween(runtime, 'export async function checkoutCaulkAllocation', 'export function checkinCaulkAllocation');

  assert.match(checkoutBody, /requireLockedAllocation\(client, orgId, caulkAllocationId\)/);
  assert.match(checkoutBody, /requireCaulkAllocationJobById\(\s*client,\s*orgId,\s*allocation\.job_id,/s);
  assert.match(checkoutBody, /assertActiveCaulkJob\(selectedJob\)/);
  assert.doesNotMatch(checkoutBody, /requireActiveJobForCaulk\(client, orgId, allocation\.job_number\)/);
  assert.match(checkoutBody, /asTrimmedString\(selectedJob\.job_number\)/);
  assert.match(checkoutBody, /jobId: asTrimmedString\(selectedJob\.id\)/);
  assert.match(checkoutBody, /productId: asTrimmedString\(allocation\.product_id\)/);
  assert.match(checkoutBody, /warehouse: currentWarehouse/);
  assert.match(planner, /'\/allocations\/caulk\/checkin'/);
  assert.doesNotMatch(planner, /'\/allocations\/caulk\/checkout',\s*\n\s*'\/allocations\/caulk\/remove'/);
  assert.match(planner, /addJobId\(jobIds, responseData\.jobId\);/);
});

test('Edge checkout/check-in strip request orgId and delegate planner ownership to SQL RPCs', async () => {
  const edgeHandlers = await readFile(edgeMutationHandlersPath, 'utf8');
  const checkoutBody = extractBetween(edgeHandlers, '"/allocations/caulk/checkout": async', '"/allocations/caulk/checkin": async');
  const checkinBody = extractBetween(edgeHandlers, '"/allocations/caulk/checkin": async', '"/allocations/caulk/remove": async');

  assert.match(edgeHandlers, /"\/allocations\/caulk\/checkout"/);
  assert.match(edgeHandlers, /"\/allocations\/caulk\/checkin"/);
  assert.match(checkoutBody, /const \{ orgId: _requestOrgId, \.\.\.payloadWithoutRequestOrg \} = normalizedPayload;/);
  assert.match(checkoutBody, /api_acl_allocations_caulk_checkout/);
  assert.match(checkoutBody, /payloadWithoutRequestOrg/);
  assert.match(checkinBody, /const \{ orgId: _requestOrgId, \.\.\.payloadWithoutRequestOrg \} = normalizedPayload;/);
  assert.match(checkinBody, /api_acl_allocations_caulk_checkin/);
  assert.match(checkinBody, /payloadWithoutRequestOrg/);
});

test('frontend caulk checkout/check-in payloads remain unchanged while optional jobId response is accepted safely', async () => {
  const [types, invalidation] = await Promise.all([
    readFile(frontendCaulkTypesPath, 'utf8'),
    readFile(frontendInvalidationPath, 'utf8'),
  ]);

  assert.match(types, /export interface CaulkJobAllocationMutationResult \{\s+jobId\?: string;/s);
  assert.match(types, /productId\?: string;/);
  assert.match(types, /warehouse\?: string;/);
  assert.match(invalidation, /identity: string \| JobCacheIdentity/);
  assert.match(invalidation, /inventoryKeys\.jobById\(jobId\)/);
  assert.match(invalidation, /const includeLegacyJobDetail = !jobId && jobNumber;/);
  assert.match(invalidation, /\['caulk', 'stock'\]/);
  assert.match(invalidation, /\['caulk', 'transactions'\]/);
});
