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
  '0104_grant_access_requests_rpc_execute.sql'
);
const backendRestrictMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0105_restrict_access_requests_rpc_service_role.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260505150000_grant_access_requests_rpc_execute.sql'
);
const supabaseRestrictMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260505153000_restrict_access_requests_rpc_service_role.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('access requests RPC permission migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, backendRestrictMigration, supabaseMigration, supabaseRestrictMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(backendRestrictMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(supabaseRestrictMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
  assert.equal(supabaseRestrictMigration, backendRestrictMigration);
});

test('access requests RPC permission migration grants only authenticated execute', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /revoke execute on function public\.api_list_access_requests\(uuid, text\) from public;/);
  assert.match(migration, /revoke execute on function public\.api_list_access_requests\(uuid, text\) from anon;/);
  assert.match(migration, /grant execute on function public\.api_list_access_requests\(uuid, text\) to authenticated;/);
  assert.doesNotMatch(migration, /\bgrant\b[\s\S]*\bto service_role\b/i);
});

test('access requests RPC service-role restriction keeps the final callable surface minimal', async () => {
  const migration = await readFile(backendRestrictMigrationPath, 'utf8');

  assert.match(migration, /revoke execute on function public\.api_list_access_requests\(uuid, text\) from public;/);
  assert.match(migration, /revoke execute on function public\.api_list_access_requests\(uuid, text\) from anon;/);
  assert.match(migration, /revoke execute on function public\.api_list_access_requests\(uuid, text\) from service_role;/);
  assert.match(migration, /grant execute on function public\.api_list_access_requests\(uuid, text\) to authenticated;/);
});

test('latest schema check guards access requests RPC execute permission', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');


  assert.match(schemaCheck, /0169_checked_out_box_allocatable_lf\.sql/);

  assert.match(schemaCheck, /public\.api_list_access_requests\(uuid, text\)/);
  assert.match(schemaCheck, /'api_list_access_requests'/);
  assert.match(schemaCheck, /authenticated_access_requests_execute/);
});
