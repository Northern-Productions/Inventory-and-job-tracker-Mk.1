import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0170_checked_out_allocation_capacity.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260623100000_checked_out_allocation_capacity.sql'
);
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('checked-out allocation capacity migration is mirrored to Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('checked-out allocation capacity uses physical LF while ordered capacity uses initial LF', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.assert_film_box_allocation_capacity/);
  assert.match(migration, /when v_status = 'ORDERED' then greatest\(coalesce\(v_box\.initial_feet, 0\), 0\)/);
  assert.match(
    migration,
    /when v_status = 'CHECKED_OUT' then greatest\(coalesce\(app_api\.box_physical_feet_available\(v_box\), 0\), 0\)/
  );
  assert.match(
    migration,
    /app_api\.active_film_allocated_feet_for_box\(p_org_id, v_box\.box_id, p_allocation_id\)/
  );
  assert.doesNotMatch(
    migration,
    /upper\(coalesce\(v_box\.status::text, ''\)\) in \('ORDERED', 'CHECKED_OUT'\) then greatest\(coalesce\(v_box\.initial_feet, 0\), 0\)/
  );
});

test('schema latest checks checked-out allocation capacity semantics', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');

  assert.match(schemaLatest, /app_api\.assert_film_box_allocation_capacity\(uuid, text, text\)/);
  assert.match(
    schemaLatest,
    /when v_status = 'CHECKED_OUT' then greatest\(coalesce\(app_api\.box_physical_feet_available\(v_box\), 0\), 0\)/
  );
  assert.match(
    schemaLatest,
    /app_api\.active_film_allocated_feet_for_box\(p_org_id, v_box\.box_id, p_allocation_id\)/
  );
});
