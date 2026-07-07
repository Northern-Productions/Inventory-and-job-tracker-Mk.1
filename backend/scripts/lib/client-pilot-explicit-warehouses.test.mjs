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
  '0182_client_pilot_explicit_warehouses.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260707100000_client_pilot_explicit_warehouses.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

function normalizeSql(sql) {
  return String(sql || '').replace(/\r\n/g, '\n').trim();
}

test('client pilot explicit warehouses migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(normalizeSql(backendMigration), normalizeSql(supabaseMigration));
});

test('client pilot migration removes only the automatic org warehouse seed trigger', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));

  assert.match(migration, /drop trigger if exists trg_seed_default_warehouses on app\.organizations/i);
  assert.match(migration, /comment on function app_api\.seed_default_warehouses_for_new_org\(\)/i);
  assert.match(migration, /comment on function app_api\.ensure_default_warehouses_for_org\(uuid, text\)/i);
  assert.match(migration, /warehouses are explicit per organization/i);
  assert.doesNotMatch(migration, /drop function/i);
  assert.doesNotMatch(migration, /\bdelete\s+from\s+app\.warehouses\b/i);
  assert.doesNotMatch(migration, /\bupdate\s+app\.warehouses\b/i);
  assert.doesNotMatch(migration, /\binsert\s+into\s+app\.warehouses\b/i);
  assert.doesNotMatch(migration, /\balter table app\.warehouses\b/i);
});

test('schema latest guard expects client pilot explicit warehouses migration', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0183_restore_api_list_memberships_execute_grant\.sql';/);
});
