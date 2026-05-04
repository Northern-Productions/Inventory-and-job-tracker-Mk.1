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
  '0102_public_rpc_authenticated_permission_hardening.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260504110000_public_rpc_authenticated_permission_hardening.sql'
);

test('public RPC permission hardening migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('public RPC permission hardening grants schema usage but only re-grants ACL/auth RPCs', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /grant usage on schema public to authenticated;/);
  assert.match(migration, /p\.proname like 'api\\_%' escape '\\'/);
  assert.match(migration, /revoke execute on function %s from public/);
  assert.match(migration, /revoke execute on function %s from anon/);
  assert.match(migration, /revoke execute on function %s from authenticated/);
  assert.match(migration, /p\.proname like 'api\\_acl\\_%' escape '\\'/);
  assert.match(migration, /'api_get_auth_context'/);
  assert.match(migration, /'api_update_user_feature_permissions'/);
  assert.match(migration, /grant execute on function %s to authenticated/);
  assert.match(migration, /alter default privileges in schema public revoke execute on functions from public;/);
});
