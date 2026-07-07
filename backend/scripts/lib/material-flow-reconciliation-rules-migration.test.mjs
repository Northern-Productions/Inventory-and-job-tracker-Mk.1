import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0158_material_flow_reconciliation_rules.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260608130000_material_flow_reconciliation_rules.sql'
);
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('material-flow reconciliation migration is mirrored to Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('material-flow migration documents and enforces floor width coverage', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.allocation_coverage_multiplier/);
  assert.match(migration, /floor\(coalesce\(p_source_width_in, 0\) \/ nullif\(coalesce\(p_requirement_width_in, 0\), 0\)\)::integer/);
  assert.match(migration, /when coalesce\(p_source_width_in, 0\) < coalesce\(p_requirement_width_in, 0\) then 0/);
  assert.match(migration, /create or replace function app_api\.plan_allocation_coverage/);
});

test('material-flow migration recalculates film orders from corrected linked box reality', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.recalculate_film_order/);
  assert.match(migration, /app_api\.compute_covered_feet_from_allocation\(/);
  assert.match(migration, /greatest\(coalesce\(b\.initial_feet, l\.ordered_feet, 0\), 0\)::integer/);
  assert.doesNotMatch(migration, /coalesce\(sum\(l\.ordered_feet\)/);
});

test('material-flow migration counts placeholders against stored capacity', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.film_allocation_consumes_stored_capacity/);
  assert.match(migration, /app_api\.film_allocation_reserves_capacity\(p_allocation, p_box_status\)/);
  assert.match(migration, /\(p_allocation\)\.status = 'ACTIVE'/);
  assert.match(migration, /upper\(coalesce\(p_box_status, ''\)\) in \('IN_STOCK', 'TRANSFER'\)/);
  assert.doesNotMatch(migration, /coalesce\(\(p_allocation\)\.allocation_source::text, 'MANUAL'\) <> 'AUTO_PLANNED'/);
  assert.doesNotMatch(migration, /coalesce\(\(p_allocation\)\.allocation_source::text, 'MANUAL'\) = 'FILM_ORDER_RECEIPT'/);
});

test('material-flow backfill updates only boxes whose derived availability changes', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create temp table if not exists material_flow_stored_commitments/);
  assert.match(migration, /app_api\.film_allocation_consumes_stored_capacity\(a, b\.status::text\)/);
  assert.match(migration, /create index if not exists material_flow_box_physical_snapshot_key_idx/);
  assert.match(migration, /create index if not exists material_flow_stored_commitments_key_idx/);
  assert.match(
    migration,
    /b\.feet_available is distinct from greatest\(s\.physical_feet - coalesce\(c\.stored_feet, 0\), 0\)/
  );
});

test('material-flow migration hooks box edits into reconciliation', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /public\.api_acl_boxes_update/);
  assert.match(migration, /v_material_reconciliation_result := app_api\.reconcile_box_checkin_allocations/);
  assert.match(migration, /perform app_api\.recalculate_film_orders_for_box_links\(p_org_id, v_lookup_box_id, p_actor\);/);
  assert.match(migration, /perform app_api\.recalculate_physical_box_allocatable_now\(p_org_id, v_lookup_box_id\);/);
});

test('schema latest checks material-flow migration semantics', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');

  assert.match(schemaLatest, /const LATEST_MIGRATION = '0182_client_pilot_explicit_warehouses\.sql';/);
  assert.match(schemaLatest, /app_api\.compute_covered_feet_from_allocation\(/);
  assert.match(schemaLatest, /coalesce\(b\.initial_feet, l\.ordered_feet, 0\)/);
  assert.match(schemaLatest, /v_material_reconciliation_result := app_api\.reconcile_box_checkin_allocations/);
});
