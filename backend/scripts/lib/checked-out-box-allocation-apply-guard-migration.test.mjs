import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0171_checked_out_allocation_apply_guard.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260623101000_checked_out_allocation_apply_guard.sql'
);
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('checked-out allocation apply guard migration is mirrored to Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('checked-out allocation apply guard allows checked-out sources and candidates', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /public\.api_allocations_apply\(uuid, text, jsonb\)/);
  assert.match(migration, /not in \(''IN_STOCK'', ''ORDERED'', ''TRANSFER'', ''CHECKED_OUT''\)/);
  assert.match(migration, /in \(''IN_STOCK'', ''ORDERED'', ''TRANSFER'', ''CHECKED_OUT''\)/);
  assert.match(migration, /Only in-stock, checked-out, ordered, or transfer boxes can be allocated\./);
});

test('schema latest checks checked-out allocation apply guard semantics', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');

  assert.match(schemaLatest, /const LATEST_MIGRATION = '0186_team_user_rpc_execute_grants\.sql';/);
  assert.match(schemaLatest, /Only in-stock, checked-out, ordered, or transfer boxes can be allocated\./);
  assert.match(schemaLatest, /not in \('IN_STOCK', 'ORDERED', 'TRANSFER', 'CHECKED_OUT'\)/);
  assert.match(schemaLatest, /in \('IN_STOCK', 'ORDERED', 'TRANSFER', 'CHECKED_OUT'\)/);
});
