import { ADMIN_FEATURE_AREAS, MEMBER_FEATURE_AREAS } from '../../config/runtime.mjs';
import { queryRow, queryRows } from '../../db/client.mjs';
import { HttpError } from '../../lib/http.mjs';
import { asTrimmedString, deriveNameFromEmail, requireString } from '../core/helpers.mjs';
import {
  buildOwnerFeaturePermissions,
  ensureAdminFeaturePermissions,
  ensureGeneralFeaturePermissions,
  ensureOwnerNotificationPreference,
  getAdminFeaturePermissions,
  getGeneralFeaturePermissions,
  getMemberEffectiveFeaturePermissionsForUser,
} from './accessAuth.mjs';

async function updateMemberFeaturePermissionsInternal(client, orgId, actor, payload) {
  await ensureGeneralFeaturePermissions(client, orgId, actor);
  const permissions = payload?.permissions && typeof payload.permissions === 'object' ? payload.permissions : {};

  for (const feature of MEMBER_FEATURE_AREAS) {
    const entry = permissions[feature];
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const readValue = String(entry.read).toLowerCase();
    const writeValue = String(entry.write).toLowerCase();
    await client.query(
      `
        update app.general_feature_permissions
        set
          read_enabled = case when $3 in ('true', 'false') then $3::boolean else read_enabled end,
          write_enabled = case when $4 in ('true', 'false') then $4::boolean else write_enabled end,
          updated_at = now(),
          updated_by = $5
        where org_id = $1
          and feature_area = $2
      `,
      [orgId, feature, readValue, writeValue, asTrimmedString(actor)]
    );
  }

  return getGeneralFeaturePermissions(client, orgId);
}

async function getUserFeaturePermissionsInternal(client, orgId, payload) {
  const userId = requireString(payload.userId, 'userId');
  const target = await queryRow(
    client,
    `
      select role
      from app.organization_members
      where org_id = $1
        and user_id = $2::uuid
    `,
    [orgId, userId]
  );
  if (!target) {
    throw new HttpError(404, 'Target user is not an organization member.');
  }

  const role = asTrimmedString(target.role).toLowerCase();
  if (role === 'owner') {
    return buildOwnerFeaturePermissions();
  }
  if (role === 'admin') {
    return getAdminFeaturePermissions(client, orgId, userId);
  }

  return getMemberEffectiveFeaturePermissionsForUser(client, orgId, userId);
}

async function updateUserFeaturePermissionsInternal(client, orgId, actor, payload) {
  const userId = requireString(payload.userId, 'userId');
  const target = await queryRow(
    client,
    `
      select role
      from app.organization_members
      where org_id = $1
        and user_id = $2::uuid
      for update
    `,
    [orgId, userId]
  );
  if (!target) {
    throw new HttpError(404, 'Target user is not an organization member.');
  }

  const role = asTrimmedString(target.role).toLowerCase();
  if (role !== 'member') {
    throw new HttpError(400, 'Only member accounts can be changed from this page.');
  }

  await ensureGeneralFeaturePermissions(client, orgId, actor);
  const permissions = payload?.permissions && typeof payload.permissions === 'object' ? payload.permissions : {};

  for (const feature of MEMBER_FEATURE_AREAS) {
    const entry = permissions[feature];
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    await client.query(
      `
        insert into app.admin_feature_permissions (
          org_id,
          admin_user_id,
          feature_area,
          read_enabled,
          write_enabled,
          updated_at,
          updated_by
        )
        values (
          $1,
          $2::uuid,
          $3,
          coalesce((select g.read_enabled from app.general_feature_permissions g where g.org_id = $1 and g.feature_area = $3), true),
          false,
          now(),
          $4
        )
        on conflict (org_id, admin_user_id, feature_area) do nothing
      `,
      [orgId, userId, feature, asTrimmedString(actor)]
    );

    const readValue = String(entry.read).toLowerCase();
    await client.query(
      `
        update app.admin_feature_permissions
        set
          read_enabled = case when $4 in ('true', 'false') then $4::boolean else read_enabled end,
          write_enabled = false,
          updated_at = now(),
          updated_by = $5
        where org_id = $1
          and admin_user_id = $2::uuid
          and feature_area = $3
      `,
      [orgId, userId, feature, readValue, asTrimmedString(actor)]
    );
  }

  await client.query(
    `
      delete from app.admin_feature_permissions
      where org_id = $1
        and admin_user_id = $2::uuid
        and feature_area = 'access_management'
    `,
    [orgId, userId]
  );

  return getMemberEffectiveFeaturePermissionsForUser(client, orgId, userId);
}

async function listAdminFeaturePermissions(client, orgId) {
  const admins = await queryRows(
    client,
    `
      select
        m.user_id,
        m.role,
        coalesce(nullif(r.requested_by_name, ''), nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', '')) as requested_by_name,
        coalesce(nullif(r.requested_by_email, ''), nullif(u.email, ''), '') as requested_by_email
      from app.organization_members m
      left join lateral (
        select a.requested_by_name, a.requested_by_email
        from app.access_requests a
        where a.org_id = m.org_id
          and a.user_id = m.user_id
        order by a.requested_at desc
        limit 1
      ) r on true
      left join auth.users u
        on u.id = m.user_id
      where m.org_id = $1
        and m.role = 'admin'
        and m.status = 'active'
      order by m.created_at asc, m.user_id asc
    `,
    [orgId]
  );

  const entries = [];
  for (const admin of admins) {
    const email = asTrimmedString(admin.requested_by_email);
    const name = asTrimmedString(admin.requested_by_name) || deriveNameFromEmail(email) || asTrimmedString(admin.user_id);
    entries.push({
      userId: asTrimmedString(admin.user_id),
      name,
      email,
      role: 'admin',
      permissions: await getAdminFeaturePermissions(client, orgId, asTrimmedString(admin.user_id)),
    });
  }

  return entries;
}

async function updateAdminFeaturePermissionsInternal(client, orgId, actor, payload) {
  const userId = requireString(payload.userId, 'userId');
  const target = await queryRow(
    client,
    `
      select role, status
      from app.organization_members
      where org_id = $1
        and user_id = $2::uuid
      for update
    `,
    [orgId, userId]
  );
  if (
    !target ||
    asTrimmedString(target.role).toLowerCase() !== 'admin' ||
    asTrimmedString(target.status).toLowerCase() !== 'active'
  ) {
    throw new HttpError(400, 'Target user must be an active admin.');
  }

  await ensureAdminFeaturePermissions(client, orgId, userId, true, actor);
  const permissions = payload?.permissions && typeof payload.permissions === 'object' ? payload.permissions : {};
  for (const feature of ADMIN_FEATURE_AREAS) {
    const entry = permissions[feature];
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const readValue = String(entry.read).toLowerCase();
    const writeValue = String(entry.write).toLowerCase();
    if (
      feature === 'team_management' &&
      (!['true', 'false'].includes(readValue) ||
        !['true', 'false'].includes(writeValue) ||
        readValue !== writeValue)
    ) {
      throw new HttpError(400, 'Manage Team Members must be enabled or disabled as one permission.');
    }
    await client.query(
      `
        update app.admin_feature_permissions
        set
          read_enabled = case when $4 in ('true', 'false') then $4::boolean else read_enabled end,
          write_enabled = case when $5 in ('true', 'false') then $5::boolean else write_enabled end,
          updated_at = now(),
          updated_by = $6
        where org_id = $1
          and admin_user_id = $2::uuid
          and feature_area = $3
      `,
      [orgId, userId, feature, readValue, writeValue, asTrimmedString(actor)]
    );
  }

  return getAdminFeaturePermissions(client, orgId, userId);
}

async function promoteMemberToAdminInternal(client, orgId, actor, payload, actingUserId) {
  const userId = requireString(payload.userId, 'userId');
  const target = await queryRow(
    client,
    `
      select role
      from app.organization_members
      where org_id = $1
        and user_id = $2::uuid
      for update
    `,
    [orgId, userId]
  );
  if (!target) {
    throw new HttpError(404, 'Target user is not an organization member.');
  }
  if (asTrimmedString(target.role).toLowerCase() !== 'member') {
    throw new HttpError(400, 'Only member accounts can be promoted to admin.');
  }

  await client.query(
    `
      update app.organization_members
      set role = 'admin'
      where org_id = $1
        and user_id = $2::uuid
    `,
    [orgId, userId]
  );

  await ensureAdminFeaturePermissions(client, orgId, userId, true, actor);
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
      values ($1::uuid, $2::uuid, 'approved', now(), '', now(), $3::uuid, $4, 'Promoted member to admin.')
      on conflict (org_id, user_id) do update
      set
        status = 'approved',
        decided_at = excluded.decided_at,
        decided_by_user_id = excluded.decided_by_user_id,
        decided_by_actor = excluded.decided_by_actor,
        decision_note = excluded.decision_note
    `,
    [orgId, userId, actingUserId, asTrimmedString(actor)]
  );

  return {
    userId,
    role: 'admin',
  };
}

async function demoteAdminToMemberInternal(client, orgId, payload) {
  const userId = requireString(payload.userId, 'userId');
  const target = await queryRow(
    client,
    `
      select role
      from app.organization_members
      where org_id = $1
        and user_id = $2::uuid
      for update
    `,
    [orgId, userId]
  );
  if (!target || asTrimmedString(target.role).toLowerCase() !== 'admin') {
    throw new HttpError(400, 'Target user must be an admin.');
  }

  await client.query(
    `
      update app.organization_members
      set role = 'member'
      where org_id = $1
        and user_id = $2::uuid
    `,
    [orgId, userId]
  );
  await client.query(
    `
      delete from app.admin_feature_permissions
      where org_id = $1
        and admin_user_id = $2::uuid
    `,
    [orgId, userId]
  );

  return {
    userId,
    role: 'member',
  };
}

async function promoteAdminToOwnerInternal(client, orgId, actor, payload) {
  const userId = requireString(payload.userId, 'userId');
  const target = await queryRow(
    client,
    `
      select role
      from app.organization_members
      where org_id = $1
        and user_id = $2::uuid
      for update
    `,
    [orgId, userId]
  );
  if (!target || asTrimmedString(target.role).toLowerCase() !== 'admin') {
    throw new HttpError(400, 'Target user must be an admin.');
  }

  await client.query(
    `
      update app.organization_members
      set role = 'owner'
      where org_id = $1
        and user_id = $2::uuid
    `,
    [orgId, userId]
  );
  await ensureOwnerNotificationPreference(client, orgId, userId, actor);

  return {
    userId,
    role: 'owner',
  };
}

async function getOwnerNotificationPreferencesInternal(client, orgId, ownerUserId) {
  await ensureOwnerNotificationPreference(client, orgId, ownerUserId, 'owner-preference-read');
  const row = await queryRow(
    client,
    `
      select in_app_opt_in, email_opt_in
      from app.owner_notification_preferences
      where org_id = $1
        and owner_user_id = $2::uuid
    `,
    [orgId, ownerUserId]
  );

  return {
    inAppOptIn: row ? Boolean(row.in_app_opt_in) : true,
    emailOptIn: row ? Boolean(row.email_opt_in) : true,
  };
}

async function updateOwnerNotificationPreferencesInternal(client, orgId, ownerUserId, actor, payload) {
  await ensureOwnerNotificationPreference(client, orgId, ownerUserId, actor);

  const inAppValue = String(payload.inAppOptIn).toLowerCase();
  const emailValue = String(payload.emailOptIn).toLowerCase();
  await client.query(
    `
      update app.owner_notification_preferences
      set
        in_app_opt_in = case when $3 in ('true', 'false') then $3::boolean else in_app_opt_in end,
        email_opt_in = case when $4 in ('true', 'false') then $4::boolean else email_opt_in end,
        updated_at = now(),
        updated_by = $5
      where org_id = $1
        and owner_user_id = $2::uuid
    `,
    [orgId, ownerUserId, inAppValue, emailValue, asTrimmedString(actor)]
  );

  return getOwnerNotificationPreferencesInternal(client, orgId, ownerUserId);
}

export {
  updateMemberFeaturePermissionsInternal,
  getUserFeaturePermissionsInternal,
  updateUserFeaturePermissionsInternal,
  listAdminFeaturePermissions,
  updateAdminFeaturePermissionsInternal,
  promoteMemberToAdminInternal,
  demoteAdminToMemberInternal,
  promoteAdminToOwnerInternal,
  getOwnerNotificationPreferencesInternal,
  updateOwnerNotificationPreferencesInternal,
};
