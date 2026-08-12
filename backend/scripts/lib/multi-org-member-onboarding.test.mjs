import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { runTeamMemberOnboarding } from '../../../shared/domain/teamMemberOnboarding.mjs';

const backendMigrationUrl = new URL('../../migrations/0198_multi_org_member_onboarding.sql', import.meta.url);
const supabaseMigrationUrl = new URL(
  '../../../supabase/migrations/20260812100000_multi_org_member_onboarding.sql',
  import.meta.url
);
const accessFoundationMigrationUrl = new URL('../../migrations/0001_supabase_inventory_schema.sql', import.meta.url);
const localAuthServiceUrl = new URL('../../src/app/services/accessAuth.mjs', import.meta.url);
const localTeamServiceUrl = new URL('../../src/app/services/teamUsers.mjs', import.meta.url);
const edgeHandlerUrl = new URL('../../../supabase/functions/_shared/api-handler.ts', import.meta.url);

function createError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function baseFlow(overrides = {}) {
  const calls = [];
  return {
    calls,
    input: {
      email: 'person@example.com',
      name: 'Person Example',
      role: 'admin',
      classify: async () => ({ outcome: 'added_existing', entry: { role: 'admin' } }),
      inviteNewAccount: async () => {
        calls.push('invite');
        return { userId: 'auth-user', email: 'person@example.com' };
      },
      resendPendingInvite: async () => {
        calls.push('resend');
      },
      recordMembership: async (payload) => {
        calls.push(['record', payload]);
        return { outcome: 'invited_new', entry: { role: payload.role } };
      },
      createError,
      ...overrides,
    },
  };
}

test('migration 0198 stays byte-identical across backend and Supabase mirrors', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationUrl, 'utf8'),
    readFile(supabaseMigrationUrl, 'utf8'),
  ]);
  assert.equal(supabaseMigration, backendMigration);
});

test('migration 0198 defines organization selection and tenant-scoped Team authority', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  assert.match(migration, /create table if not exists app\.user_organization_preferences/);
  assert.match(migration, /foreign key \(selected_org_id, user_id\)[\s\S]*references app\.organization_members\(org_id, user_id\)/);
  assert.match(migration, /create or replace function public\.api_select_organization\(p_org_id uuid\)/);
  assert.match(migration, /and m\.status = 'active'[\s\S]*for share/);
  assert.match(migration, /create or replace function app_api\.require_team_manager\(p_org_id uuid\)/);
  assert.match(migration, /a\.feature_area = 'team_management'/);
  assert.match(migration, /select a\.read_enabled and a\.write_enabled/);
  assert.match(migration, /Manage Team Members must be enabled or disabled as one permission/);
  assert.match(migration, /if p_actor_role <> 'admin' then/);
  assert.match(migration, /p_target_user_id = auth\.uid\(\)/);
  assert.match(migration, /p_target_role = 'owner' or p_requested_role = 'owner'/);
  assert.match(migration, /v_target_role is distinct from 'admin'/);
  assert.match(migration, /revoke all on table app\.user_organization_preferences from public, anon, authenticated, service_role/);
  assert.match(migration, /revoke execute on function public\.api_list_memberships\(\) from public, anon, service_role/);
});

test('migration 0198 keeps account identity global and member outcomes discriminated', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');

  for (const value of [
    'added_existing',
    'already_active',
    'disabled_confirmation_required',
    'already_invited',
    'invited_new',
    'invited_existing_unconfirmed',
    'account_unavailable',
  ]) {
    assert.match(migration, new RegExp(`'${value}'`));
  }

  assert.match(migration, /lower\(app_api\.trim_text\(u\.email\)\) = v_email/);
  assert.match(migration, /if v_user_count > 1 then/);
  assert.match(migration, /v_user\.deleted_at is not null/);
  assert.match(migration, /member_row\.user_id <> v_user\.id/);
  assert.match(migration, /perform pg_advisory_xact_lock\(hashtextextended\(v_email, 0\)\)/);
  assert.match(migration, /'ADD_MEMBER'/);
  assert.doesNotMatch(migration, /update auth\.users/);
  assert.doesNotMatch(migration, /delete from auth\.users/);
});

test('migration 0198 makes no-op membership states audit-free and re-enable role-selective', async () => {
  const migration = await readFile(backendMigrationUrl, 'utf8');
  const addStart = migration.indexOf('create or replace function public.api_add_team_member');
  const recordStart = migration.indexOf('create or replace function public.api_record_team_invite');
  const addDefinition = migration.slice(addStart, recordStart);
  const activeReturn = addDefinition.indexOf("'outcome', 'already_active'");
  const audit = addDefinition.indexOf('perform app_api.team_user_audit');

  assert.ok(activeReturn > 0 && audit > activeReturn);
  assert.match(migration, /create or replace function public\.api_reenable_team_user[\s\S]*role = v_role,[\s\S]*status = v_next_status/);
  assert.match(migration, /if v_before\.status = 'active' then[\s\S]*'outcome', 'already_active'/);
  assert.match(migration, /if v_before\.status = 'invited' then[\s\S]*'outcome', 'already_invited'/);
});

test('membership identity and state transitions are serialized for concurrent onboarding', async () => {
  const [foundation, migration] = await Promise.all([
    readFile(accessFoundationMigrationUrl, 'utf8'),
    readFile(backendMigrationUrl, 'utf8'),
  ]);

  assert.match(foundation, /create table if not exists app\.organization_members[\s\S]*primary key \(org_id, user_id\)/);
  assert.match(migration, /perform pg_advisory_xact_lock\(hashtextextended\(v_email, 0\)\)/);
  assert.match(migration, /where m\.org_id = p_org_id[\s\S]*and m\.user_id = v_user\.id[\s\S]*for update/);
  assert.match(migration, /where m\.org_id = p_org_id[\s\S]*and m\.user_id = v_target_user_id[\s\S]*for update/);
});

test('confirmed invite activation is idempotent and resolves pending access state in both runtimes', async () => {
  const [migration, localAuthService] = await Promise.all([
    readFile(backendMigrationUrl, 'utf8'),
    readFile(localAuthServiceUrl, 'utf8'),
  ]);

  for (const source of [migration, localAuthService]) {
    assert.match(source, /with activated as \([\s\S]*m\.status = 'invited'/i);
    assert.match(source, /update app\.access_requests r[\s\S]*status = 'approved'/i);
    assert.match(source, /decided_by_actor = 'accepted invite'/i);
  }
  assert.match(migration, /perform app_api\.activate_confirmed_invite_membership\(null\)/);
});

test('local and Edge runtimes re-invite an existing unconfirmed identity without profile metadata', async () => {
  const [localSource, edgeSource] = await Promise.all([
    readFile(localTeamServiceUrl, 'utf8'),
    readFile(edgeHandlerUrl, 'utf8'),
  ]);

  assert.match(localSource, /resendSupabaseInviteByEmail[\s\S]*\/auth\/v1\/invite/);
  assert.match(localSource, /resendSupabaseInviteByEmail[\s\S]*JSON\.stringify\(\{ email \}\)/);
  assert.doesNotMatch(localSource, /\/auth\/v1\/resend/);
  assert.match(edgeSource, /resendPendingInvite[\s\S]*auth\.admin\.inviteUserByEmail\(nextEmail\)/);
  assert.doesNotMatch(edgeSource, /auth\.resend\(/);
});

test('confirmed existing outcomes do not initialize provider clients', async () => {
  const flow = baseFlow();
  const result = await runTeamMemberOnboarding(flow.input);
  assert.equal(result.outcome, 'added_existing');
  assert.deepEqual(flow.calls, []);
});

test('new accounts are invited once and recorded with selected role', async () => {
  const flow = baseFlow({
    classify: async () => ({ action: 'invite-new-user' }),
  });
  const result = await runTeamMemberOnboarding(flow.input);
  assert.equal(result.outcome, 'invited_new');
  assert.equal(flow.calls[0], 'invite');
  assert.deepEqual(flow.calls[1], [
    'record',
    {
      userId: 'auth-user',
      email: 'person@example.com',
      name: 'Person Example',
      role: 'admin',
      inviteKind: 'new',
    },
  ]);
});

test('unconfirmed accounts reuse identity, resend the invite, and record another org membership', async () => {
  const flow = baseFlow({
    classify: async () => ({ action: 'invite-existing-unconfirmed', userId: 'auth-user' }),
  });
  const result = await runTeamMemberOnboarding(flow.input);
  assert.equal(result.outcome, 'invited_new');
  assert.equal(flow.calls[0], 'resend');
  assert.equal(flow.calls[1][1].inviteKind, 'existing_unconfirmed');
});

test('provider race reclassifies without creating a second Auth identity', async () => {
  let classifyCount = 0;
  const flow = baseFlow({
    classify: async () => {
      classifyCount += 1;
      return classifyCount === 1
        ? { action: 'invite-new-user' }
        : { action: 'invite-existing-unconfirmed', userId: 'auth-user' };
    },
    inviteNewAccount: async () => {
      flow.calls.push('invite-failed');
      throw new Error('private provider detail');
    },
  });
  const result = await runTeamMemberOnboarding(flow.input);
  assert.equal(result.outcome, 'invited_new');
  assert.deepEqual(flow.calls.slice(0, 2), ['invite-failed', 'resend']);
});

test('provider success plus database failure returns a categorical retry boundary', async () => {
  const flow = baseFlow({
    classify: async () => ({ action: 'invite-new-user' }),
    recordMembership: async () => {
      throw new Error('private database detail');
    },
  });

  await assert.rejects(
    () => runTeamMemberOnboarding(flow.input),
    (error) => {
      assert.equal(error.statusCode, 502);
      assert.equal(
        error.message,
        'The account invitation was started, but organization access was not recorded. Retry Add Team Member safely.'
      );
      assert.doesNotMatch(error.message, /private/i);
      return true;
    }
  );
});

test('retry after provider success reuses the Auth identity and records membership once', async () => {
  let authIdentityExists = false;
  let recordAttempts = 0;
  const flow = baseFlow({
    classify: async () => authIdentityExists
      ? { action: 'invite-existing-unconfirmed', userId: 'auth-user' }
      : { action: 'invite-new-user' },
    inviteNewAccount: async () => {
      flow.calls.push('invite');
      authIdentityExists = true;
      return { userId: 'auth-user', email: 'person@example.com' };
    },
    recordMembership: async (payload) => {
      recordAttempts += 1;
      flow.calls.push(['record', payload]);
      if (recordAttempts === 1) {
        throw new Error('private first-attempt detail');
      }
      return { outcome: 'invited_existing_unconfirmed', entry: { role: payload.role } };
    },
  });

  await assert.rejects(() => runTeamMemberOnboarding(flow.input), { statusCode: 502 });
  const retry = await runTeamMemberOnboarding(flow.input);

  assert.equal(retry.outcome, 'invited_existing_unconfirmed');
  assert.equal(flow.calls.filter((entry) => entry === 'invite').length, 1);
  assert.equal(flow.calls.filter((entry) => entry === 'resend').length, 1);
  assert.equal(recordAttempts, 2);
});
