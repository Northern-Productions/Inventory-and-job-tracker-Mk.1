// Purpose: Shared API client state, guards, and mapping utilities used by feature clients.
import type {
  AccessRequestEntry,
  AccessStatus,
  AdminPermissionEntry,
  CaulkManufacturerEntry,
  CaulkProductEntry,
  CaulkStockEntry,
  CaulkTransactionEntry,
  EffectiveAccessContext,
  FeatureAccessMap,
  FeatureAccessMode,
  FeatureArea,
  Role,
  UsernameChangeRequestEntry,
  WarehouseEntry
} from '../../domain';
import { createDefaultFeatureAccessMap } from '../../domain';
import { isReadRoute } from '../../domain/runtimeContract.mjs';
import { APIError, request } from '../http';

const CAULK_FULL_CASE_TUBE_COUNT = 16;
let cachedAccessContext: EffectiveAccessContext | null = null;

export function __resetJobsApiAvailabilityForTests() {
  cachedAccessContext = null;
}

export function setClientAccessContext(context: EffectiveAccessContext | null) {
  cachedAccessContext = context;
}

export function ensureRole(value: unknown): Role {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'owner' || normalized === 'admin' || normalized === 'member') {
    return normalized;
  }
  return '';
}

export function ensureAccessStatus(value: unknown): AccessStatus {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'approved' || normalized === 'pending' || normalized === 'denied') {
    return normalized;
  }
  return 'pending';
}

export function mapFeaturePermissions(value: unknown): FeatureAccessMap {
  const defaults = createDefaultFeatureAccessMap();
  if (!value || typeof value !== 'object') {
    return defaults;
  }

  const source = value as Record<string, unknown>;
  (Object.keys(defaults) as FeatureArea[]).forEach((feature) => {
    const entry = source[feature];
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const next = entry as Record<string, unknown>;
    defaults[feature] = {
      read: next.read === true || String(next.read).toLowerCase() === 'true',
      write: next.write === true || String(next.write).toLowerCase() === 'true'
    };
  });

  return defaults;
}

export function mapAdminPermissionEntry(value: unknown): AdminPermissionEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const userId = String(source.userId || '').trim();
  if (!userId) {
    return null;
  }

  return {
    userId,
    name: String(source.name || '').trim(),
    email: String(source.email || '').trim(),
    role: 'admin',
    permissions: mapFeaturePermissions(source.permissions)
  };
}

export function mapAccessRequestEntry(value: unknown): AccessRequestEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const userId = String(source.userId || '').trim();
  if (!userId) {
    return null;
  }

  const status = String(source.status || '').trim().toLowerCase();

  return {
    userId,
    name: String(source.name || '').trim(),
    email: String(source.email || '').trim(),
    status: status === 'approved' || status === 'denied' ? status : 'pending',
    requestedAt: String(source.requestedAt || '').trim(),
    decidedAt: String(source.decidedAt || '').trim(),
    decidedByActor: String(source.decidedByActor || '').trim(),
    decisionNote: String(source.decisionNote || '').trim(),
    currentRole: ensureRole(source.currentRole)
  };
}

export function mapUsernameChangeRequestEntry(value: unknown): UsernameChangeRequestEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const userId = String(source.userId || '').trim();
  if (!userId) {
    return null;
  }

  const status = String(source.status || '').trim().toLowerCase();

  return {
    userId,
    email: String(source.email || '').trim(),
    currentName: String(source.currentName || '').trim(),
    requestedName: String(source.requestedName || '').trim(),
    status: status === 'approved' || status === 'denied' ? status : 'pending',
    requestedAt: String(source.requestedAt || '').trim(),
    decidedAt: String(source.decidedAt || '').trim(),
    decidedByActor: String(source.decidedByActor || '').trim(),
    decisionNote: String(source.decisionNote || '').trim(),
    currentRole: ensureRole(source.currentRole)
  };
}

export function mapWarehouseEntry(value: unknown): WarehouseEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const code = String(source.code || '').trim().toUpperCase();
  if (!code) {
    return null;
  }

  return {
    code,
    name: String(source.name || '').trim() || code,
    boxIdPrefix: String(source.boxIdPrefix || '').trim().toUpperCase()
  };
}

export function mapCaulkManufacturerEntry(value: unknown): CaulkManufacturerEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const manufacturerId = String(source.manufacturerId || '').trim();
  if (!manufacturerId) {
    return null;
  }

  return {
    manufacturerId,
    name: String(source.name || '').trim(),
    lookupKey: String(source.lookupKey || '').trim().toLowerCase(),
    isActive: source.isActive === true || String(source.isActive).toLowerCase() === 'true',
    updatedAt: String(source.updatedAt || '').trim()
  };
}

export function mapCaulkProductEntry(value: unknown): CaulkProductEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const productId = String(source.productId || '').trim();
  const manufacturerId = String(source.manufacturerId || '').trim();
  if (!productId || !manufacturerId) {
    return null;
  }

  return {
    productId,
    manufacturerId,
    manufacturer: String(source.manufacturer || '').trim(),
    productName: String(source.productName || '').trim(),
    productCode: String(source.productCode || '').trim(),
    lookupKey: String(source.lookupKey || '').trim().toLowerCase(),
    tubesPerCase: Number(source.tubesPerCase || 0) || 0,
    isActive: source.isActive === true || String(source.isActive).toLowerCase() === 'true',
    notes: String(source.notes || '').trim(),
    updatedAt: String(source.updatedAt || '').trim()
  };
}

export function mapCaulkStockEntry(value: unknown): CaulkStockEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const productId = String(source.productId || '').trim();
  const warehouse = String(source.warehouse || '').trim().toUpperCase();
  if (!productId || !warehouse) {
    return null;
  }

  const tubesOnHand = Number(source.tubesOnHand || 0) || 0;
  const normalizedTubesOnHand = Math.max(0, Math.trunc(tubesOnHand));
  const casesOnHand = Math.floor(normalizedTubesOnHand / CAULK_FULL_CASE_TUBE_COUNT);
  const looseTubes = Math.max(0, normalizedTubesOnHand - (casesOnHand * CAULK_FULL_CASE_TUBE_COUNT));

  return {
    warehouse,
    productId,
    manufacturerId: String(source.manufacturerId || '').trim(),
    manufacturer: String(source.manufacturer || '').trim(),
    productName: String(source.productName || '').trim(),
    productCode: String(source.productCode || '').trim(),
    tubesPerCase: Number(source.tubesPerCase || 0) || 0,
    tubesOnHand: normalizedTubesOnHand,
    casesOnHand,
    looseTubes,
    updatedAt: String(source.updatedAt || '').trim(),
    updatedBy: String(source.updatedBy || '').trim()
  };
}

export function mapCaulkTransactionEntry(value: unknown): CaulkTransactionEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const transactionId = String(source.transactionId || '').trim();
  const productId = String(source.productId || '').trim();
  if (!transactionId || !productId) {
    return null;
  }

  return {
    transactionId,
    productId,
    warehouse: String(source.warehouse || '').trim().toUpperCase(),
    manufacturer: String(source.manufacturer || '').trim(),
    productName: String(source.productName || '').trim(),
    productCode: String(source.productCode || '').trim(),
    action: String(source.action || '').trim().toUpperCase(),
    deltaTubes: Number(source.deltaTubes || 0) || 0,
    resultingTubesOnHand: Number(source.resultingTubesOnHand || 0) || 0,
    tubesPerCase: Number(source.tubesPerCase || 0) || 0,
    reason: String(source.reason || '').trim(),
    notes: String(source.notes || '').trim(),
    transferId: String(source.transferId || '').trim(),
    sourceBoxId: String(source.sourceBoxId || '').trim(),
    createdAt: String(source.createdAt || '').trim(),
    createdBy: String(source.createdBy || '').trim()
  };
}

export function assertOwnerAccess() {
  const context = cachedAccessContext;
  if (!context || context.accessStatus !== 'approved') {
    return;
  }

  if (context.role !== 'owner') {
    throw new APIError('Owner access is required.');
  }
}

export function assertFeatureAccess(feature: FeatureArea, mode: FeatureAccessMode) {
  const context = cachedAccessContext;
  if (!context || context.accessStatus !== 'approved') {
    return;
  }

  if (context.role === 'owner') {
    return;
  }

  const allowed = context.permissions[feature]?.[mode];
  if (!allowed) {
    throw new APIError('You do not have permission to perform this action.');
  }
}

export async function requestReadWithFallback<T>(
  path: string,
  _body: Record<string, unknown>,
  query: Record<string, string | number | boolean | undefined>
): Promise<T> {
  if (!isReadRoute(path)) {
    throw new APIError(`Route is not configured as a read route: ${path}`);
  }
  const { data } = await request<T>('GET', path, { query });
  return data;
}
