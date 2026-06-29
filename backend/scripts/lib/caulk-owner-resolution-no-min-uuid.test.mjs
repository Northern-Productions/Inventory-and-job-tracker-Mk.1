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
  '0173_caulk_owner_resolution_no_min_uuid.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260629100000_caulk_owner_resolution_no_min_uuid.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

function normalizeSql(sql) {
  return String(sql || '').replace(/\r\n/g, '\n').trim();
}

test('caulk owner resolution hotfix migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(normalizeSql(backendMigration), normalizeSql(supabaseMigration));
});

test('caulk owner resolution avoids min(uuid) and uses exact-one stock row behavior', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));

  assert.match(migration, /create or replace function app_api\.resolve_caulk_stock_owner_company_id/i);
  assert.doesNotMatch(migration, /min\s*\(\s*s\.owner_company_id\s*\)/i);
  assert.match(migration, /select count\(\*\)::integer\s+into v_count[\s\S]*from app\.caulk_stock s/i);
  assert.match(
    migration,
    /if v_count = 1 then[\s\S]*select s\.owner_company_id[\s\S]*into v_owner_company_id[\s\S]*from app\.caulk_stock s/i
  );
  assert.match(
    migration,
    /if v_count = 0 then[\s\S]*return app_api\.default_owner_company_id_for_warehouse\(p_org_id, v_warehouse\)/i
  );
  assert.match(
    migration,
    /Multiple owner rows exist for this caulk product and warehouse\. Select an exact owner row\./
  );
});

test('schema latest guard requires the caulk owner resolution hotfix semantics', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /0177_edit_box_add_preserve_owner_company\.sql/);
  assert.match(schemaCheck, /app_api\.resolve_caulk_stock_owner_company_id\(uuid, uuid, text, uuid, uuid\)/);
  assert.match(schemaCheck, /select count\(\*\)::integer/);
  assert.match(schemaCheck, /min\(s\.owner_company_id\)/);
});
