import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0098_box_checkin_reconciliation.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260428210000_box_checkin_reconciliation.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('box check-in reconciliation migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('box check-in reconciliation preserves reservations by reservation order and locks rows', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const reconciliationFunction = extractFunctionBody(migration, 'app_api.reconcile_box_checkin_allocations');

  assert.match(migration, /create or replace function app_api\.reconcile_box_checkin_allocations/);
  assert.match(reconciliationFunction, /from app\.boxes b[\s\S]*for update;/);
  assert.match(reconciliationFunction, /from app\.allocations a[\s\S]*order by a\.created_at asc, a\.allocation_id asc[\s\S]*for update/);
  assert.doesNotMatch(reconciliationFunction, /order by[^;]*(job_date|due_date|install_date)/i);
});

test('box check-in reconciliation reduces or cancels allocations and recomputes coverage', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /set allocated_feet = v_next_allocated_feet/);
  assert.match(migration, /covered_feet = v_next_covered_feet/);
  assert.match(migration, /app_api\.compute_covered_feet_from_allocation\(/);
  assert.match(migration, /set status = 'CANCELLED'/);
  assert.match(migration, /if v_active_reserved_feet > greatest\(coalesce\(p_physical_feet_after, 0\), 0\) then/);
});

test('box check-in reconciliation updates only existing FILM_ORDER rows', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const matchFunction = extractFunctionBody(migration, 'app_api.film_order_matches_requirement');
  const orderReconciliationFunction = extractFunctionBody(
    migration,
    'app_api.reconcile_existing_film_order_need_for_requirement'
  );

  assert.match(matchFunction, /when p_order_requirement_id is not null or p_requirement_id is not null then/);
  assert.match(matchFunction, /p_order_requirement_id is not null\s+and p_requirement_id is not null\s+and p_order_requirement_id = p_requirement_id/);
  assert.match(orderReconciliationFunction, /coalesce\(fo\.status::text, ''\) = 'FILM_ORDER'/);
  assert.match(orderReconciliationFunction, /coalesce\(fo\.status::text, ''\) = 'FILM_ON_THE_WAY'/);
  assert.match(orderReconciliationFunction, /when coalesce\(fo\.ordered_feet, 0\) > 0 then coalesce\(fo\.ordered_feet, 0\)/);
  assert.match(orderReconciliationFunction, /v_needed_order_feet := greatest\(v_missing_feet - v_on_the_way_feet, 0\)/);
  assert.doesNotMatch(orderReconciliationFunction, /insert into app\.film_orders/);
});

test('latest schema check requires box check-in reconciliation objects', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /0151_user_default_warehouse_preferences\.sql/);
  assert.match(schemaCheck, /app\.film_orders\.requirement_id/);
  assert.match(schemaCheck, /app_api\.reconcile_box_checkin_allocations\(uuid, text, text, integer\)/);
});

function extractFunctionBody(migration, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = migration.match(new RegExp(`create or replace function ${escapedName}[\\s\\S]*?\\n\\$\\$;`));
  assert.ok(match, `Expected migration to define ${functionName}`);
  return match[0];
}
