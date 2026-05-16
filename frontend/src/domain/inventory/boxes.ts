import type { Warehouse } from './warehouses';
import type { BoxCoreType, BoxStatus, BoxTransferStatus } from './statuses';

export interface BoxPendingTransferSummary {
  transferId: string;
  status: Extract<BoxTransferStatus, 'PENDING'>;
  sourceWarehouse: Warehouse;
  destinationWarehouse: Warehouse;
}

export interface BoxOrderedForJob {
  jobId?: string;
  jobNumber: string;
  filmOrderId?: string;
  orderedFeet?: number | null;
}

export interface Box {
  boxId: string;
  warehouse: Warehouse;
  dealer?: string;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  initialFeet: number;
  feetAvailable: number;
  physicalFeetAvailable?: number | null;
  allocatableNowFeet?: number | null;
  allocatedWithInstallDateFeet?: number;
  allocatedWithoutInstallDateFeet?: number;
  allocationPlanningFeet: number;
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
  pricePerLf: number | null;
  purchaseCost: number | null;
  notes: string;
  directToJobSite?: boolean;
  hasLabel?: boolean;
  hasEverBeenCheckedOut: boolean;
  lastCheckoutJobId?: string;
  lastCheckoutJob: string;
  lastCheckoutDate: string;
  zeroedDate: string;
  zeroedReason: string;
  zeroedBy: string;
  pendingTransfer?: BoxPendingTransferSummary | null;
  orderedForJobs?: BoxOrderedForJob[];
}

export interface SearchBoxesParams {
  warehouse?: Warehouse;
  warehouses?: Warehouse[];
  manufacturer?: string;
  q?: string;
  status?: BoxStatus | '';
  film?: string;
  width?: string;
  showRetired?: boolean;
}

export interface AddBoxPayload {
  boxId: string;
  warehouse?: Warehouse;
  dealer?: string;
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
  pricePerLf?: number | null;
  purchaseCost?: number | null;
  notes?: string;
  auditNote?: string;
  filmOrderId?: string;
  shipDirectToJobSite?: boolean;
}

export interface UpdateBoxPayload extends Omit<AddBoxPayload, 'boxId'> {
  boxId: string;
  currentFeetOnRoll?: number;
  moveToZeroed?: boolean;
  reactivateFromZeroed?: boolean;
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
  jobId?: string;
  jobNumber?: string;
  lastRollWeightLbs?: number;
  currentFeetOnRoll?: number;
  coreType?: BoxCoreType;
  auditNote?: string;
}

export interface ReceiveOrderedBoxPayload {
  boxId: string;
  receivedWeightLbs?: number;
  lotRun?: string;
  coreType?: BoxCoreType;
}

export interface MarkLabelsPrintedPayload {
  boxIds: string[];
}

export interface MarkLabelsPrintedResult {
  boxes: Box[];
  logIds?: string[];
}

export interface BoxDealerEntry {
  dealerId: string;
  name: string;
  lookupKey: string;
  updatedAt: string;
}

export interface UpsertBoxDealerPayload {
  name: string;
}

export interface StartBoxTransferPayload {
  boxId: string;
  toWarehouse: Warehouse;
  notes?: string;
  destinationBoxIdOverride?: string;
}

export interface BoxTransferPlanParams {
  boxId: string;
  toWarehouse: Warehouse;
  destinationBoxIdOverride?: string;
}

export type BoxTransferPlanConflictType = 'box' | 'alias' | 'pending_transfer' | null;

export interface BoxTransferPlanResponse {
  destinationBoxId: string;
  available: boolean;
  conflictType: BoxTransferPlanConflictType;
  conflictBoxId?: string | null;
}

export interface ReceiveBoxTransferPayload {
  transferId: string;
}

export interface CancelBoxTransferPayload {
  transferId: string;
  reason?: string;
}

export type AuditAction =
  | 'ADD_BOX'
  | 'DELETE_BOX'
  | 'UPDATE_BOX'
  | 'ZERO_OUT_BOX'
  | 'SET_STATUS'
  | 'START_TRANSFER'
  | 'RECEIVE_TRANSFER'
  | 'CANCEL_TRANSFER'
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
  jobId?: string;
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

export interface BoxTransferEntry {
  transferId: string;
  boxId: string;
  sourceBoxId: string;
  destinationBoxId: string;
  sourceWarehouse: Warehouse;
  destinationWarehouse: Warehouse;
  status: BoxTransferStatus;
  createdAt: string;
  createdBy: string;
  receivedAt: string;
  receivedBy: string;
  cancelledAt: string;
  cancelledBy: string;
  notes: string;
}

export interface BoxTransferMutationResult {
  box: Box;
  transfer: BoxTransferEntry;
  logId: string;
  cancelledAllocationCount: number;
  releasedFeet: number;
}
