import { FEATURE_AREAS as RUNTIME_FEATURE_AREAS } from './runtimeContract.mjs';

export interface AuthUser {
  email: string;
  hasProfileName: boolean;
  name: string;
  picture: string;
  sub: string;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
  issuedAt: number;
  expiresAt: number;
}

export type AccessStatus = 'approved' | 'pending' | 'denied';
export type Role = 'owner' | 'admin' | 'member' | '';
export type FeatureArea =
  | 'inventory'
  | 'allocations'
  | 'jobs'
  | 'film_orders'
  | 'activity_history'
  | 'reports'
  | 'access_management';
export type FeatureAccessMode = 'read' | 'write';

export interface FeatureAccess {
  read: boolean;
  write: boolean;
}

export type FeatureAccessMap = Record<FeatureArea, FeatureAccess>;

export interface EffectiveAccessContext {
  orgId: string;
  accessStatus: AccessStatus;
  role: Role;
  permissions: FeatureAccessMap;
  isAdminConsoleAllowed: boolean;
  pendingCount: number;
  receivesInAppNotifications: boolean;
  defaultWarehouse: string;
}

export type AccessRequestStatus = 'pending' | 'approved' | 'denied';

export interface AccessRequestEntry {
  userId: string;
  name: string;
  email: string;
  status: AccessRequestStatus;
  requestedAt: string;
  decidedAt: string;
  decidedByActor: string;
  decisionNote: string;
  currentRole: Role;
}

export interface OwnerNotificationPreferences {
  inAppOptIn: boolean;
  emailOptIn: boolean;
}

export interface AdminPermissionEntry {
  userId: string;
  name: string;
  email: string;
  role: 'admin';
  permissions: FeatureAccessMap;
}

export type UsernameChangeRequestStatus = 'pending' | 'approved' | 'denied';

export interface UsernameChangeRequestEntry {
  userId: string;
  email: string;
  currentName: string;
  requestedName: string;
  status: UsernameChangeRequestStatus;
  requestedAt: string;
  decidedAt: string;
  decidedByActor: string;
  decisionNote: string;
  currentRole: Role;
}

export interface UsernameChangeResult {
  status: 'approved' | 'pending';
  requiresApproval: boolean;
  username: string;
}

export interface DefaultWarehouseUpdateResult {
  defaultWarehouse: string;
}

export const FEATURE_AREAS: FeatureArea[] = [...RUNTIME_FEATURE_AREAS] as FeatureArea[];

export function createDefaultFeatureAccessMap(): FeatureAccessMap {
  return {
    inventory: { read: false, write: false },
    allocations: { read: false, write: false },
    jobs: { read: false, write: false },
    film_orders: { read: false, write: false },
    activity_history: { read: false, write: false },
    reports: { read: false, write: false },
    access_management: { read: false, write: false }
  };
}
