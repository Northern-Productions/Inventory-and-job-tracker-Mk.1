import type { BoxStatus, JobStatus } from './statuses';
import type { Warehouse } from './warehouses';

export interface AvailableFeetByWidthRow {
  widthIn: number;
  totalFeetAvailable: number;
  boxCount: number;
}

export interface NeverCheckedOutBoxRow {
  boxId: string;
  warehouse: Warehouse;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  receivedDate: string;
  status: BoxStatus;
  feetAvailable: number;
}

export interface ZeroedTrendRow {
  month: string;
  zeroedCount: number;
}

export interface ZeroedBoxRow {
  boxId: string;
  warehouse: Warehouse;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  zeroedDate: string;
}

export interface ClosedJobReportRow {
  jobId?: string;
  workScope?: string | null;
  sections?: string | null;
  jobNumber: string;
  warehouse: Warehouse;
  installDate: string;
  crewLeader: string;
  status: JobStatus;
  lifecycleStatus: 'COMPLETED' | 'CANCELLED';
  requiredFeet: number;
  allocatedFeet: number;
  remainingFeet: number;
  closedAt: string;
}

export type MostUsedFilmRankBy = 'actual_used_lf' | 'jobs_using_it';

export interface MostUsedFilmRow {
  rank: number;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  jobsUsingIt: number;
  totalRequiredLf: number;
  averageLfPerJob: number;
  actualUsedLf: number;
}

export interface MostUsedFilmOptions {
  manufacturers: string[];
  filmNames: string[];
  widths: number[];
}

export interface ReportsSummaryFilters {
  warehouse?: Warehouse | '';
  manufacturer?: string;
  film?: string;
  width?: string;
  from?: string;
  to?: string;
  rankBy?: MostUsedFilmRankBy;
}

export interface AssetTotalCostReport {
  warehouse: Warehouse | '';
  includedBoxCount: number;
  includedFeet: number;
  pricedBoxCount: number;
  pricedFeet: number;
  unpricedBoxCount: number;
  unpricedFeet: number;
  coveragePercentByFeet: number;
  totalAssetCost: number;
}

export type WarehouseAssetAuditStatus = 'IN_STOCK' | 'CHECKED_OUT' | 'TRANSFER';
export type WarehouseAssetAuditCostBasis =
  | 'DIRECT_PRICE_PER_LF'
  | 'DERIVED_FROM_PURCHASE_COST'
  | 'MISSING';

export interface WarehouseAssetAuditFilters {
  warehouse?: Warehouse | '';
  ownerCompanyId?: string;
  manufacturer?: string;
  filmName?: string;
  width?: string;
  statuses?: WarehouseAssetAuditStatus[];
  q?: string;
}

export interface WarehouseAssetAuditRow {
  boxId: string;
  ownerCompanyId: string | null;
  ownerCompanyLabel: string;
  ownerCategory: 'ASSIGNED' | 'UNASSIGNED';
  warehouse: Warehouse;
  custodyBasis: 'CURRENT_WAREHOUSE' | 'CHECKOUT_SOURCE' | 'PENDING_TRANSFER_SOURCE';
  pendingTransferDestination: Warehouse | null;
  status: WarehouseAssetAuditStatus;
  statusLabel: string;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  onHandLf: number;
  costBasis: WarehouseAssetAuditCostBasis;
  onHandAssetCostCents: string | null;
}

export interface WarehouseAssetAuditResponse {
  snapshotVersion: 1;
  metadata: {
    organizationName: string;
    generatedAt: string;
    generatedBy: string;
  };
  appliedFilters: {
    warehouse: Warehouse | '';
    ownerCompanyId: string;
    manufacturer: string;
    filmName: string;
    width: number | null;
    statuses: WarehouseAssetAuditStatus[];
    q: string;
  };
  appliedFilterLabels: {
    warehouse: string;
    owner: string;
    manufacturer: string;
    filmName: string;
    width: string;
    statuses: string[];
    search: string;
  };
  filterOptions: {
    warehouses: Array<{ value: Warehouse; label: string }>;
    owners: Array<{ value: string; label: string }>;
    manufacturers: string[];
    filmNames: string[];
    widths: number[];
    statuses: Array<{ value: WarehouseAssetAuditStatus; label: string }>;
  };
  rows: WarehouseAssetAuditRow[];
  totals: {
    matchingBoxes: number;
    totalOnHandLf: number;
    totalKnownOnHandAssetCostCents: string;
    boxesMissingCostBasis: number;
  };
}
