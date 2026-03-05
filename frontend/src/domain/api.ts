import type {
  AllocationEntry,
  AllocationJobDetail,
  AllocationJobSummary,
  AllocationPreview,
  AuditEntry,
  AvailableFeetByWidthRow,
  Box,
  FilmCatalogEntry,
  FilmOrderEntry,
  JobDetail,
  JobListEntry,
  NeverCheckedOutBoxRow,
  RollHistoryEntry,
  ZeroedTrendRow
} from './inventory';

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
  warnings?: string[];
}

export interface BoxMutationResult {
  box: Box;
  logId: string;
}

export interface UndoMutationResult {
  box: Box | null;
  logId: string;
}

export interface HealthResponse {
  status: 'ok';
  timestamp: string;
  sheets: string[];
}

export interface BoxHistoryResponse {
  entries: AuditEntry[];
}

export interface AuditListResponse {
  entries: AuditEntry[];
}

export interface RollHistoryResponse {
  entries: RollHistoryEntry[];
}

export interface AllocationPreviewResponse extends AllocationPreview {}

export interface ApplyAllocationPlanResult {
  allocations: AllocationEntry[];
  filmOrder: FilmOrderEntry | null;
  remainingUncoveredFeet: number;
}

export interface FilmOrderListResult {
  entries: FilmOrderEntry[];
}

export interface FilmCatalogResponse {
  entries: FilmCatalogEntry[];
}

export interface AllocationJobListResponse {
  entries: AllocationJobSummary[];
}

export interface AllocationJobDetailResponse extends AllocationJobDetail {}

export interface JobListResponse {
  entries: JobListEntry[];
}

export interface JobDetailResponse extends JobDetail {}

export interface ReportsSummary {
  availableFeetByWidth: AvailableFeetByWidthRow[];
  neverCheckedOut: NeverCheckedOutBoxRow[];
  zeroedByMonth: ZeroedTrendRow[];
}
