import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { ClosedJobReportRow, ReportsSummaryFilters } from '../../../../domain';
import { useIsPhoneLayout } from '../../../../hooks/useIsPhoneLayout';
import { searchOfflineBoxes } from '../../../../lib/offlineInventory';
import { useAuth } from '../../../auth/AuthContext';
import { useDefaultWarehouse } from '../../hooks/useDefaultWarehouse';
import {
  useFilmCatalog,
  useOwnerAssetTotalCostReport,
  useReportsSummary
} from '../../hooks/useInventoryQueries';
import { getManufacturerOptionsWithCatalog } from '../../utils/boxHelpers';
import {
  buildZeroedManufacturerOptions,
  filterZeroedBoxes,
  type ZeroedBoxesFilters
} from '../../utils/reportsZeroedFilters';
import { buildAllocationJobRoute } from '../../utils/jobRoutes';
import { normalizeSelectedWidths } from '../../utils/widthFilters';
import { parseWarehouseFilterValue } from '../../utils/warehouseOptions';

export type ReportType =
  | 'never_checked_out'
  | 'zeroed_boxes'
  | 'completed_jobs'
  | 'cancelled_jobs'
  | 'asset_total_cost';

export const BASE_REPORT_TYPE_OPTIONS = [
  { label: 'Received But Never Checked Out', value: 'never_checked_out' },
  { label: 'All Zeroed Boxes', value: 'zeroed_boxes' },
  { label: 'Completed Jobs', value: 'completed_jobs' },
  { label: 'Cancelled Jobs', value: 'cancelled_jobs' }
];

export const OWNER_REPORT_TYPE_OPTIONS = [
  { label: 'Asset Total Cost', value: 'asset_total_cost' },
  ...BASE_REPORT_TYPE_OPTIONS
];

export const REPORT_TYPE_TITLES: Record<ReportType, string> = {
  never_checked_out: 'Received But Never Checked Out',
  zeroed_boxes: 'All Zeroed Boxes',
  completed_jobs: 'Completed Jobs',
  cancelled_jobs: 'Cancelled Jobs',
  asset_total_cost: 'Asset Total Cost'
};

const EMPTY_ZEROED_FILTERS: ZeroedBoxesFilters = {
  manufacturer: '',
  q: '',
  widths: []
};

export function useReportsPageModel() {
  const navigate = useNavigate();
  const auth = useAuth();
  const defaultWarehouse = useDefaultWarehouse();
  const isPhoneLayout = useIsPhoneLayout();
  const [filters, setFilters] = useState<ReportsSummaryFilters>(() => ({
    warehouse: defaultWarehouse
  }));
  const [reportType, setReportType] = useState<ReportType>(
    auth.isOwner ? 'asset_total_cost' : 'never_checked_out'
  );
  const [zeroedFilters, setZeroedFilters] = useState<ZeroedBoxesFilters>(EMPTY_ZEROED_FILTERS);
  const [rememberedCustomWidth, setRememberedCustomWidth] = useState('');

  const reportsQuery = useReportsSummary(filters);
  const ownerAssetTotalCostQuery = useOwnerAssetTotalCostReport(
    { warehouse: filters.warehouse || '' },
    {
      enabled: auth.isOwner && reportType === 'asset_total_cost'
    }
  );
  const filmCatalogQuery = useFilmCatalog();
  const zeroedFallbackQuery = useQuery({
    queryKey: ['reports', 'zeroed-fallback', filters.warehouse || 'ALL'],
    queryFn: () =>
      searchOfflineBoxes({
        warehouse: filters.warehouse || '',
        manufacturer: '',
        q: '',
        status: 'ZEROED',
        film: '',
        showRetired: true
      })
  });
  const knownManufacturerOptions = useMemo(
    () => getManufacturerOptionsWithCatalog(filmCatalogQuery.data),
    [filmCatalogQuery.data]
  );
  const neverCheckedOut = reportsQuery.data?.neverCheckedOut || [];
  const completedJobs = reportsQuery.data?.completedJobs || [];
  const cancelledJobs = reportsQuery.data?.cancelledJobs || [];
  const ownerAssetTotalCost = ownerAssetTotalCostQuery.data;
  const reportTypeOptions = useMemo(
    () => (auth.isOwner ? OWNER_REPORT_TYPE_OPTIONS : BASE_REPORT_TYPE_OPTIONS),
    [auth.isOwner]
  );
  const zeroedBoxes = useMemo(() => {
    const fromSummary = reportsQuery.data?.zeroedBoxes || [];
    if (fromSummary.length) {
      return fromSummary;
    }

    return (zeroedFallbackQuery.data || [])
      .filter((box) => box.status === 'ZEROED' && box.zeroedDate)
      .map((box) => ({
        boxId: box.boxId,
        warehouse: box.warehouse,
        manufacturer: box.manufacturer,
        filmName: box.filmName,
        widthIn: box.widthIn,
        zeroedDate: box.zeroedDate
      }));
  }, [reportsQuery.data?.zeroedBoxes, zeroedFallbackQuery.data]);
  const zeroedManufacturerOptions = useMemo(
    () =>
      buildZeroedManufacturerOptions(
        zeroedBoxes,
        knownManufacturerOptions,
        zeroedFilters.manufacturer
      ),
    [knownManufacturerOptions, zeroedBoxes, zeroedFilters.manufacturer]
  );
  const filteredZeroedBoxes = useMemo(
    () => filterZeroedBoxes(zeroedBoxes, zeroedFilters),
    [zeroedBoxes, zeroedFilters]
  );
  const reportLoading =
    reportType === 'asset_total_cost'
      ? ownerAssetTotalCostQuery.isLoading
      : reportsQuery.isLoading;
  const reportError =
    reportType === 'asset_total_cost'
      ? ownerAssetTotalCostQuery.error
      : reportsQuery.error;
  const showReportLoading =
    reportLoading && !reportsQuery.data && !ownerAssetTotalCostQuery.data;

  useEffect(() => {
    if (!auth.isOwner && reportType === 'asset_total_cost') {
      setReportType('never_checked_out');
    }
  }, [auth.isOwner, reportType]);

  function patchWarehouse(warehouse: string) {
    setFilters({ warehouse: parseWarehouseFilterValue(warehouse) });
  }

  function patchZeroedFilters(next: Partial<ZeroedBoxesFilters>) {
    setZeroedFilters((current) => ({
      ...current,
      ...next,
      widths: normalizeSelectedWidths(next.widths ?? current.widths)
    }));
  }

  return {
    auth,
    isPhoneLayout,
    filters,
    reportType,
    setReportType,
    zeroedFilters,
    rememberedCustomWidth,
    setRememberedCustomWidth,
    neverCheckedOut,
    completedJobs,
    cancelledJobs,
    ownerAssetTotalCost,
    reportTypeOptions,
    zeroedManufacturerOptions,
    filteredZeroedBoxes,
    showReportLoading,
    reportError,
    patchWarehouse,
    patchZeroedFilters,
    openInventoryBox: (boxId: string) => navigate(`/inventory/${encodeURIComponent(boxId)}`),
    openAllocationJob: (job: Pick<ClosedJobReportRow, 'jobId' | 'jobNumber'>) =>
      navigate(buildAllocationJobRoute(job))
  };
}
