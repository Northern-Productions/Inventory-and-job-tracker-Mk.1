import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0095_narrow_auto_planner_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260428180000_narrow_auto_planner_scope.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('narrow auto planner scope migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('narrow auto planner scope migration avoids warehouse-wide scoped planning', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.auto_planner_scope_job_numbers/);
  assert.match(migration, /auto_planner_scope_boxes/);
  assert.match(migration, /auto_planner_explicit_box_scope/);
  assert.match(migration, /app_api\.requirement_film_is_compatible\(/);
  assert.match(migration, /sb\.status = 'IN_STOCK'/);
  assert.match(migration, /on conflict \(box_id\) do nothing/);
  assert.match(migration, /perform 1\s+from app\.boxes b\s+join auto_planner_boxes bx/s);
  assert.match(migration, /Expected broad planner box scope snippet was not found/);
  assert.doesNotMatch(
    migration,
    /auto_planner_scope_warehouses[\s\S]*upper\(j\.warehouse::text\) in \(select warehouse from auto_planner_scope_warehouses\)/
  );
});

test('schema check keeps manual-only planner semantics after later hotfix migrations', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /0155_film_order_detail_origin_compat\.sql/);
  assert.match(schemaCheck, /app_api\.auto_planner_scope_job_numbers\(uuid, jsonb\)/);
  assert.match(schemaCheck, /'manualOnly', true/);
  assert.match(schemaCheck, /'filmInserted', 0/);
  assert.doesNotMatch(schemaCheck, /auto_planner_explicit_box_scope/);
});
