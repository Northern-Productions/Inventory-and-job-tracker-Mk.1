// Purpose: Auth and identity API surface for UI auth flows.
import type {
  DefaultWarehouseUpdateResult,
  EffectiveAccessContext,
  HealthResponse,
  OrganizationMembershipOption,
  UsernameChangeResult
} from '../../domain';
import { request } from '../http';
import {
  __resetJobsApiAvailabilityForTests,
  ensureAccessStatus,
  ensureRole,
  mapFeaturePermissions,
  setClientAccessContext
} from './sharedClient';

export { __resetJobsApiAvailabilityForTests, setClientAccessContext };

export async function getHealth(): Promise<HealthResponse> {
  const { data } = await request<HealthResponse>('GET', '/health');
  return data;
}

export async function getAuthContext(): Promise<EffectiveAccessContext> {
  const { data } = await request<{
    orgId: string;
    accessStatus: unknown;
    role: unknown;
    permissions: unknown;
    isAdminConsoleAllowed: unknown;
    pendingCount: unknown;
    receivesInAppNotifications: unknown;
    defaultWarehouse: unknown;
    organizations: unknown;
  }>('GET', '/auth/context');

  return {
    orgId: String(data.orgId || '').trim(),
    accessStatus: ensureAccessStatus(data.accessStatus),
    role: ensureRole(data.role),
    permissions: mapFeaturePermissions(data.permissions),
    isAdminConsoleAllowed:
      data.isAdminConsoleAllowed === true ||
      String(data.isAdminConsoleAllowed).toLowerCase() === 'true',
    pendingCount: Number(data.pendingCount || 0) || 0,
    receivesInAppNotifications:
      data.receivesInAppNotifications === true ||
      String(data.receivesInAppNotifications).toLowerCase() === 'true',
    defaultWarehouse: String(data.defaultWarehouse || '').trim().toUpperCase(),
    organizations: mapOrganizationMemberships(data.organizations)
  };
}

function mapOrganizationMemberships(value: unknown): OrganizationMembershipOption[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') {
      return [];
    }
    const entry = raw as Record<string, unknown>;
    const orgId = String(entry.orgId || '').trim();
    const role = ensureRole(entry.role);
    if (!orgId || !role) {
      return [];
    }
    return [{
      orgId,
      name: String(entry.name || '').trim() || 'Organization',
      role,
      selected: entry.selected === true || String(entry.selected).toLowerCase() === 'true'
    }];
  });
}

export async function selectOrganization(orgId: string): Promise<{ orgId: string }> {
  const normalizedOrgId = String(orgId || '').trim();
  if (!normalizedOrgId) {
    throw new Error('Organization is required.');
  }
  const { data } = await request<{ orgId: string }>('POST', '/auth/organization', {
    body: { orgId: normalizedOrgId }
  });
  return { orgId: String(data.orgId || '').trim() };
}

export async function requestUsernameChange(payload: { username: string }): Promise<UsernameChangeResult> {
  const { data } = await request<UsernameChangeResult>('POST', '/profile/username', { body: payload });
  return {
    status: data.status === 'approved' ? 'approved' : 'pending',
    requiresApproval: Boolean(data.requiresApproval),
    username: String(data.username || '').trim()
  };
}

export async function updateDefaultWarehouse(payload: {
  defaultWarehouse: string;
}): Promise<DefaultWarehouseUpdateResult> {
  const { data } = await request<DefaultWarehouseUpdateResult>('POST', '/profile/default-warehouse', {
    body: payload
  });
  return {
    defaultWarehouse: String(data.defaultWarehouse || '').trim().toUpperCase()
  };
}
