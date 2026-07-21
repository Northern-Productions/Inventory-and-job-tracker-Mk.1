import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0178_film_allocation_remove_preserve_physical_lf.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260629105000_film_allocation_remove_preserve_physical_lf.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const removeBoxMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0120_remove_box_jobid_planner_scope.sql');

function extractRemoveBoxBody(sql) {
  const match = sql.match(
    /create or replace function public\.api_allocations_remove_box[\s\S]*?as \$\$\r?\n(?<body>[\s\S]*?)\r?\n\$\$;/
  );
  assert.ok(match?.groups?.body, 'Expected public.api_allocations_remove_box body.');
  return match.groups.body;
}

test('film allocation remove physical LF migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('film allocation remove captures physical LF before cancelling allocation', async () => {
  const [migration, removeBoxMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(removeBoxMigrationPath, 'utf8'),
  ]);
  const removeBoxBody = extractRemoveBoxBody(removeBoxMigration);

  assert.match(
    migration,
    /pg_get_functiondef\('public\.api_allocations_remove_box\(uuid, text, jsonb\)'::regprocedure\)/
  );
  assert.match(migration, /v_capture_anchor text := '  v_film_order_id := app_api\.trim_text\(v_allocation\.film_order_id\);';/);
  assert.match(
    migration,
    /v_capture_anchor \|\| E'\\n  ' \|\| v_capture_snippet/
  );
  assert.match(migration, /v_preserved_physical_feet integer := null;/);
  assert.match(migration, /v_preserved_physical_feet := app_api\.box_physical_feet_available\(v_box\);/);
  assert.match(
    migration,
    /v_old_recalc text := '  perform app_api\.recalculate_physical_box_allocatable_now\(p_org_id, v_box\.box_id\);';/
  );
  assert.match(migration, /v_next := replace\(v_next, v_old_recalc, v_new_recalc\);/);
  assert.match(
    migration,
    /perform app_api\.recalculate_physical_box_allocatable_now\(p_org_id, v_box\.box_id, v_preserved_physical_feet\);/
  );
  assert.ok(
    removeBoxBody.indexOf('v_film_order_id := app_api.trim_text(v_allocation.film_order_id);') <
      removeBoxBody.indexOf('update app.allocations'),
    'Expected physical LF capture anchor to happen before allocation cancellation in the patched function body.'
  );
  assert.ok(
    removeBoxBody.indexOf('update app.allocations') <
      removeBoxBody.indexOf('perform app_api.recalculate_physical_box_allocatable_now(p_org_id, v_box.box_id);'),
    'Expected recalculation with preserved physical LF to happen after cancellation.'
  );
});

test('schema latest guards allocation remove physical LF preservation semantics', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0192_atomic_cross_warehouse_affected_box_scan\.sql';/);
  assert.match(schemaCheck, /public\.api_allocations_remove_box\(uuid, text, jsonb\)/);
  assert.match(schemaCheck, /v_preserved_physical_feet integer := null;/);
  assert.match(schemaCheck, /v_preserved_physical_feet := app_api\.box_physical_feet_available\(v_box\);/);
  assert.match(
    schemaCheck,
    /perform app_api\.recalculate_physical_box_allocatable_now\(p_org_id, v_box\.box_id, v_preserved_physical_feet\);/
  );
});
