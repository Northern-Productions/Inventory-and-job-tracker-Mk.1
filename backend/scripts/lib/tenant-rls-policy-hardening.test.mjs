import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0180_tenant_rls_policy_hardening.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260706100000_tenant_rls_policy_hardening.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

const tenantTables = [
  'allocation_planner_suppressions',
  'box_dealers',
  'box_id_aliases',
  'box_transfers',
  'caulk_backfill_map',
  'caulk_job_allocations',
  'caulk_job_checkouts',
  'caulk_manufacturers',
  'caulk_products',
  'caulk_stock',
  'caulk_transactions',
  'caulk_transfers',
  'film_name_aliases',
  'inventory_ownership_events',
  'job_caulk_requirements',
  'owner_companies',
  'warehouses'
];

function normalizeSql(sql) {
  return String(sql || '').replace(/\r\n/g, '\n').trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('tenant RLS hardening migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(normalizeSql(backendMigration), normalizeSql(supabaseMigration));
});

test('tenant RLS hardening migration fixes owner policy predicates without same-alias tautologies', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));

  assert.match(migration, /create or replace function app\.is_org_owner\(target_org_id uuid\)/i);
  assert.match(migration, /security definer/i);
  assert.match(migration, /member_row\.org_id = target_org_id/i);
  assert.match(migration, /member_row\.user_id = auth\.uid\(\)/i);
  assert.match(migration, /member_row\.role = 'owner'/i);
  assert.match(migration, /grant execute on function app\.is_org_owner\(uuid\) to authenticated, service_role/i);
  assert.doesNotMatch(migration, /grant execute on function app\.is_org_owner\(uuid\) to anon/i);

  assert.match(
    migration,
    /create policy members_write_owner on app\.organization_members[\s\S]*using \(app\.is_org_owner\(org_id\)\)[\s\S]*with check \(app\.is_org_owner\(org_id\)\)/i
  );
  assert.match(
    migration,
    /create policy owner_notification_preferences_write_self on app\.owner_notification_preferences[\s\S]*owner_user_id = auth\.uid\(\)[\s\S]*app\.is_org_owner\(org_id\)/i
  );
  assert.doesNotMatch(migration, /\bself\.org_id\s*=\s*self\.org_id\b/i);
  assert.doesNotMatch(migration, /\bm\.org_id\s*=\s*m\.org_id\b/i);
});

test('tenant RLS hardening migration enables RLS and revokes direct non-service table access', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));

  for (const table of tenantTables) {
    assert.match(
      migration,
      new RegExp(`'alter table app\\.%I enable row level security'[\\s\\S]*tenant_table`, 'i'),
      `expected dynamic RLS enablement loop for ${table}`
    );
    assert.match(migration, new RegExp(`'${escapeRegex(table)}'`, 'i'), `expected tenant table ${table}`);
  }

  assert.match(migration, /create policy tenant_member_select on app\.\%I for select using \(app\.is_org_member\(org_id\)\)/i);
  assert.match(
    migration,
    /revoke select, insert, update, delete on table app\.\%I from public, anon, authenticated/i
  );
  assert.doesNotMatch(migration, /from public, anon, authenticated, service_role/i);
  assert.doesNotMatch(migration, /from service_role/i);
  assert.doesNotMatch(migration, /force row level security/i);
});

test('schema latest guard enforces tenant RLS policy hardening', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /0182_client_pilot_explicit_warehouses\.sql/);
  assert.match(schemaCheck, /app\.is_org_owner\(uuid\)/);
  assert.match(schemaCheck, /ORG_TABLE_RLS_ALLOWLIST = new Set\(\[\]\)/);
  assert.match(schemaCheck, /ORG_TABLE_DIRECT_AUTH_WRITE_ALLOWLIST = new Set\(\[\]\)/);
  assert.match(schemaCheck, /SUSPICIOUS_POLICY_TAUTOLOGY_PATTERN/);
  assert.match(schemaCheck, /relrowsecurity/);
  assert.match(schemaCheck, /role_table_grants/);
  assert.match(schemaCheck, /organization_members\.members_write_owner/);
  assert.match(schemaCheck, /owner_notification_preferences\.owner_notification_preferences_write_self/);
});
