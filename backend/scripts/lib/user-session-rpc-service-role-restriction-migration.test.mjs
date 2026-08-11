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
  '0108_restrict_user_session_rpc_service_role.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260506140000_restrict_user_session_rpc_service_role.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

const userSessionRpcSignatures = [
  'public.api_get_auth_context(uuid)',
  'public.api_request_username_change(uuid, text, jsonb)',
];

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('user-session RPC service-role restriction migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('user-session RPC service-role restriction keeps only authenticated execute', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  for (const signature of userSessionRpcSignatures) {
    const pattern = escapedPattern(signature);
    assert.match(migration, new RegExp(`revoke execute on function ${pattern} from public;`));
    assert.match(migration, new RegExp(`revoke execute on function ${pattern} from anon;`));
    assert.match(migration, new RegExp(`revoke execute on function ${pattern} from service_role;`));
    assert.match(migration, new RegExp(`grant execute on function ${pattern} to authenticated;`));
    assert.doesNotMatch(migration, new RegExp(`grant execute on function ${pattern} to (public|anon|service_role);`));
  }
});

test('latest schema check points to the user-session RPC service-role restriction', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');


  assert.match(schemaCheck, /0197_film_order_order_scope_semantics\.sql/);

  assert.match(schemaCheck, /service_role_executable_required_public_api/);
  for (const signature of userSessionRpcSignatures) {
    assert.match(schemaCheck, new RegExp(escapedPattern(signature)));
  }
});
