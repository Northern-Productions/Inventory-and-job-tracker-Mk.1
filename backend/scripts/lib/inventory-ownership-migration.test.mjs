import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0172_inventory_ownership.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260626100000_inventory_ownership.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

function normalizeSql(sql) {
  return String(sql || '').replace(/\r\n/g, '\n').trim();
}

test('inventory ownership migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(normalizeSql(backendMigration), normalizeSql(supabaseMigration));
});

test('inventory ownership migration creates required owner tables and backfills existing inventory', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));

  assert.match(migration, /create table if not exists app\.owner_companies/i);
  assert.match(migration, /insert into app\.owner_companies[\s\S]*\('MGT', 'MGT'\)[\s\S]*\('EDH', 'EDH'\)[\s\S]*\('KAM', 'KAM'\)/i);
  assert.match(migration, /create or replace function app_api\.default_owner_company_code_for_warehouse/i);
  assert.match(migration, /when 'IL1' then 'MGT'/i);
  assert.match(migration, /when 'MS1' then 'MGT'/i);
  assert.match(migration, /when 'IL2' then 'EDH'/i);
  assert.match(migration, /when 'MO1' then 'EDH'/i);
  assert.match(migration, /update app\.boxes b[\s\S]*app_api\.default_owner_company_id_for_warehouse\(b\.org_id, b\.warehouse\)/i);
  assert.match(migration, /alter table app\.boxes[\s\S]*alter column owner_company_id set not null/i);
  assert.match(migration, /update app\.caulk_stock s[\s\S]*app_api\.default_owner_company_id_for_warehouse\(s\.org_id, s\.warehouse\)/i);
  assert.match(migration, /alter table app\.caulk_stock[\s\S]*alter column owner_company_id set not null/i);
  assert.match(migration, /add constraint caulk_stock_org_product_warehouse_owner_key[\s\S]*unique \(org_id, product_id, warehouse, owner_company_id\)/i);
  assert.doesNotMatch(migration, /insert into app\.inventory_ownership_events[\s\S]*backfill/i);
});

test('inventory ownership mutation RPCs are explicit owner-only surfaces', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));

  for (const signature of [
    'public.api_acl_owner_companies_list(uuid, boolean)',
    'public.api_acl_owner_companies_upsert(uuid, text, jsonb)',
    'public.api_acl_owner_companies_deactivate(uuid, text, jsonb)',
    'public.api_acl_inventory_ownership_update_box(uuid, text, jsonb)',
    'public.api_acl_inventory_ownership_update_caulk_stock(uuid, text, jsonb)',
    'public.api_acl_inventory_ownership_bulk_transfer(uuid, text, jsonb)'
  ]) {
    const escaped = signature.replace(/[().[\],]/g, '\\$&').replace(/\s+/g, '\\s+');
    assert.match(migration, new RegExp(`grant_execute_if_exists\\('${escaped}', 'authenticated'\\)`, 'i'));
    assert.match(migration, new RegExp(`revoke execute on function ${escaped} from anon, public, service_role`, 'i'));
  }

  assert.match(migration, /perform app_api\.require_org_owner\(p_org_id\)/i);
  assert.match(migration, /perform app_api\.append_audit_entry\([\s\S]*'OWNER_CHANGE'/i);
});

test('schema latest guard tracks inventory ownership objects', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /0177_edit_box_add_preserve_owner_company\.sql/);
  assert.match(schemaCheck, /app\.owner_companies/);
  assert.match(schemaCheck, /app\.inventory_ownership_events/);
  assert.match(schemaCheck, /owner_company_id/);
  assert.match(schemaCheck, /api_acl_inventory_ownership_update_box/);
  assert.match(schemaCheck, /api_acl_inventory_ownership_bulk_transfer/);
});
