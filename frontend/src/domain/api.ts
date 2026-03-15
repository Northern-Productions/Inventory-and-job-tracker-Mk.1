import type {
  AllocationEntry,
  AllocationJobDetail,
  AllocationJobSummary,
  AllocationPreview,
  AuditEntry,
  CaulkManufacturerEntry,
  CaulkMutationResult,
  CaulkProductEntry,
  CaulkStockEntry,
  CaulkTransactionEntry,
  CaulkTransferResult,
  AvailableFeetByWidthRow,
  Box,
  ClosedJobReportRow,
  FilmCatalogEntry,
  FilmOrderEntry,
  JobDetail,
  JobListEntry,
  NeverCheckedOutBoxRow,
  RollHistoryEntry,
  ZeroedBoxRow,
  ZeroedTrendRow
} from './inventory';
import type {
  AccessRequestEntry,
  AdminPermissionEntry,
  EffectiveAccessContext,
  FeatureAccessMap,
  OwnerNotificationPreferences
} from './auth';

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
  zeroedBoxes: ZeroedBoxRow[];
  completedJobs: ClosedJobReportRow[];
  cancelledJobs: ClosedJobReportRow[];
}

export interface AccessRequestsResponse {
  entries: AccessRequestEntry[];
}

export interface MemberFeaturePermissionsResponse {
  permissions: FeatureAccessMap;
}

export interface OwnerAdminPermissionsResponse {
  entries: AdminPermissionEntry[];
}

export interface AuthContextResponse extends EffectiveAccessContext {}

export interface OwnerNotificationPreferencesResponse extends OwnerNotificationPreferences {}

export interface CaulkManufacturersResponse {
  entries: CaulkManufacturerEntry[];
}

export interface CaulkProductsResponse {
  entries: CaulkProductEntry[];
}

export interface CaulkStockResponse {
  entries: CaulkStockEntry[];
}

export interface CaulkTransactionsResponse {
  entries: CaulkTransactionEntry[];
}

export interface CaulkMutationResponse extends CaulkMutationResult {}

export interface CaulkTransferResponse extends CaulkTransferResult {}
