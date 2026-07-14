import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0159_box_lf_correction_reconciles_allocations.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260613100000_box_lf_correction_reconciles_allocations.sql'
);
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('box LF correction migration is mirrored to Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('box LF correction migration removes stale lower-than-allocation guards', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /app_api\.build_box_from_payload\(uuid, jsonb, text\)/);
  assert.match(migration, /box LF correction stale guard still present/);
  assert.match(migration, /CurrentFeetOnRoll cannot be lower than the box''s active allocated feet/);
  assert.match(migration, /Received physical LF cannot be lower than the box''s active allocated feet/);
});

test('box update reconciliation uses explicit current LF when submitted', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /public\.api_acl_boxes_update/);
  assert.match(migration, /p_payload->>'currentFeetOnRoll'/);
  assert.match(migration, /v_material_reconciliation_result := app_api\.reconcile_box_checkin_allocations/);
});

test('receive ordered accepts current LF and reconciles before and after linked receipt resolution', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function public\.api_acl_boxes_receive_ordered/);
  assert.match(migration, /v_received_feet_text text/);
  assert.match(migration, /v_box\.initial_feet := v_received_feet/);
  assert.match(migration, /v_box\.feet_available := greatest\(coalesce\(v_box\.initial_feet, 0\) - coalesce\(v_locked_allocated_feet, 0\), 0\)/);
  assert.match(migration, /v_material_reconciliation_result := app_api\.reconcile_box_checkin_allocations/);
  assert.match(migration, /v_receipt_result := app_api\.process_linked_box_receipt\(p_org_id, v_box, p_actor\)/);
  assert.match(migration, /perform app_api\.recalculate_film_orders_for_box_links\(p_org_id, v_box\.box_id, p_actor\)/);
});

test('schema latest guards box LF correction semantics', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');

  assert.match(schemaLatest, /const LATEST_MIGRATION = '0190_calendar_cancel_service_role_grant_normalization\.sql';/);
  assert.match(schemaLatest, /v_received_feet_text text/);
  assert.match(schemaLatest, /p_payload->>'currentFeetOnRoll'/);
  assert.match(schemaLatest, /CurrentFeetOnRoll cannot be lower than the box''s active allocated feet/);
  assert.match(schemaLatest, /Received physical LF cannot be lower than the box''s active allocated feet/);
});
