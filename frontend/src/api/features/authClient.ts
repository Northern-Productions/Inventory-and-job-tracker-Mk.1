// Purpose: Auth and identity API surface for UI auth flows.
import type { EffectiveAccessContext, HealthResponse, UsernameChangeResult } from '../../domain';
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
      String(data.receivesInAppNotifications).toLowerCase() === 'true'
  };
}

export async function requestUsernameChange(payload: { username: string }): Promise<UsernameChangeResult> {
  const { data } = await request<UsernameChangeResult>('POST', '/profile/username', { body: payload });
  return {
    status: data.status === 'approved' ? 'approved' : 'pending',
    requiresApproval: Boolean(data.requiresApproval),
    username: String(data.username || '').trim()
  };
}
