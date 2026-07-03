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
  '0174_caulk_allocation_cancel_return_action.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260629101000_caulk_allocation_cancel_return_action.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

function normalizeSql(sql) {
  return String(sql || '').replace(/\r\n/g, '\n').trim();
}

test('caulk cancel-return hotfix migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(normalizeSql(backendMigration), normalizeSql(supabaseMigration));
});

test('caulk cancel-return hotfix only adds the missing reserved-tube release action', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));

  assert.match(migration, /app_api\.caulk_apply_stock_delta_for_owner\(uuid, text, uuid, text, uuid, text, integer, text, text, text, text\)/);
  assert.match(migration, /JOB_CHECKIN_UNUSED[\s\S]*JOB_ALLOCATION_CANCEL_RETURN[\s\S]*BACKFILL_MIGRATE/);
  assert.match(migration, /Unsupported caulk stock action\./);
  assert.match(migration, /and s\.owner_company_id = v_owner\.id/);
  assert.match(migration, /app_api\.require_owner_company\(p_org_id, p_owner_company_id, false\)/);
  assert.match(migration, /for update/i);
  assert.doesNotMatch(migration, /physical source-of-truth/i);
  assert.doesNotMatch(migration, /reconcile.*scheduled/i);
});

test('schema latest guard requires caulk cancel-return support on owner-aware stock delta helper', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0179_film_weight_initial_values_only\.sql';/);
  assert.match(
    schemaCheck,
    /app_api\.caulk_apply_stock_delta_for_owner\(uuid, text, uuid, text, uuid, text, integer, text, text, text, text\)/
  );
  assert.match(schemaCheck, /'JOB_ALLOCATION_CANCEL_RETURN'/);
  assert.match(schemaCheck, /Unsupported caulk stock action\./);
  assert.match(schemaCheck, /and s\.owner_company_id = v_owner\.id/);
});
