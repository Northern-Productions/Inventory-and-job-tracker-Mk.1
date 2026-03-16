import {
  ALLOCATION_JOB_STATUSES as RUNTIME_ALLOCATION_JOB_STATUSES,
  BOX_STATUSES as RUNTIME_BOX_STATUSES,
  FILM_ORDER_STATUSES as RUNTIME_FILM_ORDER_STATUSES,
  JOB_STATUSES as RUNTIME_JOB_STATUSES,
  WAREHOUSE_CODE_PATTERN
} from './runtimeContract.mjs';

export const WAREHOUSE_CODES = ['IL1', 'MS1'] as const;
export type Warehouse = string;
export const WAREHOUSE_LABELS: Record<string, string> = {
  IL1: 'Wauconda IL1',
  MS1: 'Ridgeland MS1'
};

export function isWarehouse(value: string | null | undefined): value is Warehouse {
  if (!value) {
    return false;
  }

  return WAREHOUSE_CODE_PATTERN.test(value.toUpperCase());
}

export function parseWarehouse(
  value: string | null | undefined,
  fallback: Warehouse = ''
): Warehouse {
  if (!value) {
    return fallback;
  }

  const normalized = value.toUpperCase();
  return isWarehouse(normalized) ? normalized : fallback;
}

export function getWarehouseLabel(warehouse: Warehouse): string {
  return WAREHOUSE_LABELS[warehouse] || warehouse;
}

export interface WarehouseEntry {
  code: Warehouse;
  name: string;
  boxIdPrefix: string;
}

export interface AddWarehousePayload {
  code: string;
  name: string;
  boxIdPrefix: string;
}

export const BOX_STATUSES = [...RUNTIME_BOX_STATUSES] as const;
export type BoxStatus = (typeof BOX_STATUSES)[number];
export const CORE_TYPES = [
  'White plastic',
  'Red plastic',
  'Cardboard 1/8"',
  'Cardboard 3/4"',
  'SECURITY 1/4" Cardboard'
] as const;
export type CoreType = (typeof CORE_TYPES)[number];
export type BoxCoreType = CoreType | '';
export const ALLOCATION_STATUSES = ['ACTIVE', 'FULFILLED', 'CANCELLED'] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];
export const FILM_ORDER_STATUSES = [...RUNTIME_FILM_ORDER_STATUSES] as const;
export type FilmOrderStatus = (typeof FILM_ORDER_STATUSES)[number];
export const ALLOCATION_JOB_STATUSES = [...RUNTIME_ALLOCATION_JOB_STATUSES] as const;
export type AllocationJobStatus = (typeof ALLOCATION_JOB_STATUSES)[number];
export const JOB_STATUSES = [...RUNTIME_JOB_STATUSES] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface Box {
  boxId: string;
  warehouse: Warehouse;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  initialFeet: number;
  feetAvailable: number;
  lotRun: string;
  status: BoxStatus;
  orderDate: string;
  receivedDate: string;
  initialWeightLbs: number | null;
  lastRollWeightLbs: number | null;
  lastWeighedDate: string;
  filmKey: string;
  coreType: BoxCoreType;
  coreWeightLbs: number | null;
  lfWeightLbsPerFt: number | null;
  purchaseCost: number | null;
  notes: string;
  hasEverBeenCheckedOut: boolean;
  lastCheckoutJob: string;
  lastCheckoutDate: string;
  zeroedDate: string;
  zeroedReason: string;
  zeroedBy: string;
}

export interface SearchBoxesParams {
  warehouse: Warehouse;
  q?: string;
  status?: BoxStatus | '';
  film?: string;
  width?: string;
  showRetired?: boolean;
}

export interface AddBoxPayload {
  boxId: string;
  warehouse?: Warehouse;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  initialFeet: number;
  feetAvailable: number;
  lotRun?: string;
  orderDate: string;
  receivedDate: string;
  initialWeightLbs?: number | null;
  lastRollWeightLbs?: number | null;
  lastWeighedDate?: string;
  filmKey?: string;
  coreType?: BoxCoreType;
  coreWeightLbs?: number | null;
  lfWeightLbsPerFt?: number | null;
  purchaseCost?: number | null;
  notes?: string;
  auditNote?: string;
  filmOrderId?: string;
}

export interface UpdateBoxPayload extends Omit<AddBoxPayload, 'boxId'> {
  boxId: string;
  moveToZeroed?: boolean;
}

export interface DeleteBoxPayload {
  boxId: string;
  reason?: string;
}

export interface DeleteBoxResult {
  boxId: string;
  logId: string;
}

export interface SetBoxStatusPayload {
  boxId: string;
  status: Extract<BoxStatus, 'IN_STOCK' | 'CHECKED_OUT'>;
  lastRollWeightLbs?: number;
  auditNote?: string;
}

export interface AllocateBoxPayload {
  boxId: string;
  jobNumber: string;
  jobDate?: string;
  crewLeader?: string;
  requestedFeet: number;
  requestedWidthIn?: number;
  crossWarehouse?: boolean;
}

export interface ApplyAllocationPlanPayload extends AllocateBoxPayload {
  selectedSuggestionBoxIds?: string[];
  jobWarehouse?: Warehouse;
}

export interface RemoveJobBoxAllocationsPayload {
  jobNumber: string;
  allocationId: string;
  reason?: string;
}

export interface RemoveJobBoxAllocationsResult {
  jobNumber: string;
  allocationId: string;
  boxId: string;
  removedAllocationCount: number;
  releasedFeet: number;
}

export type AuditAction =
  | 'ADD_BOX'
  | 'DELETE_BOX'
  | 'UPDATE_BOX'
  | 'ZERO_OUT_BOX'
  | 'SET_STATUS'
  | 'UNDO'
  | 'UNDO_ADD_DELETE';

export interface AuditEntry {
  logId: string;
  date: string;
  action: string;
  boxId: string;
  before: Box | null;
  after: Box | null;
  user: string;
  notes: string;
}

export interface AuditListParams {
  from?: string;
  to?: string;
  user?: string;
  action?: string;
}

export interface UndoAuditPayload {
  logId: string;
  reason?: string;
}

export interface RollHistoryEntry {
  logId: string;
  boxId: string;
  warehouse: Warehouse;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  jobNumber: string;
  checkedOutAt: string;
  checkedOutBy: string;
  checkedOutWeightLbs: number | null;
  checkedInAt: string;
  checkedInBy: string;
  checkedInWeightLbs: number | null;
  weightDeltaLbs: number | null;
  feetBefore: number;
  feetAfter: number;
  notes: string;
}

export interface AllocationEntry {
  allocationId: string;
  boxId: string;
  warehouse: Warehouse;
  jobNumber: string;
  jobDate: string;
  crewLeader: string;
  allocatedFeet: number;
  status: AllocationStatus;
  createdAt: string;
  createdBy: string;
  resolvedAt: string;
  resolvedBy: string;
  filmOrderId: string;
  notes: string;
}

export interface AllocationListResponse {
  entries: AllocationEntry[];
}

export interface AllocationPreviewSuggestion {
  boxId: string;
  warehouse: Warehouse;
  widthIn: number;
  availableFeet: number;
  suggestedFeet: number;
  receivedDate: string;
  orderDate: string;
}

export interface AllocationPreview {
  jobNumber: string;
  jobDate: string;
  crewLeader: string;
  requestedFeet: number;
  sourceBoxId: string;
  sourceWarehouse: Warehouse;
  sourceBoxFeetAvailable: number;
  sourceSuggestedFeet: number;
  sourceConflicts: string[];
  suggestions: AllocationPreviewSuggestion[];
  defaultCoveredFeet: number;
  defaultRemainingFeet: number;
}

export interface FilmOrderEntry {
  filmOrderId: string;
  jobNumber: string;
  warehouse: Warehouse;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  requestedFeet: number;
  coveredFeet: number;
  orderedFeet: number;
  remainingToOrderFeet: number;
  jobDate: string;
  crewLeader: string;
  status: FilmOrderStatus;
  sourceBoxId: string;
  createdAt: string;
  createdBy: string;
  resolvedAt: string;
  resolvedBy: string;
  notes: string;
  linkedBoxes: FilmOrderLinkedBox[];
}

export interface FilmOrderListResponse {
  entries: FilmOrderEntry[];
}

export interface FilmCatalogEntry {
  filmKey: string;
  manufacturer: string;
  filmName: string;
  updatedAt: string;
}

export interface CreateFilmOrderPayload {
  jobNumber: string;
  warehouse: Warehouse;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  requestedFeet: number;
}

export interface AllocationJobSummary {
  jobNumber: string;
  jobDate: string;
  crewLeader: string;
  status: AllocationJobStatus;
  activeAllocatedFeet: number;
  fulfilledAllocatedFeet: number;
  openFilmOrderCount: number;
  boxCount: number;
}

export interface AllocationJobDetailEntry extends AllocationEntry {
  manufacturer: string;
  filmName: string;
  widthIn: number;
  boxStatus: BoxStatus | '';
  checkedOutOnThisJob: boolean;
}

export interface AllocationJobDetail {
  summary: AllocationJobSummary;
  allocations: AllocationJobDetailEntry[];
  usage: JobUsageEntry[];
  filmOrders: FilmOrderEntry[];
}

export interface JobUsageEntry {
  boxId: string;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  usedFeet: number;
  usageEventCount: number;
  latestCheckedInAt: string;
  latestCheckedOutAt: string;
  lastActivityAt: string;
}

export interface JobRequirementLine {
  requirementId: string;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  requiredFeet: number;
  allocatedFeet: number;
  remainingFeet: number;
}

export interface JobListEntry {
  jobNumber: string;
  warehouse: Warehouse;
  sections: string | null;
  dueDate: string;
  crewLeader: string;
  status: JobStatus;
  lifecycleStatus: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  requiredFeet: number;
  allocatedFeet: number;
  remainingFeet: number;
  requirementCount: number;
  allocationCount: number;
  filmOrderCount: number;
  updatedAt: string;
  notes: string;
}

export interface JobDetail {
  summary: JobListEntry;
  requirements: JobRequirementLine[];
  allocations: AllocationJobDetailEntry[];
  usage: JobUsageEntry[];
  filmOrders: FilmOrderEntry[];
}

export interface CreateJobPayload {
  jobNumber: string;
  warehouse: Warehouse;
  sections?: string | number | null;
  dueDate?: string;
  crewLeader?: string;
  lifecycleStatus?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  notes?: string;
  requirements?: Array<{
    manufacturer: string;
    filmName: string;
    widthIn: number;
    requiredFeet: number;
  }>;
}

export interface UpdateJobPayload {
  jobNumber: string;
  warehouse?: Warehouse;
  sections?: string | number | null;
  dueDate?: string;
  crewLeader?: string;
  lifecycleStatus?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  notes?: string;
  requirements?: Array<{
    manufacturer: string;
    filmName: string;
    widthIn: number;
    requiredFeet: number;
  }>;
}

export interface FilmOrderLinkedBox {
  boxId: string;
  orderedFeet: number;
  autoAllocatedFeet: number;
}

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
  jobNumber: string;
  warehouse: Warehouse;
  dueDate: string;
  crewLeader: string;
  status: JobStatus;
  lifecycleStatus: 'COMPLETED' | 'CANCELLED';
  requiredFeet: number;
  allocatedFeet: number;
  remainingFeet: number;
  closedAt: string;
}

export interface ReportsSummaryFilters {
  warehouse?: Warehouse | '';
  manufacturer?: string;
  film?: string;
  width?: string;
  from?: string;
  to?: string;
}

export interface CaulkManufacturerEntry {
  manufacturerId: string;
  name: string;
  lookupKey: string;
  isActive: boolean;
  updatedAt: string;
}

export interface UpsertCaulkManufacturerPayload {
  name: string;
  isActive?: boolean;
}

export interface CaulkProductEntry {
  productId: string;
  manufacturerId: string;
  manufacturer: string;
  productName: string;
  productCode: string;
  lookupKey: string;
  tubesPerCase: number;
  isActive: boolean;
  notes: string;
  updatedAt: string;
}

export interface UpsertCaulkProductPayload {
  productId?: string;
  manufacturerId: string;
  productName: string;
  productCode?: string;
  tubesPerCase?: number;
  isActive?: boolean;
  notes?: string;
}

export interface CaulkStockEntry {
  warehouse: Warehouse;
  productId: string;
  manufacturerId: string;
  manufacturer: string;
  productName: string;
  productCode: string;
  tubesPerCase: number;
  tubesOnHand: number;
  casesOnHand: number;
  looseTubes: number;
  updatedAt: string;
  updatedBy: string;
}

export interface ListCaulkStockParams {
  warehouse?: Warehouse | 'ALL' | '';
  manufacturer?: string;
  q?: string;
}

export interface CaulkTransactionEntry {
  transactionId: string;
  productId: string;
  warehouse: Warehouse;
  manufacturer: string;
  productName: string;
  productCode: string;
  action: 'RECEIVE' | 'USE' | 'ADJUST' | 'TRANSFER_OUT' | 'TRANSFER_IN' | 'BACKFILL_MIGRATE' | string;
  deltaTubes: number;
  resultingTubesOnHand: number;
  tubesPerCase: number;
  reason: string;
  notes: string;
  transferId: string;
  sourceBoxId: string;
  createdAt: string;
  createdBy: string;
}

export interface ListCaulkTransactionsParams {
  warehouse?: Warehouse | 'ALL' | '';
  productId?: string;
  limit?: number;
}

export interface MutateCaulkStockPayload {
  action: 'RECEIVE' | 'USE' | 'ADJUST';
  productId: string;
  warehouse: Warehouse;
  cases?: number;
  tubes?: number;
  deltaTubes?: number;
  reason?: string;
  notes?: string;
}

export interface TransferCaulkStockPayload {
  productId: string;
  fromWarehouse: Warehouse;
  toWarehouse: Warehouse;
  cases?: number;
  tubes?: number;
  deltaTubes?: number;
  reason?: string;
  notes?: string;
}

export interface CaulkMutationResult {
  transactionId: string;
  productId: string;
  manufacturer: string;
  productName: string;
  productCode: string;
  warehouse: Warehouse;
  action: string;
  deltaTubes: number;
  tubesPerCase: number;
  tubesBefore: number;
  tubesOnHand: number;
  casesOnHand: number;
  looseTubes: number;
}

export interface CaulkTransferResult {
  transferId: string;
  movedTubes: number;
  from: CaulkMutationResult;
  to: CaulkMutationResult;
}
