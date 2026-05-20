import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0091_atomic_job_allocation_remove.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260427100000_atomic_job_allocation_remove.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('atomic allocation remove migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('atomic allocation remove migration validates ids and scopes every write', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function public\.api_allocations_remove_box/);
  assert.match(migration, /create or replace function public\.api_acl_allocations_remove_box/);
  assert.match(migration, /app_api\.require_job_number_digits\(v_payload->>'jobNumber', 'JobNumber'\)/);
  assert.match(migration, /app_api\.require_text\(v_payload->>'allocationId', 'AllocationID'\)/);
  assert.match(migration, /from app\.allocations a\s+where a\.org_id = p_org_id\s+and a\.allocation_id = v_allocation_id/s);
  assert.match(migration, /for update;/);
  assert.match(migration, /update app\.allocations\s+set status = 'CANCELLED'/);
  assert.match(migration, /where org_id = p_org_id\s+and allocation_id = v_allocation\.allocation_id/s);
  assert.doesNotMatch(migration, /\.schema\(/);
  assert.doesNotMatch(migration, /\.update\(/);
  assert.doesNotMatch(migration, /\.delete\(/);
});

test('atomic allocation remove migration recalculates dependent allocation state atomically', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /app_api\.record_auto_planned_allocation_suppression\(/);
  assert.match(migration, /app_api\.recalculate_physical_box_allocatable_now\(p_org_id, v_box\.box_id\)/);
  assert.match(migration, /app_api\.recalculate_film_order\(p_org_id, v_film_order_id, v_actor\)/);
  assert.match(migration, /app_api\.reconcile_auto_planned_allocations\(/);
  assert.match(migration, /'jobNumbers', jsonb_build_array\(v_job\.job_number\)/);
  assert.match(migration, /'boxIds', jsonb_build_array\(v_box\.box_id\)/);
});

test('allocation remove RPC remains jobNumber and planner-scope limited for guarded transition slice', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /v_job_number text := app_api\.require_job_number_digits\(v_payload->>'jobNumber', 'JobNumber'\)/);
  assert.doesNotMatch(migration, /v_payload->>'jobId'/);
  assert.doesNotMatch(migration, /p_payload->>'jobId'/);
  assert.match(migration, /'jobNumbers', jsonb_build_array\(v_job\.job_number\)/);
  assert.match(migration, /'boxIds', jsonb_build_array\(v_box\.box_id\)/);
});

test('latest schema check requires atomic allocation remove RPCs', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /0138_preserve_partial_box_update_physical_feet\.sql/);
  assert.match(schemaCheck, /public\.api_allocations_remove_box\(uuid, text, jsonb\)/);
  assert.match(schemaCheck, /public\.api_acl_allocations_remove_box\(uuid, text, jsonb\)/);
  assert.match(schemaCheck, /perform app_api\.recalculate_physical_box_allocatable_now\(p_org_id, v_box\.box_id\);/);
});
