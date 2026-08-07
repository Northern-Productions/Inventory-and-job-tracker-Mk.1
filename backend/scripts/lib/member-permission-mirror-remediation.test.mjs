import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0188_member_permission_mirror_remediation.sql',
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260714143000_member_permission_mirror_remediation.sql',
);
const historicalMigrationPaths = [
  {
    path: path.join(repoRoot, 'backend', 'migrations', '0027_member_read_only_permissions.sql'),
    sha256: '6b92252f4af8b6d75bc9f4501f9690fdf3eba4329310c87d7ea1827cb5c64285',
  },
  {
    path: path.join(repoRoot, 'backend', 'migrations', '0028_member_permission_persistence_guardrails.sql'),
    sha256: '3c770b0afd607c37f1b97be60dd10d75c4ca986d347182098979203686e24f0b',
  },
];

function normalizeSql(sql) {
  return String(sql || '').replace(/\r\n?/g, '\n');
}

function normalizedDigest(sql) {
  return crypto.createHash('sha256').update(normalizeSql(sql).trim()).digest('hex');
}

function functionBlock(sql, qualifiedName) {
  const start = sql.indexOf(`create or replace function ${qualifiedName}`);
  assert.notEqual(start, -1, `${qualifiedName} must be present.`);
  const next = sql.indexOf('create or replace function ', start + 1);
  return sql.slice(start, next === -1 ? sql.length : next);
}

function stripDollarQuotedBodies(sql) {
  return sql.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$BODY$');
}

test('member permission remediation is exactly mirrored and pins historical migration fingerprints', async () => {
  const [backendMigration, supabaseMigration, schemaLatest, ...historicalMigrations] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs'), 'utf8'),
    ...historicalMigrationPaths.map((entry) => readFile(entry.path, 'utf8')),
  ]);

  assert.equal(normalizeSql(supabaseMigration), normalizeSql(backendMigration));
  assert.match(schemaLatest, /0195_residual_efficiency_scoped_reads\.sql/);
  historicalMigrations.forEach((migration, index) => {
    assert.equal(normalizedDigest(migration), historicalMigrationPaths[index].sha256);
  });
});

test('forward migration performs no migration-time permission data rewrite', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));
  const outsideFunctionBodies = stripDollarQuotedBodies(migration);

  assert.doesNotMatch(
    outsideFunctionBodies,
    /\b(?:insert\s+into|update|delete\s+from)\s+app\.(?:general_feature_permissions|admin_feature_permissions)\b/i,
  );
  assert.doesNotMatch(outsideFunctionBodies, /\b(?:truncate|drop\s+table)\b/i);
});

test('member permission projection keeps per-user reads and forces every write off', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));
  const block = functionBlock(migration, 'app_api.member_permissions_for_user_json');

  for (const feature of ['inventory', 'allocations', 'jobs', 'film_orders', 'activity_history', 'reports']) {
    assert.match(
      block,
      new RegExp(`a\\.admin_user_id = p_user_id and a\\.feature_area = '${feature}'[\\s\\S]*?false`),
    );
  }
  assert.match(block, /'access_management', app_api\.feature_access_json\(false, false\)/);
  assert.doesNotMatch(block, /select a\.write_enabled/);
});

test('effective feature guard enforces active membership, normalized modes, and member read-only access', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));
  const block = functionBlock(migration, 'app_api.require_effective_feature_access');

  assert.match(block, /v_role := app_api\.require_org_member_approved\(p_org_id\);/);
  assert.match(block, /v_feature text := app_api\.trim_text\(p_feature_area\);/);
  assert.match(block, /v_mode text := app_api\.trim_text\(p_access_mode\);/);
  assert.match(block, /if v_role = 'owner' then[\s\S]*?return;/);
  assert.match(block, /if v_role = 'member' then[\s\S]*?if v_mode = 'write' then[\s\S]*?Feature access denied\./);
  assert.match(block, /select coalesce\(a\.read_enabled, g\.read_enabled, false\)/);
  assert.match(block, /a\.admin_user_id = auth\.uid\(\)/);
  assert.match(block, /when v_mode = 'read' then a\.read_enabled[\s\S]*?else a\.write_enabled/);
  assert.doesNotMatch(block, /else coalesce\(a\.write_enabled, g\.write_enabled, false\)/);
});

test('member permission update validates reads and preserves unrelated overrides', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));
  const block = functionBlock(migration, 'public.api_update_user_feature_permissions');

  assert.match(block, /jsonb_typeof\(coalesce\(v_permissions, 'null'::jsonb\)\) <> 'object'/);
  assert.match(block, /if not \(v_permissions \? v_feature\) then[\s\S]*?continue;/);
  assert.match(block, /v_read not in \('true', 'false'\)/);
  assert.match(block, /read_enabled = v_read_enabled/);
  assert.match(block, /write_enabled = false/);
  assert.match(block, /if not v_has_updates then/);
  assert.doesNotMatch(block, /v_write text;/);
  assert.doesNotMatch(block, /write_enabled = case/);
});

test('auth context preserves active lifecycle and resolves members through per-user read-only permissions', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));
  const block = functionBlock(migration, 'public.api_get_auth_context');

  assert.match(block, /perform app_api\.activate_confirmed_invite_membership\(p_org_id\);/);
  assert.match(block, /where m\.org_id = p_org_id[\s\S]*?and m\.user_id = v_user_id[\s\S]*?and m\.status = 'active'/);
  assert.match(block, /if v_role = 'owner' then[\s\S]*?feature_access_json\(true, true\)/);
  assert.match(block, /elsif v_role = 'admin' then[\s\S]*?app_api\.admin_permissions_json/);
  assert.match(block, /v_permissions := app_api\.member_permissions_for_user_json\(p_org_id, v_user_id\);/);
  assert.doesNotMatch(block, /v_permissions := app_api\.member_permissions_json\(p_org_id\);/);
});

test('public remediation RPCs stay authenticated-only without broad table grants', async () => {
  const migration = normalizeSql(await readFile(backendMigrationPath, 'utf8'));

  for (const signature of [
    'public.api_get_auth_context(uuid)',
    'public.api_update_user_feature_permissions(uuid, text, jsonb)',
  ]) {
    const escaped = signature.replace(/[().]/g, '\\$&');
    assert.match(migration, new RegExp(`revoke execute on function ${escaped} from public, anon, service_role;`, 'i'));
    assert.match(migration, new RegExp(`grant execute on function ${escaped} to authenticated;`, 'i'));
  }
  assert.doesNotMatch(migration, /grant\s+(?:select|insert|update|delete|all)\s+on\s+(?:table\s+)?app\./i);
});

test('local backend, Edge ACL, and Admin Access UI retain the same member read-only contract', async () => {
  const [localAuth, edgeAclTest, adminHelpers, permissionDialog] = await Promise.all([
    readFile(path.join(repoRoot, 'backend', 'src', 'app', 'services', 'accessAuth.mjs'), 'utf8'),
    readFile(path.join(repoRoot, 'supabase', 'functions', '_shared', 'acl.test.ts'), 'utf8'),
    readFile(path.join(repoRoot, 'frontend', 'src', 'features', 'access', 'pages', 'admin-access', 'helpers.ts'), 'utf8'),
    readFile(path.join(repoRoot, 'frontend', 'src', 'features', 'access', 'pages', 'admin-access', 'UserPermissionsDialog.tsx'), 'utf8'),
  ]);

  assert.match(localAuth, /getMemberEffectiveFeaturePermissionsForUser[\s\S]*?write: false/);
  assert.match(edgeAclTest, /Edge ACL denies member read-only write attempts/);
  assert.match(adminHelpers, /sanitizeMemberPermissionsForReadOnly[\s\S]*?write: false/);
  assert.match(permissionDialog, /roleDraft === 'admin'[\s\S]*?Write/);
});
