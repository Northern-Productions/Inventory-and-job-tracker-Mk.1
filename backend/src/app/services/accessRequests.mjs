import { queryRow, queryRows } from '../../db/client.mjs';
import { HttpError } from '../../lib/http.mjs';
import {
  asTrimmedString,
  deriveNameFromEmail,
  formatTimestamp,
  normalizeUsername,
  requireString,
} from '../core/helpers.mjs';
import {
  ensureAdminFeaturePermissions,
  ensureOwnerNotificationPreference,
} from './accessAuth.mjs';

async function listAccessRequests(client, orgId, status) {
  const rows = await queryRows(
    client,
    `
      select
        r.user_id,
        coalesce(nullif(r.requested_by_name, ''), nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', '')) as requested_by_name,
        coalesce(nullif(r.requested_by_email, ''), nullif(u.email, ''), '') as requested_by_email,
        r.status,
        r.requested_at,
        r.decided_at,
        r.decided_by_actor,
        r.decision_note,
        m.role as current_role
      from app.access_requests r
      left join app.organization_members m
        on m.org_id = r.org_id
       and m.user_id = r.user_id
      left join auth.users u
        on u.id = r.user_id
      where r.org_id = $1
        and ($2 = '' or lower(r.status) = lower($2))
      order by r.requested_at asc, r.user_id asc
    `,
    [orgId, asTrimmedString(status).toLowerCase()]
  );

  return rows.map((row) => ({
    userId: asTrimmedString(row.user_id),
    name:
      asTrimmedString(row.requested_by_name) ||
      deriveNameFromEmail(asTrimmedString(row.requested_by_email)) ||
      asTrimmedString(row.user_id),
    email: asTrimmedString(row.requested_by_email),
    status: asTrimmedString(row.status).toLowerCase(),
    requestedAt: formatTimestamp(row.requested_at),
    decidedAt: formatTimestamp(row.decided_at),
    decidedByActor: asTrimmedString(row.decided_by_actor),
    decisionNote: asTrimmedString(row.decision_note),
    currentRole: asTrimmedString(row.current_role).toLowerCase(),
  }));
}

async function approveAccessRequestByUserId(client, orgId, actor, payload, actingUserId) {
  const userId = requireString(payload.userId, 'userId');
  const note = asTrimmedString(payload.note);
  const existing = await queryRow(
    client,
    `
      select role
      from app.organization_members m
      where org_id = $1
        and user_id = $2::uuid
      for update
    `,
    [orgId, userId]
  );

  let role = asTrimmedString(existing?.role).toLowerCase();
  if (!role) {
    await client.query(
      `
        insert into app.organization_members (
          org_id,
          user_id,
          role,
          created_at
        )
        values ($1::uuid, $2::uuid, 'member', now())
        on conflict (org_id, user_id) do nothing
      `,
      [orgId, userId]
    );
    role = 'member';
  }

  await client.query(
    `
      insert into app.access_requests (
        org_id,
        user_id,
        status,
        requested_at,
        requested_by_email,
        decided_at,
        decided_by_user_id,
        decided_by_actor,
        decision_note
      )
      values ($1::uuid, $2::uuid, 'approved', now(), '', now(), $3::uuid, $4, $5)
      on conflict (org_id, user_id) do update
      set
        status = 'approved',
        decided_at = excluded.decided_at,
        decided_by_user_id = excluded.decided_by_user_id,
        decided_by_actor = excluded.decided_by_actor,
        decision_note = excluded.decision_note
    `,
    [orgId, userId, actingUserId, asTrimmedString(actor), note]
  );

  if (role === 'owner') {
    await ensureOwnerNotificationPreference(client, orgId, userId, actor);
  } else if (role === 'admin') {
    await ensureAdminFeaturePermissions(client, orgId, userId, false, actor);
  }

  return {
    userId,
    status: 'approved',
    role,
  };
}

async function denyAccessRequestByUserId(client, orgId, actor, payload, actingUserId) {
  const userId = requireString(payload.userId, 'userId');
  const note = asTrimmedString(payload.note);

  const existing = await queryRow(
    client,
    `
      select role
      from app.organization_members m
      where org_id = $1
        and user_id = $2::uuid
    `,
    [orgId, userId]
  );
  if (existing) {
    throw new HttpError(400, 'This user is already a workspace member and cannot be denied.');
  }

  await client.query(
    `
      insert into app.access_requests (
        org_id,
        user_id,
        status,
        requested_at,
        requested_by_email,
        decided_at,
        decided_by_user_id,
        decided_by_actor,
        decision_note
      )
      values ($1::uuid, $2::uuid, 'denied', now(), '', now(), $3::uuid, $4, $5)
      on conflict (org_id, user_id) do update
      set
        status = 'denied',
        decided_at = excluded.decided_at,
        decided_by_user_id = excluded.decided_by_user_id,
        decided_by_actor = excluded.decided_by_actor,
        decision_note = excluded.decision_note
    `,
    [orgId, userId, actingUserId, asTrimmedString(actor), note]
  );

  return {
    userId,
    status: 'denied',
  };
}

async function setUserDisplayName(client, userId, displayName) {
  const username = normalizeUsername(displayName);
  const result = await client.query(
    `
      update auth.users
      set
        raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object(
          'name', $2,
          'full_name', $2
        ),
        updated_at = now()
      where id = $1::uuid
    `,
    [userId, username]
  );

  if (!result.rowCount) {
    throw new HttpError(404, 'The user profile could not be found.');
  }
}

async function listUsernameChangeRequests(client, orgId, status) {
  const rows = await queryRows(
    client,
    `
      select
        r.user_id,
        coalesce(nullif(a.requested_by_email, ''), nullif(u.email, ''), '') as email,
        coalesce(
          nullif(a.requested_by_name, ''),
          nullif(u.raw_user_meta_data->>'full_name', ''),
          nullif(u.raw_user_meta_data->>'name', '')
        ) as current_name,
        r.requested_name,
        r.status,
        r.requested_at,
        r.decided_at,
        r.decided_by_actor,
        r.decision_note,
        m.role as current_role
      from app.username_change_requests r
      left join app.access_requests a
        on a.org_id = r.org_id
       and a.user_id = r.user_id
      left join app.organization_members m
        on m.org_id = r.org_id
       and m.user_id = r.user_id
      left join auth.users u
        on u.id = r.user_id
      where r.org_id = $1
        and ($2 = '' or lower(r.status) = lower($2))
      order by r.requested_at asc, r.user_id asc
    `,
    [orgId, asTrimmedString(status).toLowerCase()]
  );

  return rows.map((row) => {
    const email = asTrimmedString(row.email);
    return {
      userId: asTrimmedString(row.user_id),
      email,
      currentName: asTrimmedString(row.current_name) || deriveNameFromEmail(email) || asTrimmedString(row.user_id),
      requestedName: asTrimmedString(row.requested_name),
      status: asTrimmedString(row.status).toLowerCase(),
      requestedAt: formatTimestamp(row.requested_at),
      decidedAt: formatTimestamp(row.decided_at),
      decidedByActor: asTrimmedString(row.decided_by_actor),
      decisionNote: asTrimmedString(row.decision_note),
      currentRole: asTrimmedString(row.current_role).toLowerCase(),
    };
  });
}

async function requestUsernameChange(client, orgId, authContext, payload) {
  const requestedName = normalizeUsername(payload.username);
  const actor = asTrimmedString(authContext.actor);
  const role = asTrimmedString(authContext.role).toLowerCase();
  const email = asTrimmedString(authContext.email);
  const userId = requireString(authContext.userId, 'userId');

  if (role === 'owner' || role === 'admin') {
    await setUserDisplayName(client, userId, requestedName);
    await client.query(
      `
        insert into app.access_requests (
          org_id,
          user_id,
          status,
          requested_at,
          requested_by_email,
          requested_by_name
        )
        values ($1::uuid, $2::uuid, 'pending', now(), $3, $4)
        on conflict (org_id, user_id) do update
        set
          requested_by_email = case
            when trim(app.access_requests.requested_by_email) = '' then excluded.requested_by_email
            else app.access_requests.requested_by_email
          end,
          requested_by_name = excluded.requested_by_name
      `,
      [orgId, userId, email, requestedName]
    );

    await client.query(
      `
        insert into app.username_change_requests (
          org_id,
          user_id,
          requested_name,
          status,
          requested_at,
          requested_by_actor,
          decided_at,
          decided_by_user_id,
          decided_by_actor,
          decision_note
        )
        values ($1::uuid, $2::uuid, $3, 'approved', now(), $4, now(), $2::uuid, $4, 'Auto-approved admin/owner self-update.')
        on conflict (org_id, user_id) do update
        set
          requested_name = excluded.requested_name,
          status = 'approved',
          requested_at = excluded.requested_at,
          requested_by_actor = excluded.requested_by_actor,
          decided_at = excluded.decided_at,
          decided_by_user_id = excluded.decided_by_user_id,
          decided_by_actor = excluded.decided_by_actor,
          decision_note = excluded.decision_note
      `,
      [orgId, userId, requestedName, actor]
    );

    return {
      status: 'approved',
      requiresApproval: false,
      username: requestedName,
    };
  }

  await client.query(
    `
      insert into app.username_change_requests (
        org_id,
        user_id,
        requested_name,
        status,
        requested_at,
        requested_by_actor,
        decided_at,
        decided_by_user_id,
        decided_by_actor,
        decision_note
      )
      values ($1::uuid, $2::uuid, $3, 'pending', now(), $4, null, null, '', '')
      on conflict (org_id, user_id) do update
      set
        requested_name = excluded.requested_name,
        status = 'pending',
        requested_at = excluded.requested_at,
        requested_by_actor = excluded.requested_by_actor,
        decided_at = null,
        decided_by_user_id = null,
        decided_by_actor = '',
        decision_note = ''
    `,
    [orgId, userId, requestedName, actor]
  );

  if (email) {
    await client.query(
      `
        update app.access_requests
        set requested_by_email = $3
        where org_id = $1
          and user_id = $2::uuid
          and trim(requested_by_email) = ''
      `,
      [orgId, userId, email]
    );
  }

  return {
    status: 'pending',
    requiresApproval: true,
    username: requestedName,
  };
}

async function approveUsernameChangeRequestByUserId(client, orgId, actor, payload, actingUserId) {
  const userId = requireString(payload.userId, 'userId');
  const note = asTrimmedString(payload.note);

  const requestRow = await queryRow(
    client,
    `
      select requested_name
      from app.username_change_requests
      where org_id = $1
        and user_id = $2::uuid
        and status = 'pending'
      for update
    `,
    [orgId, userId]
  );

  if (!requestRow) {
    throw new HttpError(404, 'No pending username change request was found for this user.');
  }

  const username = normalizeUsername(requestRow.requested_name);
  await setUserDisplayName(client, userId, username);

  const emailRow = await queryRow(
    client,
    `
      select coalesce(nullif(r.requested_by_email, ''), nullif(u.email, ''), '') as email
      from auth.users u
      left join app.access_requests r
        on r.org_id = $1
       and r.user_id = u.id
      where u.id = $2::uuid
    `,
    [orgId, userId]
  );
  const email = asTrimmedString(emailRow?.email);

  await client.query(
    `
      insert into app.access_requests (
        org_id,
        user_id,
        status,
        requested_at,
        requested_by_email,
        requested_by_name
      )
      values ($1::uuid, $2::uuid, 'pending', now(), $3, $4)
      on conflict (org_id, user_id) do update
      set
        requested_by_email = case
          when trim(app.access_requests.requested_by_email) = '' then excluded.requested_by_email
          else app.access_requests.requested_by_email
        end,
        requested_by_name = excluded.requested_by_name
    `,
    [orgId, userId, email, username]
  );

  await client.query(
    `
      update app.username_change_requests
      set
        status = 'approved',
        decided_at = now(),
        decided_by_user_id = $3::uuid,
        decided_by_actor = $4,
        decision_note = $5
      where org_id = $1
        and user_id = $2::uuid
    `,
    [orgId, userId, actingUserId, asTrimmedString(actor), note]
  );

  return {
    userId,
    status: 'approved',
    username,
  };
}

async function denyUsernameChangeRequestByUserId(client, orgId, actor, payload, actingUserId) {
  const userId = requireString(payload.userId, 'userId');
  const note = asTrimmedString(payload.note);
  const result = await client.query(
    `
      update app.username_change_requests
      set
        status = 'denied',
        decided_at = now(),
        decided_by_user_id = $3::uuid,
        decided_by_actor = $4,
        decision_note = $5
      where org_id = $1
        and user_id = $2::uuid
        and status = 'pending'
    `,
    [orgId, userId, actingUserId, asTrimmedString(actor), note]
  );

  if (!result.rowCount) {
    throw new HttpError(404, 'No pending username change request was found for this user.');
  }

  return {
    userId,
    status: 'denied',
  };
}

export {
  listAccessRequests,
  approveAccessRequestByUserId,
  denyAccessRequestByUserId,
  listUsernameChangeRequests,
  requestUsernameChange,
  approveUsernameChangeRequestByUserId,
  denyUsernameChangeRequestByUserId,
};
