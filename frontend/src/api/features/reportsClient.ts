// Purpose: Reporting API surface.
import type {
  OwnerAssetTotalCostResponse,
  ReportsSummary,
  ReportsSummaryFilters
} from '../../domain';
import { assertFeatureAccess, assertOwnerAccess, requestReadWithFallback } from './sharedClient';

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
