// Purpose: Access-management and permission API surface.
import type {
  AccessRequestEntry,
  AdminPermissionEntry,
  FeatureAccessMap,
  OwnerNotificationPreferences,
  Role,
  UsernameChangeRequestEntry
} from '../../domain';
import { request } from '../http';
import {
  assertFeatureAccess,
  mapAccessRequestEntry,
  mapAdminPermissionEntry,
  mapFeaturePermissions,
  mapUsernameChangeRequestEntry,
  requestReadWithFallback
} from './sharedClient';

export async function listAccessRequests(
  status: '' | 'pending' | 'approved' | 'denied' = ''
): Promise<AccessRequestEntry[]> {
  assertFeatureAccess('access_management', 'read');
  const body = status ? { status } : {};
  const query = status ? { status } : {};
  const data = await requestReadWithFallback<{ entries: unknown[] }>(
    '/admin/access/requests',
    body,
    query
  );
  if (!Array.isArray(data.entries)) {
    return [];
  }

  return data.entries
    .map((entry) => mapAccessRequestEntry(entry))
    .filter((entry): entry is AccessRequestEntry => Boolean(entry));
}

export async function approveAccessRequest(payload: {
  userId: string;
  note?: string;
}): Promise<{ userId: string; status: 'approved'; role: Role }> {
  assertFeatureAccess('access_management', 'write');
  const { data } = await request<{ userId: string; status: 'approved'; role: Role }>(
    'POST',
    '/admin/access/requests/approve',
    { body: payload }
  );
  return data;
}

export async function denyAccessRequest(payload: {
  userId: string;
  note?: string;
}): Promise<{ userId: string; status: 'denied' }> {
  assertFeatureAccess('access_management', 'write');
  const { data } = await request<{ userId: string; status: 'denied' }>(
    'POST',
    '/admin/access/requests/deny',
    { body: payload }
  );
  return data;
}

export async function listUsernameChangeRequests(
  status: '' | 'pending' | 'approved' | 'denied' = ''
): Promise<UsernameChangeRequestEntry[]> {
  assertFeatureAccess('access_management', 'read');
  const body = status ? { status } : {};
  const query = status ? { status } : {};
  const data = await requestReadWithFallback<{ entries: unknown[] }>(
    '/admin/username-requests',
    body,
    query
  );
  if (!Array.isArray(data.entries)) {
    return [];
  }

  return data.entries
    .map((entry) => mapUsernameChangeRequestEntry(entry))
    .filter((entry): entry is UsernameChangeRequestEntry => Boolean(entry));
}

export async function approveUsernameChangeRequest(payload: {
  userId: string;
  note?: string;
}): Promise<{ userId: string; status: 'approved'; username: string }> {
  assertFeatureAccess('access_management', 'write');
  const { data } = await request<{ userId: string; status: 'approved'; username: string }>(
    'POST',
    '/admin/username-requests/approve',
    { body: payload }
  );
  return data;
}

export async function denyUsernameChangeRequest(payload: {
  userId: string;
  note?: string;
}): Promise<{ userId: string; status: 'denied' }> {
  assertFeatureAccess('access_management', 'write');
  const { data } = await request<{ userId: string; status: 'denied' }>(
    'POST',
    '/admin/username-requests/deny',
    { body: payload }
  );
  return data;
}

export async function getMemberFeaturePermissions(): Promise<FeatureAccessMap> {
  assertFeatureAccess('access_management', 'read');
  const data = await requestReadWithFallback<FeatureAccessMap>('/admin/member-permissions', {}, {});
  return mapFeaturePermissions(data);
}

export async function updateMemberFeaturePermissions(payload: {
  permissions: Partial<FeatureAccessMap>;
}): Promise<FeatureAccessMap> {
  assertFeatureAccess('access_management', 'write');
  const { data } = await request<{ permissions: FeatureAccessMap }>(
    'POST',
    '/admin/member-permissions',
    { body: payload }
  );
  return mapFeaturePermissions(data.permissions);
}

export async function getUserFeaturePermissions(userId: string): Promise<FeatureAccessMap> {
  assertFeatureAccess('access_management', 'read');
  const normalizedUserId = String(userId || '').trim();
  const data = await requestReadWithFallback<{ permissions: unknown }>(
    '/admin/user-permissions',
    { userId: normalizedUserId },
    { userId: normalizedUserId }
  );
  return mapFeaturePermissions(data.permissions);
}

export async function updateUserFeaturePermissions(payload: {
  userId: string;
  permissions: Partial<FeatureAccessMap>;
}): Promise<FeatureAccessMap> {
  assertFeatureAccess('access_management', 'write');
  const { data } = await request<{ permissions: unknown }>('POST', '/admin/user-permissions', {
    body: payload
  });
  return mapFeaturePermissions(data.permissions);
}

export async function getAdminFeaturePermissions(): Promise<AdminPermissionEntry[]> {
  const data = await requestReadWithFallback<{ entries: unknown[] }>('/owner/admin-permissions', {}, {});
  if (!Array.isArray(data.entries)) {
    return [];
  }

  return data.entries
    .map((entry) => mapAdminPermissionEntry(entry))
    .filter((entry): entry is AdminPermissionEntry => Boolean(entry));
}

export async function updateAdminFeaturePermissions(payload: {
  userId: string;
  permissions: Partial<FeatureAccessMap>;
}): Promise<FeatureAccessMap> {
  const { data } = await request<{ permissions: FeatureAccessMap }>('POST', '/owner/admin-permissions', {
    body: payload
  });
  return mapFeaturePermissions(data.permissions);
}

export async function promoteMemberToAdmin(payload: {
  userId: string;
}): Promise<{ userId: string; role: 'admin' }> {
  assertFeatureAccess('access_management', 'write');
  const { data } = await request<{ userId: string; role: 'admin' }>(
    'POST',
    '/admin/roles/promote-member-to-admin',
    { body: payload }
  );
  return data;
}

export async function demoteAdminToMember(payload: {
  userId: string;
}): Promise<{ userId: string; role: 'member' }> {
  const { data } = await request<{ userId: string; role: 'member' }>(
    'POST',
    '/owner/roles/demote-admin-to-member',
    { body: payload }
  );
  return data;
}

export async function promoteAdminToOwner(payload: {
  userId: string;
}): Promise<{ userId: string; role: 'owner' }> {
  const { data } = await request<{ userId: string; role: 'owner' }>(
    'POST',
    '/owner/roles/promote-admin-to-owner',
    { body: payload }
  );
  return data;
}

export async function getOwnerNotificationPreferences(): Promise<OwnerNotificationPreferences> {
  const data = await requestReadWithFallback<OwnerNotificationPreferences>(
    '/owner/notification-preferences',
    {},
    {}
  );
  return {
    inAppOptIn: data.inAppOptIn === true || String(data.inAppOptIn).toLowerCase() === 'true',
    emailOptIn: data.emailOptIn === true || String(data.emailOptIn).toLowerCase() === 'true'
  };
}

export async function updateOwnerNotificationPreferences(payload: {
  inAppOptIn: boolean;
  emailOptIn: boolean;
}): Promise<OwnerNotificationPreferences> {
  const { data } = await request<OwnerNotificationPreferences>('POST', '/owner/notification-preferences', {
    body: payload
  });
  return {
    inAppOptIn: data.inAppOptIn === true || String(data.inAppOptIn).toLowerCase() === 'true',
    emailOptIn: data.emailOptIn === true || String(data.emailOptIn).toLowerCase() === 'true'
  };
}
