import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

async function readRepoFile(...parts) {
  return fs.readFile(path.join(repoRoot, ...parts), 'utf8');
}

function normalizeSql(sql) {
  return sql.replace(/\r\n/g, '\n');
}

test('service-role staged pickup ACL migration is mirrored and service-role only', async () => {
  const [backendMigrationRaw, supabaseMigrationRaw] = await Promise.all([
    readRepoFile('backend', 'migrations', '0157_service_role_staged_pickup_acl.sql'),
    readRepoFile('supabase', 'migrations', '20260608120000_service_role_staged_pickup_acl.sql'),
  ]);
  const backendMigration = normalizeSql(backendMigrationRaw);
  const supabaseMigration = normalizeSql(supabaseMigrationRaw);

  assert.equal(supabaseMigration, backendMigration);
  assert.match(backendMigration, /create or replace function app_api\.require_effective_feature_access_for_user\(/);
  assert.match(backendMigration, /create or replace function public\.api_acl_jobs_set_staged_pickup_for_user\(/);
  assert.match(
    backendMigration,
    /perform app_api\.require_effective_feature_access_for_user\(p_org_id, p_actor_user_id, 'jobs', 'write'\);/,
  );
  assert.match(backendMigration, /return public\.api_jobs_set_staged_pickup\(p_org_id, p_actor, p_payload\);/);

  assert.match(
    backendMigration,
    /revoke_execute_if_exists\('public\.api_jobs_set_staged_pickup\(uuid, text, jsonb\)', 'authenticated'\)/,
  );
  assert.match(
    backendMigration,
    /revoke_execute_if_exists\('public\.api_jobs_set_staged_pickup\(uuid, text, jsonb\)', 'service_role'\)/,
  );
  assert.match(
    backendMigration,
    /revoke_execute_if_exists\('public\.api_acl_jobs_set_staged_pickup\(uuid, text, jsonb\)', 'authenticated'\)/,
  );
  assert.match(
    backendMigration,
    /revoke_execute_if_exists\('public\.api_acl_jobs_set_staged_pickup\(uuid, text, jsonb\)', 'service_role'\)/,
  );
  assert.match(
    backendMigration,
    /revoke_execute_if_exists\('public\.api_acl_jobs_set_staged_pickup_for_user\(uuid, uuid, text, jsonb\)', 'authenticated'\)/,
  );
  assert.match(
    backendMigration,
    /grant_execute_if_exists\('public\.api_acl_jobs_set_staged_pickup_for_user\(uuid, uuid, text, jsonb\)', 'service_role'\)/,
  );
  assert.doesNotMatch(
    backendMigration,
    /grant_execute_if_exists\('public\.api_acl_jobs_set_staged_pickup_for_user\(uuid, uuid, text, jsonb\)', 'authenticated'\)/,
  );
});

test('service-role staged pickup ACL helper mirrors route-level approval and feature write checks', async () => {
  const migration = normalizeSql(await readRepoFile('backend', 'migrations', '0157_service_role_staged_pickup_acl.sql'));
  const helperBody = migration.slice(
    migration.indexOf('create or replace function app_api.require_effective_feature_access_for_user'),
    migration.indexOf('create or replace function public.api_jobs_set_staged_pickup'),
  );

  assert.match(helperBody, /if p_user_id is null then/);
  assert.match(helperBody, /from app\.organization_members m[\s\S]*m\.org_id = p_org_id[\s\S]*m\.user_id = p_user_id/);
  assert.match(helperBody, /from app\.access_requests r[\s\S]*r\.org_id = p_org_id[\s\S]*r\.user_id = p_user_id/);
  assert.match(helperBody, /coalesce\(v_access_status, ''\) <> 'approved'/);
  assert.match(helperBody, /perform app_api\.ensure_general_feature_permissions\(p_org_id, 'feature-access-check'\);/);
  assert.match(helperBody, /if v_role = 'owner' then[\s\S]*return v_role;/);
  assert.match(helperBody, /if v_role = 'member' then[\s\S]*if v_mode = 'write' then[\s\S]*Feature access denied\./);
  assert.match(helperBody, /from app\.admin_feature_permissions a[\s\S]*a\.admin_user_id = p_user_id/);
  assert.match(helperBody, /when v_mode = 'read' then a\.read_enabled[\s\S]*else a\.write_enabled/);
  assert.match(helperBody, /if not coalesce\(v_allowed, false\) then[\s\S]*Feature access denied\./);
});

test('Edge staged pickup service-role mutation calls the guarded user-scoped RPC', async () => {
  const source = await readRepoFile('supabase', 'functions', '_shared', 'api-handler.ts');
  const body = source.slice(
    source.indexOf('async function setJobStagedPickup'),
    source.indexOf('async function getBoxTransferByBox'),
  );

  assert.match(body, /const serviceClient = requireServiceRoleClientForJobs\(\);/);
  assert.match(body, /rpcOrThrow<Record<string, unknown>>\(serviceClient, "api_acl_jobs_set_staged_pickup_for_user"/);
  assert.match(body, /p_actor_user_id: identity\.userId/);
  assert.match(body, /p_org_id: orgId/);
  assert.match(body, /p_actor: actor/);
  assert.match(body, /isStagedForPickup: nextIsStaged/);
  assert.doesNotMatch(body, /\.from\("jobs"\)[\s\S]*?\.update\(/);
  assert.doesNotMatch(body, /api_acl_jobs_set_staged_pickup"\s*,/);
});
