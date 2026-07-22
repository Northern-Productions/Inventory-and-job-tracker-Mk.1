// Purpose: Shared API client state, guards, and mapping utilities used by feature clients.
import type {
  AccessRequestEntry,
  AccessStatus,
  AdminPermissionEntry,
  BoxDealerEntry,
  CaulkManufacturerEntry,
  CaulkProductEntry,
  CaulkStockEntry,
  CaulkTransferEntry,
  CaulkTransactionEntry,
  EffectiveAccessContext,
  FeatureAccessMap,
  FeatureAccessMode,
  FeatureArea,
  OwnerCompanyEntry,
  OwnershipEventEntry,
  Role,
  TeamUserEntry,
  TeamUserStatus,
  UsernameChangeRequestEntry,
  Warehouse,
  WarehouseEntry
} from '../../domain';
import { createDefaultFeatureAccessMap } from '../../domain';
import { isReadRoute } from '../../domain/runtimeContract.mjs';
import type { OfflineInventoryScope } from '../../lib/offlineInventory';
import { getStoredAuthSession } from '../../lib/storage';
import { APIError, request } from '../http';

const CAULK_FULL_CASE_TUBE_COUNT = 16;
let cachedAccessContext: EffectiveAccessContext | null = null;

export function __resetJobsApiAvailabilityForTests() {
  cachedAccessContext = null;
}

export function setClientAccessContext(context: EffectiveAccessContext | null) {
  cachedAccessContext = context;
}

export function getClientOfflineInventoryScope(): OfflineInventoryScope | null {
  const session = getStoredAuthSession();
  const userId = String(session?.user?.sub || '').trim();
  const orgId = String(cachedAccessContext?.orgId || '').trim();
  if (!userId || !orgId || cachedAccessContext?.accessStatus !== 'approved') {
    return null;
  }

  return { userId, orgId };
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
  if (
    normalized === 'approved' ||
    normalized === 'pending' ||
    normalized === 'denied' ||
    normalized === 'org_selection_required' ||
    normalized === 'no_access'
  ) {
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

function ensureTeamUserStatus(value: unknown): TeamUserStatus {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'invited' || normalized === 'disabled') {
    return normalized;
  }
  return 'active';
}

export function mapTeamUserEntry(value: unknown): TeamUserEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const userId = String(source.userId || '').trim();
  const role = ensureRole(source.role);
  if (!userId || (role !== 'owner' && role !== 'admin' && role !== 'member')) {
    return null;
  }

  return {
    userId,
    name: String(source.name || '').trim(),
    email: String(source.email || '').trim(),
    role,
    status: ensureTeamUserStatus(source.status),
    createdAt: String(source.createdAt || '').trim(),
    invitedAt: String(source.invitedAt || '').trim(),
    disabledAt: String(source.disabledAt || '').trim(),
    updatedAt: String(source.updatedAt || '').trim()
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

export function mapBoxDealerEntry(value: unknown): BoxDealerEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const dealerId = String(source.dealerId || source.id || '').trim();
  if (!dealerId) {
    return null;
  }

  return {
    dealerId,
    name: String(source.name || '').trim(),
    lookupKey: String(source.lookupKey || source.lookup_key || '').trim().toLowerCase(),
    updatedAt: String(source.updatedAt || source.updated_at || '').trim()
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

export function mapOwnerCompanyEntry(value: unknown): OwnerCompanyEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const ownerCompanyId = String(source.ownerCompanyId || source.owner_company_id || source.id || '').trim();
  const code = String(source.code || '').trim().toUpperCase();
  if (!ownerCompanyId || !code) {
    return null;
  }

  return {
    ownerCompanyId,
    code,
    displayName: String(source.displayName || source.display_name || source.name || code).trim() || code,
    lookupKey: String(source.lookupKey || source.lookup_key || code).trim().toLowerCase(),
    isActive: source.isActive === true || String(source.isActive ?? source.is_active).toLowerCase() === 'true',
    createdAt: String(source.createdAt || source.created_at || '').trim(),
    createdBy: String(source.createdBy || source.created_by || '').trim(),
    updatedAt: String(source.updatedAt || source.updated_at || '').trim(),
    updatedBy: String(source.updatedBy || source.updated_by || '').trim(),
    deactivatedAt: String(source.deactivatedAt || source.deactivated_at || '').trim(),
    deactivatedBy: String(source.deactivatedBy || source.deactivated_by || '').trim()
  };
}

export function mapOwnershipEventEntry(value: unknown): OwnershipEventEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const eventId = String(source.eventId || source.event_id || '').trim();
  const resourceType = String(source.resourceType || source.resource_type || '').trim();
  const resourceId = String(source.resourceId || source.resource_id || '').trim();
  if (!eventId || !resourceType || !resourceId) {
    return null;
  }

  return {
    eventId,
    resourceType: resourceType === 'caulk_stock' ? 'caulk_stock' : 'film_box',
    resourceId,
    resourceLabel: String(source.resourceLabel || source.resource_label || '').trim(),
    oldOwnerCompanyId: String(source.oldOwnerCompanyId || source.old_owner_company_id || '').trim(),
    oldOwnerCode: String(source.oldOwnerCode || source.old_owner_code || '').trim(),
    oldOwnerDisplayName: String(source.oldOwnerDisplayName || source.old_owner_display_name || '').trim(),
    newOwnerCompanyId: String(source.newOwnerCompanyId || source.new_owner_company_id || '').trim(),
    newOwnerCode: String(source.newOwnerCode || source.new_owner_code || '').trim(),
    newOwnerDisplayName: String(source.newOwnerDisplayName || source.new_owner_display_name || '').trim(),
    actor: String(source.actor || '').trim(),
    note: String(source.note || '').trim(),
    batchId: String(source.batchId || source.batch_id || '').trim(),
    createdAt: String(source.createdAt || source.created_at || '').trim()
  };
}

export function mapCaulkStockEntry(value: unknown): CaulkStockEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const productId = String(source.productId || '').trim();
  const warehouse = String(source.warehouse || '').trim().toUpperCase();
  const stockId = String(source.stockId || source.stock_id || '').trim();
  if (!productId || !warehouse) {
    return null;
  }

  const tubesOnHand = Number(source.tubesOnHand || 0) || 0;
  const normalizedTubesOnHand = Math.max(0, Math.trunc(tubesOnHand));
  const casesOnHand = Math.floor(normalizedTubesOnHand / CAULK_FULL_CASE_TUBE_COUNT);
  const looseTubes = Math.max(0, normalizedTubesOnHand - (casesOnHand * CAULK_FULL_CASE_TUBE_COUNT));

  return {
    stockId,
    warehouse,
    ownerCompanyId: String(source.ownerCompanyId || source.owner_company_id || '').trim(),
    ownerCompanyCode: String(source.ownerCompanyCode || source.owner_company_code || '').trim().toUpperCase(),
    ownerCompanyDisplayName: String(
      source.ownerCompanyDisplayName || source.owner_company_display_name || source.ownerCompanyCode || source.owner_company_code || ''
    ).trim(),
    ownerCompanyIsActive:
      source.ownerCompanyIsActive === undefined && source.owner_company_is_active === undefined
        ? undefined
        : source.ownerCompanyIsActive === true ||
          String(source.ownerCompanyIsActive ?? source.owner_company_is_active).toLowerCase() === 'true',
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
    ownerCompanyId: String(source.ownerCompanyId || source.owner_company_id || '').trim(),
    ownerCompanyCode: String(source.ownerCompanyCode || source.owner_company_code || '').trim().toUpperCase(),
    ownerCompanyDisplayName: String(
      source.ownerCompanyDisplayName || source.owner_company_display_name || source.ownerCompanyCode || source.owner_company_code || ''
    ).trim(),
    deltaTubes: Number(source.deltaTubes || 0) || 0,
    resultingTubesOnHand: Number(source.resultingTubesOnHand || 0) || 0,
    tubesPerCase: Number(source.tubesPerCase || 0) || 0,
    reason: String(source.reason || '').trim(),
    notes: String(source.notes || '').trim(),
    transferId: String(source.transferId || '').trim(),
    sourceBoxId: String(source.sourceBoxId || '').trim(),
    ...(String(source.jobId || '').trim() ? { jobId: String(source.jobId || '').trim() } : {}),
    ...(String(source.jobNumber || '').trim() ? { jobNumber: String(source.jobNumber || '').trim() } : {}),
    ...(String(source.jobWarehouse || '').trim()
      ? { jobWarehouse: String(source.jobWarehouse || '').trim().toUpperCase() as Warehouse }
      : {}),
    ...(String(source.workScope || '').trim() ? { workScope: String(source.workScope || '').trim() } : {}),
    ...(String(source.sections || '').trim() ? { sections: String(source.sections || '').trim() } : {}),
    createdAt: String(source.createdAt || '').trim(),
    createdBy: String(source.createdBy || '').trim()
  };
}

export function mapCaulkTransferEntry(value: unknown): CaulkTransferEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Record<string, unknown>;
  const transferId = String(source.transferId || '').trim();
  if (!transferId) {
    return null;
  }

  return {
    transferId,
    caulkAllocationId: String(source.caulkAllocationId || '').trim(),
    jobNumber: String(source.jobNumber || '').trim(),
    ...(String(source.jobId || '').trim() ? { jobId: String(source.jobId || '').trim() } : {}),
    jobWarehouse: String(source.jobWarehouse || '').trim().toUpperCase() as Warehouse,
    ...(String(source.workScope || '').trim() ? { workScope: String(source.workScope || '').trim() } : {}),
    ...(String(source.sections || '').trim() ? { sections: String(source.sections || '').trim() } : {}),
    productId: String(source.productId || '').trim(),
    manufacturerId: String(source.manufacturerId || '').trim(),
    manufacturer: String(source.manufacturer || '').trim(),
    productName: String(source.productName || '').trim(),
    productCode: String(source.productCode || '').trim(),
    tubesPerCase: Number(source.tubesPerCase || 0) || 0,
    ownerCompanyId: String(source.ownerCompanyId || source.owner_company_id || '').trim(),
    ownerCompanyCode: String(source.ownerCompanyCode || source.owner_company_code || '').trim().toUpperCase(),
    ownerCompanyDisplayName: String(
      source.ownerCompanyDisplayName || source.owner_company_display_name || source.ownerCompanyCode || source.owner_company_code || ''
    ).trim(),
    sourceWarehouse: String(source.sourceWarehouse || '').trim().toUpperCase() as Warehouse,
    destinationWarehouse: String(source.destinationWarehouse || '').trim().toUpperCase() as Warehouse,
    pendingTubes: Math.max(0, Number(source.pendingTubes || 0) || 0),
    status: String(source.status || '').trim().toUpperCase() as CaulkTransferEntry['status'],
    createdAt: String(source.createdAt || '').trim(),
    createdBy: String(source.createdBy || '').trim(),
    receivedAt: String(source.receivedAt || '').trim(),
    receivedBy: String(source.receivedBy || '').trim(),
    cancelledAt: String(source.cancelledAt || '').trim(),
    cancelledBy: String(source.cancelledBy || '').trim(),
    updatedAt: String(source.updatedAt || '').trim(),
    updatedBy: String(source.updatedBy || '').trim(),
    notes: String(source.notes || '').trim()
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
  query: Record<string, string | number | boolean | string[] | readonly string[] | undefined>,
  options: { cache?: RequestCache } = {}
): Promise<T> {
  if (!isReadRoute(path)) {
    throw new APIError(`Route is not configured as a read route: ${path}`);
  }
  const { data } = await request<T>('GET', path, { query, cache: options.cache });
  return data;
}
