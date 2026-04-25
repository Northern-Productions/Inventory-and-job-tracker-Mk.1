import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0086_planner_suppressions.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260425123000_planner_suppressions.sql'
);

test('planner suppression migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('planner suppression migration gates AUTO creation while preserving read visibility', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create table if not exists app\.allocation_planner_suppressions/);
  assert.match(migration, /app_api\.record_auto_planned_allocation_suppression/);
  assert.match(migration, /app_api\.clear_allocation_planner_suppression_for_requirement/);
  assert.match(migration, /create temporary table if not exists auto_planner_suppressed_film/);
  assert.match(migration, /if v_is_suppressed then\s+continue;\s+end if;/);
  assert.match(migration, /auto_planning_suppressed/);
  assert.doesNotMatch(migration, /perform app_api\.save_film_order\(/);
});
