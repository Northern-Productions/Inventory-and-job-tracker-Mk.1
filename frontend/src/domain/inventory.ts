export type Warehouse = 'IL' | 'MS';

export const BOX_STATUSES = ['ORDERED', 'IN_STOCK', 'CHECKED_OUT', 'ZEROED', 'RETIRED'] as const;
export type BoxStatus = (typeof BOX_STATUSES)[number];
export const CORE_TYPES = ['White', 'Red', 'Cardboard'] as const;
export type CoreType = (typeof CORE_TYPES)[number];
export type BoxCoreType = CoreType | '';
export const ALLOCATION_STATUSES = ['ACTIVE', 'FULFILLED', 'CANCELLED'] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];
export const FILM_ORDER_STATUSES = ['FILM_ORDER', 'FILM_ON_THE_WAY', 'FULFILLED', 'CANCELLED'] as const;
export type FilmOrderStatus = (typeof FILM_ORDER_STATUSES)[number];
export const ALLOCATION_JOB_STATUSES = [
  'READY',
  'ON_ORDER',
  'FILM_ORDER',
  'COMPLETED',
  'CANCELLED'
] as const;
export type AllocationJobStatus = (typeof ALLOCATION_JOB_STATUSES)[number];
export const JOB_STATUSES = ['ALLOCATE', 'READY', 'CANCELLED'] as const;
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
  crossWarehouse?: boolean;
}

export interface ApplyAllocationPlanPayload extends AllocateBoxPayload {
  selectedSuggestionBoxIds?: string[];
  jobWarehouse?: Warehouse;
}

export type AuditAction =
  | 'ADD_BOX'
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
}

export interface AllocationJobDetail {
  summary: AllocationJobSummary;
  allocations: AllocationJobDetailEntry[];
  filmOrders: FilmOrderEntry[];
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
  status: JobStatus;
  lifecycleStatus: 'ACTIVE' | 'CANCELLED';
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
  filmOrders: FilmOrderEntry[];
}

export interface CreateJobPayload {
  jobNumber: string;
  warehouse: Warehouse;
  sections?: string | number | null;
  dueDate?: string;
  lifecycleStatus?: 'ACTIVE' | 'CANCELLED';
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
  lifecycleStatus?: 'ACTIVE' | 'CANCELLED';
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

export interface ReportsSummaryFilters {
  warehouse?: Warehouse | '';
  manufacturer?: string;
  film?: string;
  width?: string;
  from?: string;
  to?: string;
}
