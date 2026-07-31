import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0092_safe_update_job_create_planner.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260427110000_safe_update_job_create_planner.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('safe-update job create migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('safe-update job create migration guards every targeted replacement', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /pg_get_functiondef\('app_api\.save_job\(app\.jobs\)'::regprocedure\)/);
  assert.match(
    migration,
    /pg_get_functiondef\('app_api\.reconcile_auto_planned_allocations\(uuid, text, jsonb\)'::regprocedure\)/
  );
  assert.match(migration, /Expected unsafe app_api\.save_job upsert snippet was not found/);
  assert.match(migration, /Expected unsafe planner capacity UPDATE snippet was not found/);
  assert.match(migration, /Expected unsafe planner checked-out UPDATE snippet was not found/);
  assert.match(migration, /Expected unsafe planner film upsert snippet was not found/);
  assert.match(migration, /Expected unsafe planner caulk upsert snippet was not found/);
});

test('safe-update job create migration adds scoped WHERE clauses', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /where app\.jobs\.org_id = excluded\.org_id\s+and app\.jobs\.job_number = excluded\.job_number/s);
  assert.match(migration, /where bx\.box_id is not null/);
  assert.match(
    migration,
    /where auto_planner_desired_film\.job_id = excluded\.job_id\s+and auto_planner_desired_film\.requirement_id = excluded\.requirement_id\s+and auto_planner_desired_film\.box_id = excluded\.box_id/s
  );
  assert.match(
    migration,
    /where auto_planner_desired_caulk\.job_id = excluded\.job_id\s+and auto_planner_desired_caulk\.requirement_id = excluded\.requirement_id\s+and auto_planner_desired_caulk\.product_id = excluded\.product_id\s+and auto_planner_desired_caulk\.warehouse = excluded\.warehouse/s
  );
});

test('latest schema check keeps job create hotfix coverage while requiring manual-only planner semantics', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');


  assert.match(schemaCheck, /0193_allocation_preview_bounded_candidates\.sql/);

  assert.match(schemaCheck, /app_api\.save_job\(app\.jobs\)/);
  assert.match(schemaCheck, /where app\.jobs\.org_id = excluded\.org_id\\n    and app\.jobs\.job_number = excluded\.job_number/);
  assert.match(schemaCheck, /'manualOnly', true/);
  assert.match(schemaCheck, /filmInserted', 0/);
  assert.match(schemaCheck, /caulkInserted', 0/);
  assert.doesNotMatch(schemaCheck, /where auto_planner_desired_film\.job_id = excluded\.job_id/);
  assert.doesNotMatch(schemaCheck, /where auto_planner_desired_caulk\.job_id = excluded\.job_id/);
});
