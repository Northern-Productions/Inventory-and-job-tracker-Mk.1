import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0183_restore_api_list_memberships_execute_grant.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260707101000_restore_api_list_memberships_execute_grant.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('api list memberships execute grant migration stays mirrored', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('api list memberships execute grant is narrow and authenticated-only', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /revoke execute on function public\.api_list_memberships\(\) from public;/);
  assert.match(migration, /revoke execute on function public\.api_list_memberships\(\) from anon;/);
  assert.match(migration, /grant execute on function public\.api_list_memberships\(\) to authenticated;/);
  assert.doesNotMatch(migration, /grant\s+execute\s+on\s+all\s+functions/i);
  assert.doesNotMatch(migration, /grant\s+(select|insert|update|delete|all)\s+on\s+(table|all tables)/i);
  assert.doesNotMatch(migration, /grant\s+execute\s+on\s+function\s+public\.api_list_memberships\(\)\s+to\s+(public|anon|service_role)/i);
  assert.doesNotMatch(migration, /revoke\s+execute\s+on\s+function\s+public\.api_list_memberships\(\)\s+from\s+service_role/i);
});

test('schema latest guard tracks api list memberships execute permission', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /0186_team_user_rpc_execute_grants\.sql/);
  assert.match(schemaCheck, /public\.api_list_memberships\(\)/);
  assert.match(schemaCheck, /authenticated_list_memberships_execute/);
  assert.match(schemaCheck, /anon_list_memberships_execute/);
});
