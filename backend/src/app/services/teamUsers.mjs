import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from '../../config/runtime.mjs';
import { queryRow } from '../../db/client.mjs';
import { HttpError } from '../../lib/http.mjs';
import { asTrimmedString, requireString } from '../core/helpers.mjs';

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

async function callJsonRpc(client, fnName, params) {
  const row = await queryRow(
    client,
    `select public.${fnName}($1::uuid, $2::jsonb) as result`,
    [params.orgId, JSON.stringify(params.payload || {})]
  );
  return asObject(row?.result);
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

async function inviteSupabaseUserByEmail(email, displayName) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(500, 'Supabase admin invite is not configured.');
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/invite`, {
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
    const message =
      asTrimmedString(payload?.msg) ||
      asTrimmedString(payload?.message) ||
      asTrimmedString(payload?.error_description) ||
      asTrimmedString(payload?.error) ||
      'Supabase invite could not be sent.';
    throw new HttpError(response.status || 502, message);
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

export async function inviteTeamUser(client, orgId, actor, payload) {
  const email = normalizeEmail(payload?.email);
  const role = normalizeRole(payload?.role || 'member');
  const name = asTrimmedString(payload?.name);

  const prepared = await callJsonRpc(client, 'api_prepare_team_invite', {
    orgId,
    payload: {
      email,
      role,
      name,
    },
  });

  const action = asTrimmedString(prepared.action);
  if (action === 'already-member' || action === 'already-invited') {
    return prepared;
  }

  if (action === 'current-disabled') {
    throw new HttpError(409, 'This user is disabled in this organization. Re-enable them instead of inviting again.');
  }

  if (action === 'existing-user-unsupported') {
    throw new HttpError(
      409,
      'This email already has a login. Attaching existing users without a fresh invite is not enabled yet.'
    );
  }

  if (action !== 'invite-new-user') {
    throw new HttpError(400, 'The invite could not be prepared safely.');
  }

  const invited = await inviteSupabaseUserByEmail(email, name);

  try {
    return await callMutationRpc(client, 'api_record_team_invite', {
      orgId,
      actor,
      payload: {
        userId: invited.userId,
        email: invited.email || email,
        name,
        role,
      },
    });
  } catch (error) {
    if (error instanceof HttpError) {
      throw new HttpError(
        error.statusCode,
        `${error.message} Supabase invite may have been sent, but app membership was not recorded. Retry the invite or inspect the target email in Auth before re-sending.`,
        error.warnings,
        error.details
      );
    }
    throw error;
  }
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
    },
  });
}
