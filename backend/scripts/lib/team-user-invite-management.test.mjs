import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  OWNER_ONLY_ROUTES,
  READ_PATHS,
  ROUTE_FEATURE_MAP,
} from '../../../shared/domain/runtimeContract.mjs';
import { queryRow } from '../../src/db/client.mjs';
import { HttpError } from '../../src/lib/http.mjs';
import { shouldUseLocalFallbackRoute } from '../../src/routes/localFallbackRoutes.mjs';
import { changeTeamUserRole } from '../../src/app/services/teamUsers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0184_team_user_invite_management.sql',
);
const backendReenableSafetyMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0185_team_user_reenable_invited_safety.sql',
);
const backendRpcGrantMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0186_team_user_rpc_execute_grants.sql',
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260707102000_team_user_invite_management.sql',
);
const supabaseReenableSafetyMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260707103000_team_user_reenable_invited_safety.sql',
);
const supabaseRpcGrantMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260707104000_team_user_rpc_execute_grants.sql',
);
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const edgeMutationHandlersPath = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'routes',
  'mutationHandlers.ts',
);
const edgeReadHandlersPath = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'routes',
  'readHandlers.ts',
);
const localTeamUsersServicePath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'teamUsers.mjs',
);

const ownerTeamRoutes = [
  '/owner/team/users',
  '/owner/team/invite',
  '/owner/team/change-role',
  '/owner/team/disable',
  '/owner/team/reenable',
];

test('team user invite management migration stays mirrored between backend and Supabase', async () => {
  const [
    backendMigration,
    supabaseMigration,
    backendReenableSafetyMigration,
    supabaseReenableSafetyMigration,
    backendRpcGrantMigration,
    supabaseRpcGrantMigration,
  ] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(backendReenableSafetyMigrationPath, 'utf8'),
    readFile(supabaseReenableSafetyMigrationPath, 'utf8'),
    readFile(backendRpcGrantMigrationPath, 'utf8'),
    readFile(supabaseRpcGrantMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
  assert.equal(supabaseReenableSafetyMigration, backendReenableSafetyMigration);
  assert.equal(supabaseRpcGrantMigration, backendRpcGrantMigration);
});

test('team user invite management migration keeps active membership as the only access-granting state', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /add column if not exists status text not null default 'active'/);
  assert.match(migration, /update app\.organization_members\s+set status = 'active'/);
  assert.match(migration, /status in \('invited', 'active', 'disabled'\)/);
  assert.match(migration, /where member_row\.org_id = target_org_id[\s\S]*and member_row\.status = 'active'/);
  assert.match(migration, /where m\.user_id = auth\.uid\(\)[\s\S]*and m\.status = 'active'/);
  assert.match(migration, /v_remaining_owner_count/);
  assert.match(migration, /status = 'active'/);
  assert.match(migration, /At least one active owner must remain/i);
});

test('team user invite management migration defines owner RPCs and dedicated audit actions', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  for (const functionName of [
    'api_list_team_users',
    'api_prepare_team_invite',
    'api_record_team_invite',
    'api_change_team_user_role',
    'api_disable_team_user',
    'api_reenable_team_user',
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${functionName}\\(`));
  }

  for (const action of ['INVITE_USER', 'CHANGE_USER_ROLE', 'DISABLE_USER', 'REENABLE_USER']) {
    assert.match(migration, new RegExp(action));
  }

  assert.match(migration, /email is already attached to another active or invited organization/i);
  assert.match(migration, /existing-user-unsupported/);
  assert.match(migration, /perform app_api\.team_user_audit/);
});

test('team user re-enable migration keeps unaccepted invites from gaining active access', async () => {
  const migration = await readFile(backendReenableSafetyMigrationPath, 'utf8');

  assert.match(migration, /create or replace function public\.api_reenable_team_user/);
  assert.match(migration, /u\.email_confirmed_at is not null or u\.confirmed_at is not null/);
  assert.match(migration, /then 'active'[\s\S]*else 'invited'/);
  assert.match(migration, /v_access_request_status := case when v_next_status = 'active' then 'approved' else 'pending' end/);
  assert.match(migration, /Invite restored by owner; acceptance is still required\./);
  assert.match(migration, /if v_after\.status = 'active' and v_after\.role = 'owner'/);
});

test('schema latest guard includes team user management objects and RPC grants', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');

  assert.match(schemaLatest, /0196_film_order_effective_list_status\.sql/);
  assert.match(schemaLatest, /app\.team_user_audit_log/);
  assert.match(schemaLatest, /app\.organization_members\.status/);
  for (const signature of [
    'public.api_list_team_users(uuid)',
    'public.api_prepare_team_invite(uuid, jsonb)',
    'public.api_record_team_invite(uuid, text, jsonb)',
    'public.api_change_team_user_role(uuid, text, jsonb)',
    'public.api_disable_team_user(uuid, text, jsonb)',
    'public.api_reenable_team_user(uuid, text, jsonb)',
  ]) {
    assert.match(schemaLatest, new RegExp(signature.replace(/[().]/g, '\\$&')));
  }
});

test('team user RPC grant migration limits public RPC execution to authenticated sessions', async () => {
  const migration = await readFile(backendRpcGrantMigrationPath, 'utf8');

  for (const functionName of [
    'api_list_team_users',
    'api_prepare_team_invite',
    'api_record_team_invite',
    'api_change_team_user_role',
    'api_disable_team_user',
    'api_reenable_team_user',
  ]) {
    assert.match(
      migration,
      new RegExp(`revoke execute on function public\\.${functionName}[^;]+from public, anon, service_role;`, 'i')
    );
    assert.match(
      migration,
      new RegExp(`grant execute on function public\\.${functionName}[^;]+to authenticated;`, 'i')
    );
  }
});

test('team user routes are owner-only access-management routes with local fallback parity', async () => {
  for (const route of ownerTeamRoutes) {
    assert.equal(ROUTE_FEATURE_MAP[route], 'access_management', `${route} should be access-management scoped.`);
    assert.equal(OWNER_ONLY_ROUTES.includes(route), true, `${route} should require owner access.`);
  }

  assert.equal(READ_PATHS.includes('/owner/team/users'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/owner/team/users'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/owner/team/invite'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/owner/team/change-role'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/owner/team/disable'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/owner/team/reenable'), true);

  const [edgeReadHandlers, edgeMutationHandlers] = await Promise.all([
    readFile(edgeReadHandlersPath, 'utf8'),
    readFile(edgeMutationHandlersPath, 'utf8'),
  ]);
  assert.match(edgeReadHandlers, /"\/owner\/team\/users"/);
  assert.match(edgeMutationHandlers, /"\/owner\/team\/invite"/);
  assert.match(edgeMutationHandlers, /api_change_team_user_role/);
  assert.match(edgeMutationHandlers, /api_disable_team_user/);
  assert.match(edgeMutationHandlers, /api_reenable_team_user/);
});

test('local team invite service uses server-side Supabase admin invite and reports recovery boundary', async () => {
  const source = await readFile(localTeamUsersServicePath, 'utf8');

  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(source, /\/auth\/v1\/invite/);
  assert.match(source, /api_prepare_team_invite/);
  assert.match(source, /api_record_team_invite/);
  assert.match(source, /Supabase invite may have been sent, but app membership was not recorded/);
  assert.doesNotMatch(source, /password/i);
});

test('local backend preserves team business denial statuses from app_api.raise_http', async () => {
  const cases = [
    {
      detail: 'status=409',
      message: 'This email is already attached to another active or invited organization.',
      statusCode: 409,
    },
    {
      detail: 'status=404',
      message: 'Target user is not a member of this organization.',
      statusCode: 404,
    },
    {
      detail: 'status=400',
      message: 'At least one active owner must remain in this organization.',
      statusCode: 400,
    },
  ];

  for (const testCase of cases) {
    const client = {
      query: async () => {
        const error = new Error(testCase.message);
        error.detail = testCase.detail;
        throw error;
      },
    };

    await assert.rejects(
      () => queryRow(client, 'select public.some_team_rpc()'),
      (error) => {
        assert.equal(error instanceof HttpError, true);
        assert.equal(error.statusCode, testCase.statusCode);
        assert.equal(error.message, testCase.message);
        return true;
      }
    );
  }
});

test('local team validation remains 400 and unexpected database errors stay unclassified', async () => {
  let queryCount = 0;
  const client = {
    query: async () => {
      queryCount += 1;
      throw new Error('Unexpected low-level failure.');
    },
  };

  await assert.rejects(
    () => changeTeamUserRole(client, '11111111-1111-4111-8111-111111111111', 'owner', {
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'root',
    }),
    (error) => {
      assert.equal(error instanceof HttpError, true);
      assert.equal(error.statusCode, 400);
      assert.equal(error.message, 'A valid role is required.');
      return true;
    }
  );
  assert.equal(queryCount, 0, 'Invalid payload should be rejected before any database mutation RPC.');

  await assert.rejects(
    () => queryRow(client, 'select public.some_team_rpc()'),
    (error) => {
      assert.equal(error instanceof HttpError, false);
      assert.equal(error.message, 'Unexpected low-level failure.');
      return true;
    }
  );
});
