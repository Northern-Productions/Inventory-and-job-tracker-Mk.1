import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0110_preserve_caulk_on_film_order_cancel.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260507110000_preserve_caulk_on_film_order_cancel.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('film-order cancel caulk preservation migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('film-order cancel keeps film release behavior without caulk cancellation side effects', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function public\.api_film_orders_cancel/);
  assert.match(migration, /v_entry\.status := 'CANCELLED';/);
  assert.match(migration, /perform app_api\.save_allocation\(v_entry\);/);
  assert.match(migration, /app_api\.next_feet_available_after_allocation_release\(/);
  assert.match(migration, /perform app_api\.delete_film_order_links_by_film_order_id\(p_org_id, v_order\.film_order_id\);/);
  assert.match(migration, /perform app_api\.delete_film_order\(p_org_id, v_order\.film_order_id\);/);
  assert.match(migration, /lifecycle_status = 'CANCELLED'/);
  assert.match(migration, /Released %s active film allocation%s across %s box%s and deleted %s film order%s\./);
  assert.doesNotMatch(migration, /app_api\.cancel_active_caulk_allocations_for_job\(/);
  assert.doesNotMatch(migration, /JOB_ALLOCATION_CANCEL_RETURN/);
  assert.doesNotMatch(migration, /caulk_job_allocations/);
});

test('latest schema check tracks film-order cancel caulk preservation semantics', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /0150_phase_workflow_status\.sql/);
  assert.match(schemaCheck, /public\.api_film_orders_cancel\(uuid, text, jsonb\)/);
  assert.match(schemaCheck, /app_api\.cancel_active_caulk_allocations_for_job\(/);
  assert.match(schemaCheck, /JOB_ALLOCATION_CANCEL_RETURN/);
  assert.match(schemaCheck, /caulk_job_allocations/);
});
