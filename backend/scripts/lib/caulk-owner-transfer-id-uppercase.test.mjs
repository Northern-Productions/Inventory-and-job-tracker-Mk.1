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
  '0187_caulk_owner_transfer_id_uppercase.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260710150000_caulk_owner_transfer_id_uppercase.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

function normalizeSql(sql) {
  return String(sql || '').replace(/\r\n/g, '\n').trim();
}

test('caulk owner transfer ID uppercase migration stays mirrored', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(normalizeSql(backendMigration), normalizeSql(supabaseMigration));
});

test('owner-aware pending caulk transfer canonicalizes generated transfer IDs', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));

  assert.match(migration, /create or replace function app_api\.caulk_start_pending_transfer_for_owner/i);
  assert.match(migration, /v_transfer_id := upper\(app_api\.caulk_create_transaction_id\(\)\);/i);
  assert.doesNotMatch(migration, /v_transfer_id := app_api\.caulk_create_transaction_id\(\);/i);
  assert.match(
    migration,
    /v_transfer_id := upper\(app_api\.caulk_create_transaction_id\(\)\);[\s\S]*app_api\.caulk_apply_stock_delta_for_owner/i
  );
  assert.match(
    migration,
    /v_transfer_id := upper\(app_api\.caulk_create_transaction_id\(\)\);[\s\S]*insert into app\.caulk_transfers/i
  );
});

test('caulk transfer value format remains uppercase-only', async () => {
  const previousMigration = normalizeSql(
    await readFile(path.join(repoRoot, 'backend', 'migrations', '0065_caulk_transfer_assist_and_new_products.sql'), 'utf8')
  );
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));

  assert.match(previousMigration, /transfer_id = upper\(btrim\(transfer_id\)\)/i);
  assert.match(previousMigration, /source_warehouse ~ '\^\[A-Z\]\{2\}\[1-9\]\[0-9\]\{0,6\}\$'/i);
  assert.doesNotMatch(migration, /drop constraint if exists caulk_transfers_value_format/i);
  assert.doesNotMatch(migration, /transfer_id\s*=\s*lower/i);
});

test('schema latest guard tracks caulk owner transfer ID canonicalization', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /0193_allocation_preview_bounded_candidates\.sql/);
  assert.match(
    schemaCheck,
    /app_api\.caulk_start_pending_transfer_for_owner\(uuid, text, uuid, text, uuid, text, uuid, uuid, text, text, integer, text\)/
  );
  assert.match(schemaCheck, /v_transfer_id := upper\(app_api\.caulk_create_transaction_id\(\)\);/);
  assert.match(schemaCheck, /v_transfer_id := app_api\.caulk_create_transaction_id\(\);/);
});
