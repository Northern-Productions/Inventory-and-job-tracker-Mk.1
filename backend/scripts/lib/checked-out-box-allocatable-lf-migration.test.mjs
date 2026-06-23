import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0169_checked_out_box_allocatable_lf.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260622100000_checked_out_box_allocatable_lf.sql'
);
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('checked-out allocatable LF migration is mirrored to Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('checked-out allocatable LF migration preserves physical LF and subtracts active claims', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.box_physical_feet_available/);
  assert.match(migration, /'IN_STOCK', 'TRANSFER', 'CHECKED_OUT'/);
  assert.match(migration, /upper\(coalesce\(p_box\.status::text, ''\)\) = 'CHECKED_OUT'/);
  assert.match(migration, /coalesce\(p_box\.feet_available, 0\)/);
  assert.match(migration, /create or replace function app_api\.box_allocatable_now_feet/);
  assert.match(migration, /app_api\.box_physical_feet_available\(p_box\)/);
  assert.match(migration, /app_api\.reserved_film_allocated_feet_for_box\(p_box\.org_id, p_box\.box_id\)/);
});

test('schema latest checks checked-out allocatable LF function semantics', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');

  assert.match(schemaLatest, /const LATEST_MIGRATION = '0169_checked_out_box_allocatable_lf\.sql';/);
  assert.match(schemaLatest, /app_api\.box_physical_feet_available\(app\.boxes\)/);
  assert.match(schemaLatest, /app_api\.box_allocatable_now_feet\(app\.boxes\)/);
  assert.match(schemaLatest, /CHECKED_OUT/);
  assert.match(schemaLatest, /app_api\.reserved_film_allocated_feet_for_box\(p_box\.org_id, p_box\.box_id\)/);
});
