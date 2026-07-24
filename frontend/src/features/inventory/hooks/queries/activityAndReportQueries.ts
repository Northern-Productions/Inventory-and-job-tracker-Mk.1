import { useQuery } from '@tanstack/react-query';
import { listAudit } from '../../../../api/features/auditClient';
import {
  getOwnerAssetTotalCostReport,
  getReportsSummary,
  getWarehouseAssetAuditReport
} from '../../../../api/features/reportsClient';
import type {
  AuditListParams,
  ReportsSummaryFilters,
  WarehouseAssetAuditFilters
} from '../../../../domain';
import {
  normalizeWarehouseAssetAuditFilters,
  toWarehouseAssetAuditRequestFilters
} from '../../utils/warehouseAssetAuditFilters';
import { inventoryKeys } from '../inventoryQueryKeys';
import { useInventoryReadQuery } from './shared';

export function useAuditList(params: AuditListParams) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.activity(params),
    queryFn: () => listAudit(params)
  });
}

export function useReportsSummary(
  filters: ReportsSummaryFilters,
  options: { enabled?: boolean } = {}
) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.reports(filters),
    queryFn: () => getReportsSummary(filters),
    enabled: options.enabled ?? true
  });
}

export function useOwnerAssetTotalCostReport(
  filters: Pick<ReportsSummaryFilters, 'warehouse'>,
  options: { enabled?: boolean } = {}
) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.ownerAssetTotalCost(filters),
    queryFn: () => getOwnerAssetTotalCostReport(filters),
    enabled: options.enabled ?? true
  });
}

export function useWarehouseAssetAuditReport(
  userId: string,
  orgId: string,
  filters: WarehouseAssetAuditFilters,
  options: { enabled?: boolean } = {}
) {
  const normalizedUserId = userId.trim();
  const normalizedOrgId = orgId.trim();
  const normalizedFilters = normalizeWarehouseAssetAuditFilters(filters);
  return useQuery({
    queryKey: inventoryKeys.warehouseAssetAudit(
      normalizedUserId,
      normalizedOrgId,
      normalizedFilters
    ),
    queryFn: ({ signal }) =>
      getWarehouseAssetAuditReport(
        toWarehouseAssetAuditRequestFilters(normalizedFilters),
        { signal }
      ),
    enabled:
      Boolean(normalizedUserId) &&
      Boolean(normalizedOrgId) &&
      (options.enabled ?? true),
    placeholderData: (previousData, previousQuery) => {
      const previousKey = previousQuery?.queryKey;
      return (
        previousKey?.[3] === normalizedUserId &&
        previousKey?.[4] === normalizedOrgId
      )
        ? previousData
        : undefined;
    }
  });
}
