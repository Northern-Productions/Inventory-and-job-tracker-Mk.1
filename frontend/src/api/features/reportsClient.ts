// Purpose: Reporting API surface.
import type {
  OwnerAssetTotalCostResponse,
  ReportsSummary,
  ReportsSummaryFilters,
  WarehouseAssetAuditFilters,
  WarehouseAssetAuditResponse
} from '../../domain';
import { assertFeatureAccess, assertOwnerAccess, requestReadWithFallback } from './sharedClient';

const WAREHOUSE_ASSET_AUDIT_CONTRACT_ERROR =
  'Warehouse asset audit data is incompatible with this application version.';
const EXACT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNullableSafeDisplayText(value: unknown) {
  return value === null || (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    !EXACT_UUID_PATTERN.test(value.trim())
  );
}

export function assertWarehouseAssetAuditV2Response(
  value: unknown
): asserts value is WarehouseAssetAuditResponse {
  if (!isRecord(value) || value.snapshotVersion !== 2 || !Array.isArray(value.rows)) {
    throw new Error(WAREHOUSE_ASSET_AUDIT_CONTRACT_ERROR);
  }
  if (
    !isRecord(value.metadata) ||
    typeof value.metadata.organizationName !== 'string' ||
    typeof value.metadata.generatedAt !== 'string' ||
    typeof value.metadata.generatedBy !== 'string' ||
    !isRecord(value.appliedFilters) ||
    !Array.isArray(value.appliedFilters.statuses) ||
    !isRecord(value.appliedFilterLabels) ||
    !isRecord(value.filterOptions) ||
    !Array.isArray(value.filterOptions.owners) ||
    !Array.isArray(value.filterOptions.warehouses) ||
    !isRecord(value.totals)
  ) {
    throw new Error(WAREHOUSE_ASSET_AUDIT_CONTRACT_ERROR);
  }

  for (const entry of value.rows) {
    if (!isRecord(entry)) {
      throw new Error(WAREHOUSE_ASSET_AUDIT_CONTRACT_ERROR);
    }
    const status = entry.status;
    const checkedOutJobNumber = entry.checkedOutJobNumber;
    const checkedOutCrewLeaderName = entry.checkedOutCrewLeaderName;
    if (!['IN_STOCK', 'CHECKED_OUT', 'TRANSFER'].includes(String(status))) {
      throw new Error(WAREHOUSE_ASSET_AUDIT_CONTRACT_ERROR);
    }
    if (status === 'CHECKED_OUT') {
      if (
        typeof checkedOutJobNumber !== 'string' ||
        !checkedOutJobNumber.trim() ||
        EXACT_UUID_PATTERN.test(checkedOutJobNumber.trim()) ||
        !isNullableSafeDisplayText(checkedOutCrewLeaderName)
      ) {
        throw new Error(WAREHOUSE_ASSET_AUDIT_CONTRACT_ERROR);
      }
    } else if (checkedOutJobNumber !== null || checkedOutCrewLeaderName !== null) {
      throw new Error(WAREHOUSE_ASSET_AUDIT_CONTRACT_ERROR);
    }
  }
}

export async function getReportsSummary(filters: ReportsSummaryFilters): Promise<ReportsSummary> {
  assertFeatureAccess('reports', 'read');
  const params = {
    warehouse: filters.warehouse,
    manufacturer: filters.manufacturer,
    film: filters.film,
    width: filters.width,
    from: filters.from,
    to: filters.to,
    rankBy: filters.rankBy
  };

  const summary = await requestReadWithFallback<ReportsSummary>('/reports/summary', params, params);
  return {
    availableFeetByWidth: summary.availableFeetByWidth || [],
    neverCheckedOut: summary.neverCheckedOut || [],
    zeroedByMonth: summary.zeroedByMonth || [],
    zeroedBoxes: summary.zeroedBoxes || [],
    completedJobs: summary.completedJobs || [],
    cancelledJobs: summary.cancelledJobs || [],
    mostUsedFilm: summary.mostUsedFilm || [],
    mostUsedFilmOptions: {
      manufacturers: summary.mostUsedFilmOptions?.manufacturers || [],
      filmNames: summary.mostUsedFilmOptions?.filmNames || [],
      widths: summary.mostUsedFilmOptions?.widths || []
    }
  };
}

export async function getOwnerAssetTotalCostReport(
  filters: Pick<ReportsSummaryFilters, 'warehouse'>
): Promise<OwnerAssetTotalCostResponse> {
  assertOwnerAccess();
  const params = {
    warehouse: filters.warehouse
  };
  const summary = await requestReadWithFallback<OwnerAssetTotalCostResponse>(
    '/owner/reports/asset-total-cost',
    params,
    params
  );

  return {
    warehouse: summary.warehouse || '',
    includedBoxCount: Number(summary.includedBoxCount || 0),
    includedFeet: Number(summary.includedFeet || 0),
    pricedBoxCount: Number(summary.pricedBoxCount || 0),
    pricedFeet: Number(summary.pricedFeet || 0),
    unpricedBoxCount: Number(summary.unpricedBoxCount || 0),
    unpricedFeet: Number(summary.unpricedFeet || 0),
    coveragePercentByFeet: Number(summary.coveragePercentByFeet || 0),
    totalAssetCost: Number(summary.totalAssetCost || 0)
  };
}

export async function getWarehouseAssetAuditReport(
  filters: WarehouseAssetAuditFilters,
  options: { signal?: AbortSignal } = {}
): Promise<WarehouseAssetAuditResponse> {
  assertFeatureAccess('reports', 'read');
  const params = {
    warehouse: filters.warehouse,
    ownerCompanyId: filters.ownerCompanyId,
    manufacturer: filters.manufacturer,
    filmName: filters.filmName,
    width: filters.width,
    statuses: filters.statuses,
    q: filters.q
  };
  const response = await requestReadWithFallback<unknown>(
    '/reports/warehouse-asset-audit',
    params,
    params,
    {
      cache: 'no-store',
      ...(options.signal ? { signal: options.signal } : {})
    }
  );
  assertWarehouseAssetAuditV2Response(response);
  return response;
}
