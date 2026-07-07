import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0181_tenant_direct_write_grants_hardening.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260706101000_tenant_direct_write_grants_hardening.sql'
);
const backend0180Path = path.join(repoRoot, 'backend', 'migrations', '0180_tenant_rls_policy_hardening.sql');
const supabase0180Path = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260706100000_tenant_rls_policy_hardening.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

const expected0180Hash = 'ad23b69d73610878a3702235da8c65076af80f354c9d2f53c18c1289fb96a7bf';

const hardenedTables = [
  'access_requests',
  'admin_feature_permissions',
  'allocations',
  'audit_log',
  'boxes',
  'film_catalog',
  'film_order_box_links',
  'film_order_events',
  'film_orders',
  'film_weight_pending_reviews',
  'film_weight_profiles',
  'film_weight_samples',
  'general_feature_permissions',
  'job_phases',
  'job_requirements',
  'jobs',
  'organization_members',
  'organizations',
  'owner_notification_preferences',
  'roll_weight_log',
  'user_preferences',
  'username_change_requests',
];

function normalizeSql(sql) {
  return String(sql || '').replace(/\r\n/g, '\n').trim();
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('tenant direct write grants hardening migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(normalizeSql(backendMigration), normalizeSql(supabaseMigration));
});

test('tenant direct write grants hardening leaves 0180 unchanged', async () => {
  const [backend0180, supabase0180] = await Promise.all([
    readFile(backend0180Path, 'utf8'),
    readFile(supabase0180Path, 'utf8'),
  ]);

  assert.equal(sha256(normalizeSql(backend0180)), expected0180Hash);
  assert.equal(sha256(normalizeSql(supabase0180)), expected0180Hash);
  assert.equal(normalizeSql(backend0180), normalizeSql(supabase0180));
});

test('tenant direct write grants hardening revokes writes for every affected org-bearing table', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));

  for (const table of hardenedTables) {
    assert.match(migration, new RegExp(`'${escapeRegex(table)}'`, 'i'), `expected ${table} in hardening list`);
  }

  assert.equal((migration.match(/revoke insert, update, delete on table app\.%I from public, anon, authenticated/gi) || []).length, 1);
  assert.doesNotMatch(migration, /revoke\s+select\b/i);
  assert.doesNotMatch(migration, /revoke\s+execute\b/i);
  assert.doesNotMatch(migration, /\brevoke\b[^;]*\bfrom\b[^;]*\bservice_role\b/i);
  assert.doesNotMatch(migration, /force row level security/i);
  assert.doesNotMatch(migration, /\b(insert|update|delete)\s+from\s+app\./i);
  assert.doesNotMatch(migration, /\bdrop\s+policy\b/i);
});

test('schema latest guard requires tenant direct write grants hardening with no allowlist', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0182_client_pilot_explicit_warehouses\.sql';/);
  assert.match(schemaCheck, /ORG_TABLE_DIRECT_AUTH_WRITE_ALLOWLIST = new Set\(\[\]\)/);
  assert.match(schemaCheck, /ORG_TABLE_DIRECT_WRITE_GRANTEES = \['public', 'anon', 'authenticated'\]/);
  assert.match(schemaCheck, /role_table_grants/);
  assert.match(schemaCheck, /privilege_type in \('INSERT', 'UPDATE', 'DELETE'\)/);
  assert.match(schemaCheck, /app\.is_org_owner\(uuid\)/);
  assert.match(schemaCheck, /SUSPICIOUS_POLICY_TAUTOLOGY_PATTERN/);
});
