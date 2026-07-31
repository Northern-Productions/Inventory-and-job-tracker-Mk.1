import type {
  BoxStatus,
  AllocationKind,
  AllocationSource,
  AllocationStatus,
  FilmOrderStatus,
  AllocationJobStatus,
  JobStatus
} from './statuses';
import type { Warehouse } from './warehouses';

interface AllocationPlanBasePayload {
  boxId: string;
  jobNumber: string;
  installDate?: string;
  crewLeader?: string;
  requestedFeet: number;
  requestedWidthIn?: number;
  requirementId?: string;
  crossWarehouse?: boolean;
  jobWarehouse?: Warehouse;
  autoAllocate?: boolean;
}

export interface AllocateBoxPayload extends AllocationPlanBasePayload {
  jobId?: string;
}

export interface ApplyAllocationPlanPayload extends AllocationPlanBasePayload {
  jobId?: string;
  selectedSuggestionBoxIds?: string[];
  extraAllocations?: Array<{
    boxId: string;
    allocatedFeet: number;
  }>;
}

export interface RemoveJobBoxAllocationsPayload {
  jobId?: string;
  jobNumber: string;
  allocationId: string;
  reason?: string;
}

export interface RemoveJobBoxAllocationsResult {
  jobId?: string;
  jobNumber: string;
  allocationId: string;
  boxId: string;
  removedAllocationCount: number;
  releasedFeet: number;
}

export interface ClearAllocationPlannerSuppressionPayload {
  jobId?: string;
  jobNumber: string;
  requirementId: string;
  materialType?: 'FILM' | 'CAULK';
  reason?: string;
}

export interface AllocationEntry {
  allocationId: string;
  boxId: string;
  warehouse: Warehouse;
  jobId?: string;
  jobNumber: string;
  workScope?: string | null;
  sections?: string | null;
  installDate: string;
  crewLeader: string;
  allocatedFeet: number;
  coveredFeet: number;
  backedPhysicalFeet?: number;
  reservationState?: 'WITH_INSTALL_DATE' | 'WITHOUT_INSTALL_DATE';
  requirementId?: string;
  allocationKind: AllocationKind;
  allocationSource: AllocationSource;
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
  planningFeet: number;
  boxStatus: BoxStatus;
  requiresTransfer?: boolean;
  suggestedFeet: number;
  suggestedCoveredFeet: number;
  receivedDate: string;
  orderDate: string;
}

export interface AllocationPreview {
  jobNumber: string;
  installDate: string;
  crewLeader: string;
  requestedFeet: number;
  requestedWidthIn: number;
  sourceBoxId: string;
  sourceWarehouse: Warehouse;
  sourceWidthIn: number;
  sourceBoxFeetAvailable: number;
  sourceBoxPlanningFeet: number;
  sourceBoxStatus: BoxStatus;
  sourceRequiresTransfer?: boolean;
  sourceSuggestedFeet: number;
  sourceSuggestedCoveredFeet: number;
  sourceConflicts: string[];
  suggestions: AllocationPreviewSuggestion[];
  defaultCoveredFeet: number;
  defaultRemainingFeet: number;
}

export interface FilmOrderLinkedBox {
  boxId: string;
  dealer?: string;
  orderedFeet: number;
  autoAllocatedFeet: number;
  isReceived: boolean;
  isDirectToJobSite?: boolean;
}

export type FilmOrderOrigin = 'MANUAL' | 'AUTO_SHORTAGE';

export type FilmOrderDisplayStatus =
  | 'FILM_ORDER'
  | 'INCOMPLETE'
  | 'FULFILLED_COVERED'
  | 'MANUALLY_FULFILLED'
  | 'CANCELLED'
  | 'NO_LONGER_NEEDED';

export type FilmOrderNeedSource = 'CURRENT_REQUIREMENT' | 'LEGACY_SNAPSHOT' | 'NO_LONGER_NEEDED';

export interface FilmOrderEntry {
  filmOrderId: string;
  jobId?: string;
  requirementId?: string;
  jobNumber: string;
  warehouse: Warehouse;
  workScope?: string | null;
  sections?: string | null;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  requestedFeet: number;
  coveredFeet: number;
  orderedFeet: number;
  remainingToOrderFeet: number;
  installDate: string;
  crewLeader: string;
  status: FilmOrderStatus;
  sourceBoxId: string;
  origin?: FilmOrderOrigin;
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

export interface FilmOrderDetailLinkedBox extends FilmOrderLinkedBox {
  linkId?: string;
  initialFeet: number;
  feetAvailable: number;
  status: string;
  orderDate?: string | null;
  receivedDate?: string | null;
}

export interface FilmOrderHistoryEvent {
  eventId: string;
  eventType: string;
  filmOrderId: string;
  relatedBoxId?: string | null;
  relatedRequirementId?: string | null;
  actor: string;
  note: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  createdAt: string;
}

export interface FilmOrderDetail extends FilmOrderEntry {
  storedStatus: FilmOrderStatus;
  displayStatus: FilmOrderDisplayStatus;
  needSource: FilmOrderNeedSource;
  neededFeet: number;
  fulfilledFeet: number;
  remainingFeet: number;
  overageFeet: number;
  manualFulfilledAt?: string | null;
  manualFulfilledBy?: string | null;
  orderedDate?: string | null;
  receivedDate?: string | null;
  job?: {
    jobId?: string;
    jobNumber: string;
    warehouse?: Warehouse;
    workScope?: string | null;
    sections?: string | null;
  } | null;
  phase?: {
    phaseId: string;
    phaseNumber: number;
    workScope?: string | null;
    sections?: string | null;
    installDate?: string | null;
    crewLeader?: string | null;
  } | null;
  requirement?: {
    requirementId: string;
    phaseId?: string;
    manufacturer: string;
    filmName: string;
    widthIn: number;
    requiredFeet: number;
    status: string;
    matchesFilmOrder: boolean;
  } | null;
  linkedBoxes: FilmOrderDetailLinkedBox[];
  history: FilmOrderHistoryEvent[];
}

export interface FilmCatalogEntry {
  filmKey: string;
  manufacturer: string;
  filmName: string;
  updatedAt: string;
}

export type FilmWeightProfileConfidence = 'starter' | 'building' | 'solid' | 'needs_review';
export type FilmWeightProfileStatus = 'active' | 'needs_review' | 'disabled';

export interface FilmWeightProfileWidthSummary {
  widthIn: number;
  maxRecordedLf: number;
  acceptedSampleCount: number;
  lastSampleAt: string;
}

export interface FilmWeightProfileEntry {
  profileId: string;
  manufacturer: string;
  filmName: string;
  filmKey: string;
  coreType: string;
  coreWeightLbs: number | null;
  averageLbsPerSqFt: number | null;
  averageNormalizedLbsPerInchFoot: number | null;
  acceptedSampleCount: number;
  pendingReviewCount: number;
  confidence: FilmWeightProfileConfidence | string;
  status: FilmWeightProfileStatus | string;
  observedWidths: number[];
  widthSummaries: FilmWeightProfileWidthSummary[];
  firstSampleAt: string;
  lastSampleAt: string;
  lastReviewAt: string;
  manuallyOverridden: boolean;
  notes: string;
  updatedAt: string;
}

export interface FilmWeightProfilesResponse {
  entries: FilmWeightProfileEntry[];
}

export interface FilmWeightPendingReviewEntry {
  reviewId: string;
  profileId: string;
  sampleId: string;
  boxId: string;
  manufacturer: string;
  filmName: string;
  filmKey: string;
  widthIn: number | null;
  recordedLf: number | null;
  measuredRollWeightLbs: number | null;
  coreType: string;
  coreWeightLbs: number | null;
  estimatedLf: number | null;
  lfError: number | null;
  reason: string;
  reasons: string[];
  suggestedAction: string;
  status: string;
  profileConfidence: string;
  profileStatus: string;
  createdAt: string;
  notes: string;
}

export interface FilmWeightPendingReviewsResponse {
  entries: FilmWeightPendingReviewEntry[];
}

export type FilmWeightPendingReviewDecision = 'accept' | 'reject';

export interface ResolveFilmWeightPendingReviewPayload {
  reviewId: string;
  decision: FilmWeightPendingReviewDecision;
  notes?: string;
}

export interface ResolveFilmWeightPendingReviewResult {
  reviewId: string;
  sampleId: string;
  profileId: string;
  boxId: string;
  decision: FilmWeightPendingReviewDecision;
  status: 'resolved' | 'rejected' | string;
  acceptanceStatus: 'accepted' | 'rejected' | string;
  pendingReviewCount: number;
}

export interface CreateFilmOrderPayload {
  jobId?: string;
  jobNumber: string;
  requirementId?: string;
  warehouse: Warehouse;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  requestedFeet: number;
}

export interface DeleteFilmOrderPayload {
  jobId?: string;
  jobNumber?: string;
  filmOrderId: string;
  reason?: string;
}

export interface CancelJobPayload {
  jobId?: string;
  jobNumber: string;
  reason?: string;
}

export interface CancelJobResult {
  jobId?: string;
  jobNumber: string;
}

export interface AllocationJobSummary {
  jobId?: string;
  jobNumber: string;
  workScope?: string | null;
  sections?: string | null;
  installDate: string;
  installEndDate?: string;
  crewLeader: string;
  status: AllocationJobStatus;
  activeAllocatedFeet: number;
  allocatedWithInstallDateFeet?: number;
  allocatedWithoutInstallDateFeet?: number;
  fulfilledAllocatedFeet: number;
  requiredTubes: number;
  allocatedTubes: number;
  remainingTubes: number;
  openFilmOrderCount: number;
  boxCount: number;
  hasOrderedAllocations: boolean;
}

export interface JobFilmTransferAlert {
  boxId: string;
  sourceWarehouse: Warehouse;
  destinationWarehouse: Warehouse;
  state: 'NEEDS_TRANSFER' | 'TRANSFER_PENDING' | 'TRANSFER_REVIEW_REQUIRED';
  transferId?: string;
  startedAt?: string;
  startedBy?: string;
}

export interface JobCaulkTransferAlert {
  caulkAllocationId: string;
  productId: string;
  manufacturer: string;
  productName: string;
  productCode: string;
  sourceWarehouse?: Warehouse;
  destinationWarehouse: Warehouse;
  pendingTubes: number;
  state: 'NEEDS_TRANSFER' | 'TRANSFER_PENDING';
  transferId?: string;
  startedAt?: string;
  startedBy?: string;
}

export interface AllocationJobDetailEntry extends AllocationEntry {
  manufacturer: string;
  filmName: string;
  widthIn: number;
  requirementManufacturer?: string;
  requirementFilmName?: string;
  requirementWidthIn?: number;
  boxStatus: BoxStatus | '';
  checkedOutOnThisJob: boolean;
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

export interface JobUsageTimelineEntry {
  usageType: 'FILM' | 'CAULK' | 'FILM_ORDER';
  occurredAt: string;
  actor: string;
  warehouse: Warehouse;
  referenceId: string;
  jobNumber?: string;
  manufacturer: string;
  itemName: string;
  itemCode: string;
  widthIn?: number;
  unit: 'LF' | 'TUBES';
  checkedOutQuantity: number;
  returnedQuantity: number;
  usedQuantity: number;
  checkedOutAt?: string;
  checkedInAt?: string;
  checkedOutWeightLbs?: number | null;
  checkedInWeightLbs?: number | null;
  weightDeltaLbs?: number | null;
  feetBefore?: number | null;
  feetAfter?: number | null;
  usedLinearFeet?: number | null;
  notes: string;
}

export interface JobRequirementLine {
  requirementId: string;
  phaseId?: string;
  phaseNumber?: number;
  phaseWorkScope?: string | null;
  phaseInstallDate?: string;
  phaseCrewLeader?: string;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  requiredFeet: number;
  status?: 'ACTIVE' | 'COMPLETE';
  isComplete?: boolean;
  actualUsedFeet?: number;
  completedAt?: string;
  completedBy?: string;
  completionResult?: '' | 'ON_TARGET' | 'OVERUSED';
  allocatedFeet: number;
  allocatedWithInstallDateFeet?: number;
  allocatedWithoutInstallDateFeet?: number;
  remainingFeet: number;
  autoPlanningSuppressed?: boolean;
}

export type PhaseWorkflowStatus = 'ACTIVE' | 'PLACEHOLDER';

export interface JobPhase {
  phaseId: string;
  id?: string;
  jobId?: string;
  phaseNumber: number;
  workScope?: string | null;
  sections?: string | null;
  installDate: string;
  installEndDate?: string;
  crewLeader: string;
  laborStatus: 'ACTIVE' | 'COMPLETE';
  workflowStatus?: PhaseWorkflowStatus;
  isPlaceholder?: boolean;
  isWorkflowActive?: boolean;
  status: JobStatus | 'COMPLETED';
  isComplete: boolean;
  isPrimary?: boolean;
  isNextRelevant?: boolean;
  isExpandedByDefault?: boolean;
  requiredFeet: number;
  allocatedFeet: number;
  allocatedWithInstallDateFeet?: number;
  allocatedWithoutInstallDateFeet?: number;
  remainingFeet: number;
  requiredTubes: number;
  allocatedTubes: number;
  remainingTubes: number;
  requirementCount: number;
  caulkRequirementCount: number;
  filmOrderCount: number;
  allocationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface JobListEntry {
  jobId?: string;
  jobNumber: string;
  routeTarget?: string;
  warehouse: Warehouse;
  workScope?: string | null;
  primaryWorkScope?: string | null;
  workScopeKey?: string;
  sections: string | null;
  phaseId?: string;
  phaseNumber?: number;
  phaseWorkScope?: string | null;
  workflowStatus?: PhaseWorkflowStatus;
  isPlaceholder?: boolean;
  phaseCount?: number;
  phases?: JobPhase[];
  installDate: string;
  installEndDate?: string;
  crewLeader: string;
  status: JobStatus;
  lifecycleStatus: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  isLaborOnly: boolean;
  isStagedForPickup: boolean;
  requiredFeet: number;
  allocatedFeet: number;
  allocatedWithInstallDateFeet?: number;
  allocatedWithoutInstallDateFeet?: number;
  remainingFeet: number;
  requiredTubes: number;
  allocatedTubes: number;
  remainingTubes: number;
  requirementCount: number;
  allocationCount: number;
  filmOrderCount: number;
  hasOrderedAllocations: boolean;
  createdAt: string;
  updatedAt: string;
  notes: string;
}

export interface JobDetail {
  summary: JobListEntry;
  phases?: JobPhase[];
  requirements: JobRequirementLine[];
  allocations: AllocationJobDetailEntry[];
  usage: JobUsageEntry[];
  usageTimeline: JobUsageTimelineEntry[];
  caulkRequirements: import('./caulk').JobCaulkRequirementLine[];
  caulkAllocations: import('./caulk').CaulkJobAllocationEntry[];
  caulkCheckouts: import('./caulk').CaulkJobCheckoutEntry[];
  filmOrders: FilmOrderEntry[];
  filmTransferAlerts?: JobFilmTransferAlert[];
  caulkTransferAlerts?: JobCaulkTransferAlert[];
}

export interface AllocationJobDetail {
  summary: AllocationJobSummary;
  phases?: JobPhase[];
  requirements?: JobRequirementLine[];
  allocations: AllocationJobDetailEntry[];
  usage: JobUsageEntry[];
  usageTimeline: JobUsageTimelineEntry[];
  caulkRequirements: import('./caulk').JobCaulkRequirementLine[];
  caulkAllocations: import('./caulk').CaulkJobAllocationEntry[];
  caulkCheckouts: import('./caulk').CaulkJobCheckoutEntry[];
  filmOrders: FilmOrderEntry[];
  filmTransferAlerts?: JobFilmTransferAlert[];
  caulkTransferAlerts?: JobCaulkTransferAlert[];
}

export interface CreateJobPayload {
  jobNumber: string;
  warehouse: Warehouse;
  workScope?: string | number | null;
  sections?: string | number | null;
  installDate?: string;
  crewLeader?: string;
  lifecycleStatus?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  isLaborOnly?: boolean;
  notes?: string;
  requirements?: Array<{
    requirementId?: string;
    phaseId?: string;
    phaseNumber?: number;
    manufacturer: string;
    filmName: string;
    widthIn: number;
    requiredFeet: number;
  }>;
  caulkRequirements?: Array<{
    requirementId?: string;
    phaseId?: string;
    phaseNumber?: number;
    productId: string;
    requiredTubes: number;
  }>;
  phases?: Array<{
    phaseId?: string;
    phaseNumber: number;
    workScope?: string | number | null;
    sections?: string | number | null;
    installDate?: string;
    installEndDate?: string;
    crewLeader?: string;
    laborStatus?: 'ACTIVE' | 'COMPLETE';
    workflowStatus?: PhaseWorkflowStatus;
    isPrimary?: boolean;
    requirements?: CreateJobPayload['requirements'];
    caulkRequirements?: CreateJobPayload['caulkRequirements'];
  }>;
}

export interface UpdateJobPayload {
  jobId?: string;
  jobNumber: string;
  warehouse?: Warehouse;
  workScope?: string | number | null;
  sections?: string | number | null;
  installDate?: string;
  crewLeader?: string;
  lifecycleStatus?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  isLaborOnly?: boolean;
  notes?: string;
  requirements?: Array<{
    requirementId?: string;
    phaseId?: string;
    phaseNumber?: number;
    manufacturer: string;
    filmName: string;
    widthIn: number;
    requiredFeet: number;
  }>;
  caulkRequirements?: Array<{
    requirementId?: string;
    phaseId?: string;
    phaseNumber?: number;
    productId: string;
    requiredTubes: number;
  }>;
  phases?: Array<{
    phaseId?: string;
    phaseNumber: number;
    workScope?: string | number | null;
    sections?: string | number | null;
    installDate?: string;
    installEndDate?: string;
    crewLeader?: string;
    laborStatus?: 'ACTIVE' | 'COMPLETE';
    workflowStatus?: PhaseWorkflowStatus;
    isPrimary?: boolean;
    requirements?: UpdateJobPayload['requirements'];
    caulkRequirements?: UpdateJobPayload['caulkRequirements'];
  }>;
}

export interface SetJobStagedForPickupPayload {
  jobId?: string;
  jobNumber: string;
  isStagedForPickup: boolean;
  autoCheckoutRemaining?: boolean;
}

export interface SetJobRequirementStatePayload {
  jobId?: string;
  jobNumber: string;
  requirementId: string;
  materialType?: 'FILM' | 'CAULK';
  status: 'ACTIVE' | 'COMPLETE';
}

export interface SetJobPhaseStatePayload {
  jobId?: string;
  jobNumber: string;
  phaseId: string;
  status?: 'ACTIVE' | 'COMPLETE';
  workflowStatus?: PhaseWorkflowStatus;
}

export interface DeleteJobPayload {
  jobId?: string;
  jobNumber: string;
  reason?: string;
}

export interface DeleteJobResult {
  jobId?: string;
  jobNumber: string;
}
