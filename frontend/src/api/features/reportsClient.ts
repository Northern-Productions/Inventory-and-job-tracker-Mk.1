// Purpose: Reporting API surface.
import type { ReportsSummary, ReportsSummaryFilters } from '../../domain';
import { assertFeatureAccess, requestReadWithFallback } from './sharedClient';

export async function getReportsSummary(filters: ReportsSummaryFilters): Promise<ReportsSummary> {
  assertFeatureAccess('reports', 'read');
  const params = {
    warehouse: filters.warehouse,
    manufacturer: filters.manufacturer,
    film: filters.film,
    width: filters.width,
    from: filters.from,
    to: filters.to
  };

  const summary = await requestReadWithFallback<ReportsSummary>('/reports/summary', params, params);
  return {
    availableFeetByWidth: summary.availableFeetByWidth || [],
    neverCheckedOut: summary.neverCheckedOut || [],
    zeroedByMonth: summary.zeroedByMonth || [],
    zeroedBoxes: summary.zeroedBoxes || [],
    completedJobs: summary.completedJobs || [],
    cancelledJobs: summary.cancelledJobs || []
  };
}
