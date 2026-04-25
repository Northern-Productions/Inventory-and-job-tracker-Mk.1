import {
  ADMIN_FEATURE_AREAS,
  DEFAULT_ORG_ID,
  MEMBER_FEATURE_AREAS,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
} from '../../config/runtime.mjs';
import { queryRow, queryRows, withReadClient } from '../../db/client.mjs';
import { HttpError } from '../../lib/http.mjs';
import { authIdentityCache } from '../../state/authIdentityCache.mjs';
import {
  inferAccessModeForRoute as inferAccessModeForRouteContract,
  inferFeatureForRoute as inferFeatureForRouteContract,
  isOwnerOnlyRoute as isOwnerOnlyRouteContract,
} from '../../../../shared/domain/runtimeContract.mjs';
import { asTrimmedString, deriveNameFromEmail, integerOrZero } from '../core/helpers.mjs';

function createDeniedFeaturePermissions() {
  return {
    inventory: { read: false, write: false },
    allocations: { read: false, write: false },
    jobs: { read: false, write: false },
    film_orders: { read: false, write: false },
    activity_history: { read: false, write: false },
    reports: { read: false, write: false },
    access_management: { read: false, write: false },
  };
}

function buildOwnerFeaturePermissions() {
  return {
    inventory: { read: true, write: true },
    allocations: { read: true, write: true },
    jobs: { read: true, write: true },
    film_orders: { read: true, write: true },
    activity_history: { read: true, write: true },
    reports: { read: true, write: true },
    access_management: { read: true, write: true },
  };
}

async function ensureGeneralFeaturePermissions(client, orgId, actor = 'system') {
  await client.query(
    `
      insert into app.general_feature_permissions (
        org_id,
        feature_area,
        read_enabled,
        write_enabled,
        updated_at,
        updated_by
      )
      select
        $1::uuid,
        feature_area.value,
        true,
        true,
        now(),
        $2
      from unnest($3::text[]) as feature_area(value)
      on conflict (org_id, feature_area) do nothing
    `,
    [orgId, asTrimmedString(actor), MEMBER_FEATURE_AREAS]
  );
}

async function ensureOwnerNotificationPreference(client, orgId, ownerUserId, actor = 'system') {
  await client.query(
    `
      insert into app.owner_notification_preferences (
        org_id,
        owner_user_id,
        in_app_opt_in,
        email_opt_in,
        updated_at,
        updated_by
      )
      values ($1::uuid, $2::uuid, true, true, now(), $3)
      on conflict (org_id, owner_user_id) do nothing
    `,
    [orgId, ownerUserId, asTrimmedString(actor)]
  );
}

async function getGeneralFeaturePermissions(client, orgId) {
  await ensureGeneralFeaturePermissions(client, orgId, 'backend-access-read');

  const rows = await queryRows(
    client,
    `
      select feature_area, read_enabled, write_enabled
      from app.general_feature_permissions
      where org_id = $1
    `,
    [orgId]
  );

  const mapped = createDeniedFeaturePermissions();
  MEMBER_FEATURE_AREAS.forEach((feature) => {
    mapped[feature] = { read: true, write: true };
  });
  mapped.access_management = { read: false, write: false };

  rows.forEach((row) => {
    const feature = asTrimmedString(row.feature_area);
    if (!(feature in mapped)) {
      return;
    }
    mapped[feature] = {
      read: Boolean(row.read_enabled),
      write: Boolean(row.write_enabled),
    };
  });

  return mapped;
}

async function getMemberEffectiveFeaturePermissionsForUser(client, orgId, userId) {
  const mapped = await getGeneralFeaturePermissions(client, orgId);
  const rows = await queryRows(
    client,
    `
      select feature_area, read_enabled, write_enabled
      from app.admin_feature_permissions
      where org_id = $1
        and admin_user_id = $2::uuid
        and feature_area = any($3::text[])
    `,
    [orgId, userId, MEMBER_FEATURE_AREAS]
  );

  rows.forEach((row) => {
    const feature = asTrimmedString(row.feature_area);
    if (!MEMBER_FEATURE_AREAS.includes(feature)) {
      return;
    }
    mapped[feature] = {
      read: Boolean(row.read_enabled),
      write: false,
    };
  });

  MEMBER_FEATURE_AREAS.forEach((feature) => {
    mapped[feature] = {
      read: Boolean(mapped[feature]?.read),
      write: false,
    };
  });

  mapped.access_management = { read: false, write: false };
  return mapped;
}

async function ensureAdminFeaturePermissions(client, orgId, adminUserId, copyMemberDefaults, actor = 'system') {
  await ensureGeneralFeaturePermissions(client, orgId, actor);
  const generalPermissions = await getGeneralFeaturePermissions(client, orgId);

  for (const feature of ADMIN_FEATURE_AREAS) {
    let readEnabled = true;
    let writeEnabled = true;

    if (copyMemberDefaults && feature !== 'access_management') {
      readEnabled = Boolean(generalPermissions[feature]?.read ?? true);
      writeEnabled = Boolean(generalPermissions[feature]?.write ?? true);
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
        values ($1::uuid, $2::uuid, $3, $4, $5, now(), $6)
        on conflict (org_id, admin_user_id, feature_area) do nothing
      `,
      [orgId, adminUserId, feature, readEnabled, writeEnabled, asTrimmedString(actor)]
    );
  }
}

async function getAdminFeaturePermissions(client, orgId, adminUserId) {
  await ensureAdminFeaturePermissions(client, orgId, adminUserId, true, 'backend-admin-access-read');
  const generalPermissions = await getGeneralFeaturePermissions(client, orgId);

  const rows = await queryRows(
    client,
    `
      select feature_area, read_enabled, write_enabled
      from app.admin_feature_permissions
      where org_id = $1
        and admin_user_id = $2
    `,
    [orgId, adminUserId]
  );

  const mapped = createDeniedFeaturePermissions();
  MEMBER_FEATURE_AREAS.forEach((feature) => {
    mapped[feature] = {
      read: Boolean(generalPermissions[feature]?.read ?? true),
      write: Boolean(generalPermissions[feature]?.write ?? true),
    };
  });
  mapped.access_management = { read: true, write: true };

  rows.forEach((row) => {
    const feature = asTrimmedString(row.feature_area);
    if (!(feature in mapped)) {
      return;
    }
    mapped[feature] = {
      read: Boolean(row.read_enabled),
      write: Boolean(row.write_enabled),
    };
  });

  return mapped;
}

function inferFeatureForRoute(logicalPath) {
  const normalizedPath = asTrimmedString(logicalPath);
  if (normalizedPath === '/inventory/add' || normalizedPath === '/inventory/scan') {
    return 'inventory';
  }
  if (normalizedPath === '/checkout-history') {
    return 'activity_history';
  }
  return inferFeatureForRouteContract(normalizedPath);
}

function inferAccessModeForRoute(method, logicalPath) {
  return inferAccessModeForRouteContract(method, logicalPath);
}

function isOwnerOnlyRoute(logicalPath) {
  return isOwnerOnlyRouteContract(logicalPath);
}

function isAdminConsoleRoute(logicalPath) {
  return logicalPath.startsWith('/admin/');
}

function mapDatabaseBootstrapError(message) {
  const normalized = asTrimmedString(message).toLowerCase();
  if (
    normalized.includes('relation "app.general_feature_permissions" does not exist') ||
    normalized.includes('relation "app.admin_feature_permissions" does not exist') ||
    normalized.includes('relation "app.access_requests" does not exist') ||
    normalized.includes('relation "app.username_change_requests" does not exist') ||
    normalized.includes('column "requested_by_name" does not exist') ||
    (normalized.includes('function public.api_get_auth_context') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_get_user_feature_permissions') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_update_user_feature_permissions') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.member_permissions_for_user_json') && normalized.includes('does not exist'))
  ) {
    return 'Database migrations 0006, 0007, 0008, 0009, 0027, and 0028 are required. Run 0006_access_control_and_approvals.sql, 0007_access_request_display_name.sql, 0008_username_change_requests.sql, 0009_user_feature_overrides.sql, 0027_member_read_only_permissions.sql, and 0028_member_permission_persistence_guardrails.sql, then retry.';
  }
  if (
    normalized.includes('relation "app.caulk_transfers" does not exist') ||
    (normalized.includes('type "app.caulk_transfer_status"') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_acl_list_caulk_transfers') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_acl_caulk_transfer_receive') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_acl_caulk_transfer_cancel') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_acl_list_caulk_job_allocations_by_job') && normalized.includes('does not exist'))
  ) {
    return 'Database migration 0065_caulk_transfer_assist_and_new_products.sql is required. Apply missing backend migrations through 0065, then retry.';
  }
  if (
    (normalized.includes('function app_api.total_active_allocated_feet_for_box') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.locked_allocated_feet_for_box') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.placeholder_allocated_feet_for_box') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.box_physical_feet_available') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.box_allocatable_now_feet') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.recalculate_physical_box_allocatable_now') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.sync_active_job_schedule_allocations') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.reconcile_auto_shortage_film_orders_for_job') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.reconcile_auto_shortage_film_orders_for_box') && normalized.includes('does not exist'))
  ) {
    return 'Database migration 0068_fix_linked_receipt_post_save_recalc.sql is required. Apply missing backend migrations through 0068, then retry.';
  }
  if (
    normalized.includes('relation "app.allocation_planner_suppressions" does not exist') ||
    (normalized.includes('function public.api_acl_clear_allocation_planner_suppression') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_acl_record_auto_planned_allocation_suppression') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.film_allocation_reserves_capacity') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.film_requirement_planner_signature') && normalized.includes('does not exist'))
  ) {
    return 'Database migrations through 0087_allocation_reserved_availability.sql are required. Apply missing backend and Supabase migrations through 0087, then retry.';
  }
  if (
    (normalized.includes('function public.api_acl_reconcile_auto_planned_allocations') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.reconcile_auto_planned_allocations') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.assert_film_box_allocation_capacity') && normalized.includes('does not exist'))
  ) {
    return 'Database migration 0085_auto_planned_allocation_engine.sql is required. Apply missing backend and Supabase migrations through 0085, then retry.';
  }
  return asTrimmedString(message) || 'Unexpected server error.';
}

function ensureEffectiveRouteAccess(authContext, method, logicalPath) {
  if (logicalPath === '/health' || logicalPath === '/auth/context' || logicalPath === '/profile/username') {
    return;
  }

  if (authContext.accessStatus !== 'approved') {
    throw new HttpError(
      403,
      authContext.accessStatus === 'denied'
        ? 'Your access request was denied. Contact an owner for help.'
        : 'Your account is awaiting approval from an admin or owner.'
    );
  }

  if (isOwnerOnlyRoute(logicalPath) && authContext.role !== 'owner') {
    throw new HttpError(403, 'Owner access is required.');
  }

  if (isAdminConsoleRoute(logicalPath) && !['owner', 'admin'].includes(authContext.role)) {
    throw new HttpError(403, 'Admin or owner access is required.');
  }

  if (authContext.role === 'owner') {
    return;
  }

  const feature = inferFeatureForRoute(logicalPath);
  if (!feature) {
    return;
  }

  const mode = inferAccessModeForRoute(method, logicalPath);
  const featurePermissions = authContext.permissions?.[feature];
  const allowed = mode === 'read' ? featurePermissions?.read : featurePermissions?.write;

  if (!allowed) {
    throw new HttpError(403, 'Feature access denied.');
  }
}

async function fetchAuthIdentity(token) {
  const cached = authIdentityCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.identity;
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  const email = asTrimmedString(payload.email);
  const metadata =
    payload.user_metadata && typeof payload.user_metadata === 'object' ? payload.user_metadata : {};
  const name =
    asTrimmedString(metadata.full_name) ||
    asTrimmedString(metadata.name) ||
    deriveNameFromEmail(email) ||
    'Inventory User';

  const identity = {
    userId: asTrimmedString(payload.id),
    email,
    name,
    token,
  };

  authIdentityCache.set(token, {
    expiresAt: Date.now() + 60_000,
    identity,
  });

  return identity;
}

async function applyAuthenticatedSessionContext(client, authContext) {
  const userId = asTrimmedString(authContext?.userId);
  const email = asTrimmedString(authContext?.email);
  if (!userId || !email) {
    throw new HttpError(401, 'Authenticated session is required.');
  }

  const claims = JSON.stringify({
    sub: userId,
    email,
    role: 'authenticated',
  });

  await client.query(
    `
      select
        set_config('request.jwt.claim.sub', $1::text, true),
        set_config('request.jwt.claim.role', 'authenticated', true),
        set_config('request.jwt.claim.email', $2::text, true),
        set_config('request.jwt.claims', $3::text, true)
    `,
    [userId, email, claims]
  );
}

async function resolveAuthContext(headers, bodyJson) {
  const authorization = headers.authorization || headers.Authorization || '';
  const bodyToken =
    bodyJson && typeof bodyJson.authToken === 'string'
      ? asTrimmedString(bodyJson.authToken)
      : '';
  const token = asTrimmedString(authorization).replace(/^Bearer\s+/i, '') || bodyToken;
  if (!token) {
    throw new HttpError(401, 'Authenticated session is required.');
  }

  const identity = await fetchAuthIdentity(token);
  if (!identity || !identity.userId || !identity.email) {
    throw new HttpError(401, 'Authenticated session is required.');
  }

  return withReadClient(async (client) => {
    const memberships = await queryRows(
      client,
      `
        select org_id, role
        from app.organization_members
        where user_id = $1
        order by created_at asc, org_id asc
      `,
      [identity.userId]
    );

    let orgId = DEFAULT_ORG_ID;
    if (!orgId) {
      if (memberships.length === 1) {
        orgId = memberships[0].org_id;
      } else if (memberships.length > 1) {
        throw new HttpError(
          500,
          'DEFAULT_ORG_ID is required because this user belongs to multiple organizations.'
        );
      } else {
        throw new HttpError(
          500,
          'DEFAULT_ORG_ID must be configured before handling pending approvals.'
        );
      }
    }

    if (memberships.length > 0) {
      const found = memberships.some((entry) => entry.org_id === orgId);
      if (!found && DEFAULT_ORG_ID) {
        throw new HttpError(403, 'DEFAULT_ORG_ID is not assigned to the authenticated user.');
      }
    }

    const actor = `${identity.name} <${identity.email}>`;
    const membership = memberships.find((entry) => entry.org_id === orgId) || null;
    await ensureGeneralFeaturePermissions(client, orgId, actor);

    if (!membership) {
      const existingRequest = await queryRow(
        client,
        `
          select status
          from app.access_requests
          where org_id = $1
            and user_id = $2
        `,
        [orgId, identity.userId]
      );

      if (existingRequest && asTrimmedString(existingRequest.status).toLowerCase() === 'denied') {
        return {
          ...identity,
          orgId,
          actor,
          role: '',
          accessStatus: 'denied',
          permissions: createDeniedFeaturePermissions(),
          isAdminConsoleAllowed: false,
          pendingCount: 0,
          receivesInAppNotifications: false,
          pendingRequestCreated: false,
        };
      }

      const inserted = await client.query(
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
          on conflict (org_id, user_id) do nothing
        `,
        [orgId, identity.userId, identity.email, asTrimmedString(identity.name)]
      );

      return {
        ...identity,
        orgId,
        actor,
        role: '',
        accessStatus: 'pending',
        permissions: createDeniedFeaturePermissions(),
        isAdminConsoleAllowed: false,
        pendingCount: 0,
        receivesInAppNotifications: false,
        pendingRequestCreated: inserted.rowCount > 0,
      };
    }

    const role = asTrimmedString(membership.role).toLowerCase();
    const normalizedRole = role === 'owner' || role === 'admin' ? role : 'member';

    await client.query(
      `
        insert into app.access_requests (
          org_id,
          user_id,
          status,
          requested_at,
          requested_by_email,
          requested_by_name,
          decided_at,
          decided_by_user_id,
          decided_by_actor,
          decision_note
        )
        values ($1::uuid, $2::uuid, 'approved', now(), $3, $4, now(), $2::uuid, 'auto-approved from membership', '')
        on conflict (org_id, user_id) do nothing
      `,
      [orgId, identity.userId, identity.email, asTrimmedString(identity.name)]
    );

    await client.query(
      `
        update app.access_requests
        set
          status = 'approved',
          decided_at = now(),
          decided_by_user_id = $2::uuid,
          decided_by_actor = 'auto-approved from membership',
          decision_note = ''
        where org_id = $1
          and user_id = $2
          and status <> 'approved'
      `,
      [orgId, identity.userId]
    );

    let permissions = createDeniedFeaturePermissions();
    let isAdminConsoleAllowed = false;
    let receivesInAppNotifications = false;

    if (normalizedRole === 'owner') {
      await ensureOwnerNotificationPreference(client, orgId, identity.userId, actor);
      const preference = await queryRow(
        client,
        `
          select in_app_opt_in
          from app.owner_notification_preferences
          where org_id = $1
            and owner_user_id = $2
        `,
        [orgId, identity.userId]
      );
      permissions = buildOwnerFeaturePermissions();
      isAdminConsoleAllowed = true;
      receivesInAppNotifications = preference ? Boolean(preference.in_app_opt_in) : true;
    } else if (normalizedRole === 'admin') {
      await ensureAdminFeaturePermissions(client, orgId, identity.userId, true, actor);
      permissions = await getAdminFeaturePermissions(client, orgId, identity.userId);
      isAdminConsoleAllowed = Boolean(permissions.access_management?.write);
      receivesInAppNotifications = true;
    } else {
      permissions = await getMemberEffectiveFeaturePermissionsForUser(client, orgId, identity.userId);
      isAdminConsoleAllowed = false;
      receivesInAppNotifications = false;
    }

    let pendingCount = 0;
    if (normalizedRole === 'admin' || (normalizedRole === 'owner' && receivesInAppNotifications)) {
      const pendingRow = await queryRow(
        client,
        `
          select count(*)::int as pending_count
          from app.access_requests
          where org_id = $1
            and status = 'pending'
        `,
        [orgId]
      );
      pendingCount = pendingRow ? integerOrZero(pendingRow.pending_count) : 0;
    }

    return {
      ...identity,
      orgId,
      actor,
      role: normalizedRole,
      accessStatus: 'approved',
      permissions,
      isAdminConsoleAllowed,
      pendingCount,
      receivesInAppNotifications,
      pendingRequestCreated: false,
    };
  });
}

export {
  createDeniedFeaturePermissions,
  buildOwnerFeaturePermissions,
  ensureGeneralFeaturePermissions,
  ensureOwnerNotificationPreference,
  getGeneralFeaturePermissions,
  getMemberEffectiveFeaturePermissionsForUser,
  ensureAdminFeaturePermissions,
  getAdminFeaturePermissions,
  inferFeatureForRoute,
  inferAccessModeForRoute,
  isOwnerOnlyRoute,
  isAdminConsoleRoute,
  mapDatabaseBootstrapError,
  ensureEffectiveRouteAccess,
  applyAuthenticatedSessionContext,
  resolveAuthContext,
};
