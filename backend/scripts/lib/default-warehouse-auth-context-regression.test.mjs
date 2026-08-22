import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const backendMigrationUrl = new URL(
  '../../migrations/0203_restore_default_warehouse_auth_context.sql',
  import.meta.url
);
const supabaseMigrationUrl = new URL(
  '../../../supabase/migrations/20260822100000_restore_default_warehouse_auth_context.sql',
  import.meta.url
);
const onboardingMigrationUrl = new URL(
  '../../migrations/0198_multi_org_member_onboarding.sql',
  import.meta.url
);
const preferenceMigrationUrl = new URL(
  '../../migrations/0151_user_default_warehouse_preferences.sql',
  import.meta.url
);
const edgeAuthUrl = new URL('../../../supabase/functions/_shared/auth.ts', import.meta.url);
const schemaLatestUrl = new URL('../check-schema-latest.mjs', import.meta.url);

function authContextDefinition(sql) {
  const match = sql.match(
    /create or replace function public\.api_get_auth_context\(p_org_id uuid\)[\s\S]*?\n\$\$;/i
  );
  assert.ok(match, 'Expected one api_get_auth_context definition.');
  return match[0];
}

function removeRestoredDefaultWarehouseContract(definition) {
  return definition
    .replace("\n  v_default_warehouse text := '';", '')
    .replace(/\n\s+'defaultWarehouse', '',/g, '')
    .replace(
      '\n  v_default_warehouse := app_api.get_user_default_warehouse(p_org_id, v_user_id);',
      ''
    )
    .replace("\n    'defaultWarehouse', coalesce(v_default_warehouse, ''),", '');
}

test('migration 0203 stays byte-identical across backend and Supabase mirrors', async () => {
  const [backend, supabase] = await Promise.all([
    readFile(backendMigrationUrl, 'utf8'),
    readFile(supabaseMigrationUrl, 'utf8')
  ]);
  assert.equal(supabase, backend);
});

test('0203 preserves the complete post-0198 auth-context body outside the approved restoration', async () => {
  const [migration, onboarding] = await Promise.all([
    readFile(backendMigrationUrl, 'utf8'),
    readFile(onboardingMigrationUrl, 'utf8')
  ]);
  assert.equal(
    removeRestoredDefaultWarehouseContract(authContextDefinition(migration)),
    authContextDefinition(onboarding)
  );
});

test('0203 restores valid, empty, stale, and organization-scoped warehouse semantics', async () => {
  const [migration, preference] = await Promise.all([
    readFile(backendMigrationUrl, 'utf8'),
    readFile(preferenceMigrationUrl, 'utf8')
  ]);

  assert.match(migration, /v_default_warehouse text := '';/);
  assert.match(
    migration,
    /v_default_warehouse := app_api\.get_user_default_warehouse\(p_org_id, v_user_id\);/
  );
  assert.match(migration, /'defaultWarehouse', coalesce\(v_default_warehouse, ''\)/);
  assert.match(preference, /join app\.warehouses w[\s\S]*w\.org_id = p\.org_id/);
  assert.match(preference, /where p\.org_id = p_org_id[\s\S]*p\.user_id = p_user_id/);
  assert.match(preference, /return coalesce\(v_default, ''\);/);
});

test('0203 keeps pending and denied auth contexts safe and warehouse-empty', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');
  const definition = authContextDefinition(migration);
  assert.equal((definition.match(/'defaultWarehouse', ''/g) || []).length, 2);
  assert.match(definition, /v_request\.status = 'denied'[\s\S]*'defaultWarehouse', ''/);
  assert.match(
    definition,
    /'accessStatus', 'pending'[\s\S]*'pendingRequestCreated', v_inserted_count > 0[\s\S]*'defaultWarehouse', ''/
  );
});

test('0203 retains owner, admin, member, team, selection, and invitation behavior', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');
  const definition = authContextDefinition(migration);

  assert.match(definition, /perform app_api\.activate_confirmed_invite_membership\(p_org_id\);/);
  assert.match(definition, /where m\.org_id = p_org_id[\s\S]*m\.user_id = v_user_id[\s\S]*m\.status = 'active'/);
  assert.match(definition, /if v_role = 'owner' then[\s\S]*'team_management', app_api\.feature_access_json\(true, true\)/);
  assert.match(definition, /elsif v_role = 'admin' then[\s\S]*app_api\.admin_permissions_json\(p_org_id, v_user_id\)/);
  assert.match(definition, /v_permissions := app_api\.member_permissions_for_user_json\(p_org_id, v_user_id\);/);
  assert.match(definition, /'team_management', app_api\.feature_access_json\(false, false\)/);
});

test('0203 is function-only and normalizes api_get_auth_context to authenticated execute', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');
  const afterFunction = migration.slice(migration.indexOf('$$;') + 3).trim();

  assert.equal(
    afterFunction,
    [
      'revoke execute on function public.api_get_auth_context(uuid) from public, anon, service_role;',
      'grant execute on function public.api_get_auth_context(uuid) to authenticated;'
    ].join('\n')
  );
  assert.doesNotMatch(migration, /\b(create|alter|drop)\s+(table|type|policy|trigger|schema)\b/i);
  assert.doesNotMatch(migration, /\b(update|delete from|truncate)\s+auth\./i);
});

test('Edge auth resolution consumes the restored RPC field without a runtime source change', async () => {
  const edgeAuth = await readFile(edgeAuthUrl, 'utf8');
  assert.match(edgeAuth, /"api_get_auth_context"/);
  assert.match(
    edgeAuth,
    /defaultWarehouse: deps\.asTrimmedString\(accessContext\.defaultWarehouse\)\.toUpperCase\(\)/
  );
});

test('schema latest requires migration 0203 and the restored warehouse contract', async () => {
  const schemaLatest = await readFile(schemaLatestUrl, 'utf8');
  assert.match(schemaLatest, /LATEST_MIGRATION = '0203_restore_default_warehouse_auth_context\.sql'/);
  assert.match(
    schemaLatest,
    /v_default_warehouse := app_api\.get_user_default_warehouse\(p_org_id, v_user_id\);/
  );
  assert.match(schemaLatest, /'defaultWarehouse', coalesce\(v_default_warehouse, ''\),/);
});
