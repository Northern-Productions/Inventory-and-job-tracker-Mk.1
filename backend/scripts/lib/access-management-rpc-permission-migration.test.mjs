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
  '0106_grant_access_management_rpc_execute.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260506100000_grant_access_management_rpc_execute.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

const accessManagementRpcSignatures = [
  'public.api_list_access_requests(uuid, text)',
  'public.api_approve_access_request(uuid, text, jsonb)',
  'public.api_deny_access_request(uuid, text, jsonb)',
  'public.api_list_username_change_requests(uuid, text)',
  'public.api_approve_username_change_request(uuid, text, jsonb)',
  'public.api_deny_username_change_request(uuid, text, jsonb)',
  'public.api_get_member_feature_permissions(uuid)',
  'public.api_update_member_feature_permissions(uuid, text, jsonb)',
  'public.api_get_user_feature_permissions(uuid, uuid)',
  'public.api_update_user_feature_permissions(uuid, text, jsonb)',
  'public.api_get_admin_feature_permissions(uuid)',
  'public.api_update_admin_feature_permissions(uuid, text, jsonb)',
  'public.api_promote_member_to_admin(uuid, text, jsonb)',
  'public.api_demote_admin_to_member(uuid, text, jsonb)',
  'public.api_promote_admin_to_owner(uuid, text, jsonb)',
];

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('access-management RPC permission migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('access-management RPC permission migration grants only authenticated execute', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  for (const signature of accessManagementRpcSignatures) {
    const pattern = escapedPattern(signature);
    assert.match(migration, new RegExp(`revoke execute on function ${pattern} from public;`));
    assert.match(migration, new RegExp(`revoke execute on function ${pattern} from anon;`));
    assert.match(migration, new RegExp(`revoke execute on function ${pattern} from service_role;`));
    assert.match(migration, new RegExp(`grant execute on function ${pattern} to authenticated;`));
    assert.doesNotMatch(migration, new RegExp(`grant execute on function ${pattern} to (public|anon|service_role);`));
  }
});

test('latest schema check guards the access-management RPC permission surface', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /0117_duplicate_job_creation_guard\.sql/);
  assert.match(schemaCheck, /REQUIRED_AUTHENTICATED_PUBLIC_RPC_SIGNATURES/);
  assert.match(schemaCheck, /service_role_executable_required_public_api/);
  for (const signature of accessManagementRpcSignatures) {
    assert.match(schemaCheck, new RegExp(escapedPattern(signature)));
  }
});
