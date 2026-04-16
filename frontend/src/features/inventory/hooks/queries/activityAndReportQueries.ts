import { listAudit } from '../../../../api/features/auditClient';
import {
  getOwnerAssetTotalCostReport,
  getReportsSummary
} from '../../../../api/features/reportsClient';
import type { AuditListParams, ReportsSummaryFilters } from '../../../../domain';
import { inventoryKeys } from '../inventoryQueryKeys';
import { useInventoryReadQuery } from './shared';

export function useAuditList(params: AuditListParams) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.activity(params),
    queryFn: () => listAudit(params)
  });
}

export function useReportsSummary(filters: ReportsSummaryFilters) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.reports(filters),
    queryFn: () => getReportsSummary(filters)
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
