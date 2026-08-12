import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendUpdateMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0176_edit_box_preserve_owner_company.sql'
);
const supabaseUpdateMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260629103000_edit_box_preserve_owner_company.sql'
);
const backendAddMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0177_edit_box_add_preserve_owner_company.sql'
);
const supabaseAddMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260629104000_edit_box_add_preserve_owner_company.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

function normalizeSql(sql) {
  return String(sql || '').replace(/\r\n/g, '\n').trim();
}

test('edit box owner preservation migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendUpdateMigrationPath, 'utf8'),
    readFile(supabaseUpdateMigrationPath, 'utf8')
  ]);

  assert.equal(normalizeSql(backendMigration), normalizeSql(supabaseMigration));
});

test('edit box owner preservation migration restores existing owner before save paths', async () => {
  const migration = normalizeSql(await readFile(backendUpdateMigrationPath, 'utf8'));

  assert.match(migration, /pg_get_functiondef\('public\.api_boxes_update\(uuid, text, jsonb\)'::regprocedure\)/);
  assert.match(migration, /v_box\.owner_company_id := v_existing\.owner_company_id;/);
  assert.match(migration, /v_occurrences < 2/);
  assert.match(migration, /api_boxes_update owner_company_id preservation patch did not match expected snippets/);
});

test('add box owner requirement migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendAddMigrationPath, 'utf8'),
    readFile(supabaseAddMigrationPath, 'utf8')
  ]);

  assert.equal(normalizeSql(backendMigration), normalizeSql(supabaseMigration));
});

test('add box owner requirement migration restores owner before save path', async () => {
  const migration = normalizeSql(await readFile(backendAddMigrationPath, 'utf8'));

  assert.match(migration, /pg_get_functiondef\('public\.api_boxes_add\(uuid, text, jsonb\)'::regprocedure\)/);
  assert.match(
    migration,
    /v_box\.owner_company_id := nullif\(app_api\.trim_text\(p_payload->>''ownerCompanyId''\), ''''\)::uuid;/
  );
  assert.match(migration, /perform app_api\.require_owner_company\(p_org_id, v_box\.owner_company_id, true\);/);
  assert.match(migration, /api_boxes_add owner_company_id requirement patch did not match expected snippets/);
});

test('schema latest guard requires edit and add box owner semantics', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /public\.api_boxes_add\(uuid, text, jsonb\)/);
  assert.match(
    schemaCheck,
    /v_box\.owner_company_id := nullif\(app_api\.trim_text\(p_payload->>'ownerCompanyId'\), ''\)::uuid;/
  );
  assert.match(schemaCheck, /perform app_api\.require_owner_company\(p_org_id, v_box\.owner_company_id, true\);/);
  assert.match(schemaCheck, /public\.api_boxes_update\(uuid, text, jsonb\)/);
  assert.match(schemaCheck, /v_box\.owner_company_id := v_existing\.owner_company_id;/);
});
