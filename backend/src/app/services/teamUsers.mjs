import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from '../../config/runtime.mjs';
import { queryRow } from '../../db/client.mjs';
import { HttpError } from '../../lib/http.mjs';
import { asTrimmedString, requireString } from '../core/helpers.mjs';
import { runTeamMemberOnboarding } from '../../../../shared/domain/teamMemberOnboarding.mjs';

function normalizeEmail(value) {
  return asTrimmedString(value).toLowerCase();
}

function normalizeRole(value) {
  const role = asTrimmedString(value).toLowerCase();
  if (role === 'owner' || role === 'admin' || role === 'member') {
    return role;
  }
  throw new HttpError(400, 'A valid role is required.');
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function callMutationRpc(client, fnName, params) {
  const row = await queryRow(
    client,
    `select public.${fnName}($1::uuid, $2, $3::jsonb) as result`,
    [params.orgId, asTrimmedString(params.actor), JSON.stringify(params.payload || {})]
  );
  return asObject(row?.result);
}

export async function listTeamUsers(client, orgId) {
  const row = await queryRow(client, `select public.api_list_team_users($1::uuid) as entries`, [orgId]);
  return Array.isArray(row?.entries) ? row.entries : [];
}

async function inviteSupabaseUserByEmail(email, displayName, fetchImpl = fetch) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(500, 'Supabase admin invite is not configured.');
  }

  const response = await fetchImpl(`${SUPABASE_URL}/auth/v1/invite`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: JSON.stringify({
      email,
      data: {
        name: displayName,
        full_name: displayName,
      },
    }),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }

  if (!response.ok) {
    throw new HttpError(response.status || 502, 'The account invitation could not be completed.');
  }

  const source = payload?.user && typeof payload.user === 'object' ? asObject(payload.user) : asObject(payload);
  const userId = asTrimmedString(source.id);
  const invitedEmail = normalizeEmail(source.email) || email;

  if (!userId) {
    throw new HttpError(502, 'Supabase invite did not return a user identifier.');
  }

  return {
    userId,
    email: invitedEmail,
  };
}

async function resendSupabaseInviteByEmail(email, fetchImpl = fetch) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(500, 'Supabase account invitation is not configured.');
  }

  const response = await fetchImpl(`${SUPABASE_URL}/auth/v1/invite`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: JSON.stringify({ email }),
  });

  try {
    await response.json();
  } catch (_error) {
    // Provider response details are deliberately not surfaced.
  }

  if (!response.ok) {
    throw new HttpError(response.status || 502, 'The account invitation could not be completed.');
  }
}

async function classifyTeamMember(client, orgId, actor, payload) {
  return callMutationRpc(client, 'api_add_team_member', {
    orgId,
    actor,
    payload,
  });
}

export async function inviteTeamUser(client, orgId, actor, payload, options = {}) {
  const email = normalizeEmail(payload?.email);
  const role = normalizeRole(payload?.role || 'member');
  const name = asTrimmedString(payload?.name);
  const fetchImpl = options.fetchImpl || fetch;

  return runTeamMemberOnboarding({
    email,
    name,
    role,
    classify: (nextPayload) => classifyTeamMember(client, orgId, actor, nextPayload),
    inviteNewAccount: ({ email: nextEmail, name: nextName }) =>
      inviteSupabaseUserByEmail(nextEmail, nextName, fetchImpl),
    resendPendingInvite: (nextEmail) => resendSupabaseInviteByEmail(nextEmail, fetchImpl),
    recordMembership: (nextPayload) => callMutationRpc(client, 'api_record_team_invite', {
      orgId,
      actor,
      payload: nextPayload,
    }),
    createError: (statusCode, message) => new HttpError(statusCode, message),
  });
}

export async function changeTeamUserRole(client, orgId, actor, payload) {
  return callMutationRpc(client, 'api_change_team_user_role', {
    orgId,
    actor,
    payload: {
      userId: requireString(payload?.userId, 'userId'),
      role: normalizeRole(payload?.role),
    },
  });
}

export async function disableTeamUser(client, orgId, actor, payload) {
  return callMutationRpc(client, 'api_disable_team_user', {
    orgId,
    actor,
    payload: {
      userId: requireString(payload?.userId, 'userId'),
    },
  });
}

export async function reenableTeamUser(client, orgId, actor, payload) {
  return callMutationRpc(client, 'api_reenable_team_user', {
    orgId,
    actor,
    payload: {
      userId: requireString(payload?.userId, 'userId'),
      role: normalizeRole(payload?.role),
    },
  });
}
