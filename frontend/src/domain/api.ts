import type {
  AppAttentionSummary,
} from './app';
import type {
  AllocationEntry,
  AllocationJobDetail,
  AllocationJobSummary,
  AllocationPreview,
  AssetTotalCostReport,
  AuditEntry,
  CaulkManufacturerEntry,
  CaulkJobAllocationMutationResult,
  CaulkJobCheckoutMutationResult,
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
  RemoveCaulkJobAllocationResult,
  JobListEntry,
  MostUsedFilmOptions,
  MostUsedFilmRow,
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
  code?: string;
  jobNumber?: string;
  candidates?: JobNumberAmbiguityCandidate[];
}

export interface JobNumberAmbiguityCandidate {
  jobId: string;
  jobNumber: string;
  routeTarget: string;
  workScope?: string | null;
  sections?: string | null;
  warehouse?: string;
  installDate?: string;
  crewLeader?: string;
  status?: string;
  lifecycleStatus?: string;
  updatedAt?: string;
}

export interface BoxMutationResult {
  box: Box;
  logId: string;
  jobId?: string;
  jobNumber?: string;
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
  mostUsedFilm: MostUsedFilmRow[];
  mostUsedFilmOptions: MostUsedFilmOptions;
}

export interface OwnerAssetTotalCostResponse extends AssetTotalCostReport {}

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

export interface AppAttentionSummaryResponse extends AppAttentionSummary {}

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

export interface CaulkJobAllocationMutationResponse extends CaulkJobAllocationMutationResult {}

export interface CaulkJobCheckoutMutationResponse extends CaulkJobCheckoutMutationResult {}

export interface RemoveCaulkJobAllocationResponse extends RemoveCaulkJobAllocationResult {}
