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
  '0175_caulk_cancel_return_owner_resolution.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260629102000_caulk_cancel_return_owner_resolution.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

function normalizeSql(sql) {
  return String(sql || '').replace(/\r\n/g, '\n').trim();
}

test('caulk cancel-return owner resolution migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(normalizeSql(backendMigration), normalizeSql(supabaseMigration));
});

test('caulk generic stock delta resolves cancel-return owner from the allocation public id', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));

  assert.match(migration, /create or replace function app_api\.caulk_apply_stock_delta\(/);
  assert.match(migration, /v_action text := upper\(app_api\.trim_text\(p_action\)\)/);
  assert.match(migration, /when v_action = 'JOB_ALLOCATION_CANCEL_RETURN'/);
  assert.match(migration, /app_api\.caulk_owner_from_allocation_public_id\(p_org_id, p_source_box_id\)/);
  assert.match(migration, /app_api\.resolve_caulk_stock_owner_company_id/);
  assert.match(migration, /app_api\.caulk_apply_stock_delta_for_owner/);
  assert.doesNotMatch(migration, /physical source-of-truth/i);
  assert.doesNotMatch(migration, /scheduled\/no-date/i);
});

test('schema latest guard requires cancel-return owner resolution on generic stock delta wrapper', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0187_caulk_owner_transfer_id_uppercase\.sql';/);
  assert.match(schemaCheck, /app_api\.caulk_apply_stock_delta\(uuid, text, uuid, text, text, integer, text, text, text, text\)/);
  assert.match(schemaCheck, /v_action = 'JOB_ALLOCATION_CANCEL_RETURN'/);
  assert.match(schemaCheck, /app_api\.caulk_owner_from_allocation_public_id\(p_org_id, p_source_box_id\)/);
  assert.match(schemaCheck, /app_api\.caulk_apply_stock_delta_for_owner/);
});
