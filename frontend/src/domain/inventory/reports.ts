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
