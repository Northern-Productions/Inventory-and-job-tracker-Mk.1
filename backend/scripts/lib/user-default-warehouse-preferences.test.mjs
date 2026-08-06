import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0151_user_default_warehouse_preferences.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260525120000_user_default_warehouse_preferences.sql'
);
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('user default warehouse preference migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('user default warehouse migration persists profile setting and scopes list reads safely', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create table if not exists app\.user_preferences/);
  assert.match(migration, /foreign key \(org_id, user_id\) references app\.organization_members/);
  assert.match(migration, /default_warehouse text not null default ''/);
  assert.match(migration, /user_preferences_default_warehouse_format/);
  assert.match(migration, /alter table app\.user_preferences enable row level security/);
  assert.match(migration, /create policy user_preferences_read_self/);
  assert.match(migration, /create policy user_preferences_insert_self/);
  assert.match(migration, /create policy user_preferences_update_self/);
  assert.match(migration, /create or replace function app_api\.get_user_default_warehouse/);
  assert.match(migration, /join app\.warehouses w/);
  assert.match(migration, /'defaultWarehouse', coalesce\(v_default_warehouse, ''\)/);
  assert.match(migration, /create or replace function public\.api_update_user_default_warehouse/);
  assert.match(migration, /v_default_warehouse := app_api\.require_org_warehouse/);
  assert.match(migration, /on conflict \(org_id, user_id\) do update/);
  assert.match(migration, /create or replace function public\.api_list_jobs\(\s+p_org_id uuid,\s+p_warehouse text default null/is);
  assert.match(migration, /create or replace function public\.api_list_film_orders\(\s+p_org_id uuid,\s+p_warehouse text default null/is);
  assert.match(migration, /or upper\(trim\(j\.warehouse::text\)\) = v_warehouse/);
  assert.match(migration, /or upper\(trim\(f\.warehouse::text\)\) = v_warehouse/);
});

test('user default warehouse migration grants only authenticated profile and filtered list RPC execution', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  for (const signature of [
    'public.api_update_user_default_warehouse(uuid, text, jsonb)',
    'public.api_acl_list_film_orders(uuid, text)',
    'public.api_acl_list_jobs(uuid, text)',
  ]) {
    assert.match(migration, new RegExp(`revoke execute on function ${signature.replace(/[().]/g, '\\$&')} from public`));
    assert.match(migration, new RegExp(`revoke execute on function ${signature.replace(/[().]/g, '\\$&')} from anon`));
    assert.match(migration, new RegExp(`revoke execute on function ${signature.replace(/[().]/g, '\\$&')} from service_role`));
    assert.match(migration, new RegExp(`grant execute on function ${signature.replace(/[().]/g, '\\$&')} to authenticated`));
  }

  assert.match(migration, /revoke execute on function public\.api_list_jobs\(uuid, text\) from authenticated/);
  assert.match(migration, /revoke execute on function public\.api_list_film_orders\(uuid, text\) from authenticated/);
});

test('schema latest guard tracks user default warehouse preference objects', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');


  assert.match(schemaLatest, /const LATEST_MIGRATION = '0194_scoped_job_summary_reads\.sql';/);

  assert.match(schemaLatest, /signature: 'app\.user_preferences'/);
  assert.match(schemaLatest, /signature: 'app\.user_preferences\.default_warehouse'/);
  assert.match(schemaLatest, /signature: 'app_api\.get_user_default_warehouse\(uuid, uuid\)'/);
  assert.match(schemaLatest, /signature: 'public\.api_update_user_default_warehouse\(uuid, text, jsonb\)'/);
  assert.match(schemaLatest, /signature: 'public\.api_acl_list_film_orders\(uuid, text\)'/);
  assert.match(schemaLatest, /signature: 'public\.api_acl_list_jobs\(uuid, text\)'/);
  assert.match(schemaLatest, /'api_update_user_default_warehouse'/);
});
