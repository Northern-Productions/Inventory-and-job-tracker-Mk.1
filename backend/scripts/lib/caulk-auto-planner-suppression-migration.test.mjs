import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0107_caulk_auto_planner_suppression.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260506130000_caulk_auto_planner_suppression.sql'
);

test('caulk auto planner suppression migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('caulk auto planner suppression migration owns remove suppression and planner gating', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /app_api\.caulk_requirement_planner_signature/);
  assert.match(migration, /app_api\.record_auto_planned_caulk_allocation_suppression/);
  assert.match(migration, /app_api\.clear_caulk_allocation_planner_suppression_for_requirement/);
  assert.match(migration, /material_type = 'CAULK'/);
  assert.match(migration, /create temporary table if not exists auto_planner_suppressed_caulk/);
  assert.match(migration, /from auto_planner_suppressed_caulk s/);
  assert.match(migration, /if v_is_suppressed then\s+continue;\s+end if;/);
  assert.match(migration, /auto_planning_suppressed/);
  assert.match(migration, /app_api\.record_auto_planned_caulk_allocation_suppression/);
  assert.match(migration, /app_api\.reconcile_auto_planned_allocations\(/);
  assert.doesNotMatch(migration, /perform app_api\.save_film_order\(/);
});
