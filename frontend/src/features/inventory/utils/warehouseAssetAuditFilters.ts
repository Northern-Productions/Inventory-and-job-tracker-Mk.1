import type {
  WarehouseAssetAuditFilters,
  WarehouseAssetAuditResponse,
  WarehouseAssetAuditStatus
} from '../../../domain';

export const WAREHOUSE_ASSET_AUDIT_STATUSES: readonly WarehouseAssetAuditStatus[] = [
  'IN_STOCK',
  'CHECKED_OUT',
  'TRANSFER'
];

export interface CanonicalWarehouseAssetAuditFilters {
  warehouse: string;
  ownerCompanyId: string;
  manufacturer: string;
  filmName: string;
  width: number | null;
  statuses: WarehouseAssetAuditStatus[];
  q: string;
}

type WarehouseAssetAuditFilterSource =
  | WarehouseAssetAuditFilters
  | WarehouseAssetAuditResponse['appliedFilters'];

function normalizeOptionalIdentity(value: unknown) {
  return String(value ?? '').trim();
}

function normalizeWidth(value: unknown) {
  const normalized = normalizeOptionalIdentity(value);
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeStatuses(value: unknown): WarehouseAssetAuditStatus[] {
  const requested = new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => String(entry ?? '').trim().toUpperCase())
      .filter((entry): entry is WarehouseAssetAuditStatus =>
        WAREHOUSE_ASSET_AUDIT_STATUSES.includes(entry as WarehouseAssetAuditStatus)
      )
  );
  const statuses = WAREHOUSE_ASSET_AUDIT_STATUSES.filter((status) => requested.has(status));
  return statuses.length ? [...statuses] : [...WAREHOUSE_ASSET_AUDIT_STATUSES];
}

export function normalizeWarehouseAssetAuditFilters(
  filters: WarehouseAssetAuditFilterSource
): CanonicalWarehouseAssetAuditFilters {
  return {
    warehouse: normalizeOptionalIdentity(filters.warehouse).toUpperCase(),
    ownerCompanyId: normalizeOptionalIdentity(filters.ownerCompanyId),
    manufacturer: normalizeOptionalIdentity(filters.manufacturer),
    filmName: normalizeOptionalIdentity(filters.filmName),
    width: normalizeWidth(filters.width),
    statuses: normalizeStatuses(filters.statuses),
    q: normalizeOptionalIdentity(filters.q).replace(/\s+/g, ' ')
  };
}

export function warehouseAssetAuditFiltersEqual(
  left: CanonicalWarehouseAssetAuditFilters,
  right: CanonicalWarehouseAssetAuditFilters
) {
  return (
    left.warehouse === right.warehouse &&
    left.ownerCompanyId === right.ownerCompanyId &&
    left.manufacturer === right.manufacturer &&
    left.filmName === right.filmName &&
    left.width === right.width &&
    left.q === right.q &&
    left.statuses.length === right.statuses.length &&
    left.statuses.every((status, index) => status === right.statuses[index])
  );
}

export function toWarehouseAssetAuditRequestFilters(
  filters: CanonicalWarehouseAssetAuditFilters
): WarehouseAssetAuditFilters {
  return {
    warehouse: filters.warehouse,
    ownerCompanyId: filters.ownerCompanyId,
    manufacturer: filters.manufacturer,
    filmName: filters.filmName,
    width: filters.width === null ? '' : String(filters.width),
    statuses: [...filters.statuses],
    q: filters.q
  };
}
