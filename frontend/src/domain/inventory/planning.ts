import type { BoxStatus, AllocationKind, AllocationStatus, FilmOrderStatus, AllocationJobStatus, JobStatus } from './statuses';
import type { Warehouse } from './warehouses';

export interface AllocateBoxPayload {
  boxId: string;
  jobNumber: string;
  installDate?: string;
  crewLeader?: string;
  requestedFeet: number;
  requestedWidthIn?: number;
  requirementId?: string;
  crossWarehouse?: boolean;
  jobWarehouse?: Warehouse;
}

export interface ApplyAllocationPlanPayload extends AllocateBoxPayload {
  selectedSuggestionBoxIds?: string[];
  extraAllocations?: Array<{
    boxId: string;
    allocatedFeet: number;
  }>;
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

export interface AllocationEntry {
  allocationId: string;
  boxId: string;
  warehouse: Warehouse;
  jobNumber: string;
  installDate: string;
  crewLeader: string;
  allocatedFeet: number;
  coveredFeet: number;
  backedPhysicalFeet?: number;
  reservationState?: 'WITH_INSTALL_DATE' | 'WITHOUT_INSTALL_DATE';
  requirementId?: string;
  allocationKind: AllocationKind;
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
  sourceSuggestedFeet: number;
  sourceSuggestedCoveredFeet: number;
  sourceConflicts: string[];
  suggestions: AllocationPreviewSuggestion[];
  defaultCoveredFeet: number;
  defaultRemainingFeet: number;
}

export interface FilmOrderLinkedBox {
  boxId: string;
  orderedFeet: number;
  autoAllocatedFeet: number;
}

export type FilmOrderOrigin = 'MANUAL' | 'AUTO_SHORTAGE';

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
  installDate: string;
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
  state: 'NEEDS_TRANSFER' | 'TRANSFER_PENDING';
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
  manufacturer: string;
  itemName: string;
  itemCode: string;
  unit: 'LF' | 'TUBES';
  checkedOutQuantity: number;
  returnedQuantity: number;
  usedQuantity: number;
  notes: string;
}

export interface JobRequirementLine {
  requirementId: string;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  requiredFeet: number;
  allocatedFeet: number;
  allocatedWithInstallDateFeet?: number;
  allocatedWithoutInstallDateFeet?: number;
  remainingFeet: number;
}

export interface JobListEntry {
  jobNumber: string;
  warehouse: Warehouse;
  sections: string | null;
  installDate: string;
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
  sections?: string | number | null;
  installDate?: string;
  crewLeader?: string;
  lifecycleStatus?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  isLaborOnly?: boolean;
  notes?: string;
  requirements?: Array<{
    manufacturer: string;
    filmName: string;
    widthIn: number;
    requiredFeet: number;
  }>;
  caulkRequirements?: Array<{
    requirementId?: string;
    productId: string;
    requiredTubes: number;
  }>;
}

export interface UpdateJobPayload {
  jobNumber: string;
  warehouse?: Warehouse;
  sections?: string | number | null;
  installDate?: string;
  crewLeader?: string;
  lifecycleStatus?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  isLaborOnly?: boolean;
  notes?: string;
  requirements?: Array<{
    manufacturer: string;
    filmName: string;
    widthIn: number;
    requiredFeet: number;
  }>;
  caulkRequirements?: Array<{
    requirementId?: string;
    productId: string;
    requiredTubes: number;
  }>;
}

export interface SetJobStagedForPickupPayload {
  jobNumber: string;
  isStagedForPickup: boolean;
  autoCheckoutRemaining?: boolean;
}

export interface DeleteJobPayload {
  jobNumber: string;
  reason?: string;
}

export interface DeleteJobResult {
  jobNumber: string;
}
