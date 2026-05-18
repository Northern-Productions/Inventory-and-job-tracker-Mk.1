import type { AllocationSource, CaulkTransferStatus } from './statuses';
import type { Warehouse } from './warehouses';

export interface CaulkPendingTransferSummary {
  transferId: string;
  status: Extract<CaulkTransferStatus, 'PENDING'>;
  sourceWarehouse: Warehouse;
  destinationWarehouse: Warehouse;
  pendingTubes: number;
  startedAt: string;
  startedBy: string;
  notes: string;
}

export interface CaulkTransferEntry {
  transferId: string;
  caulkAllocationId: string;
  jobNumber: string;
  jobId?: string;
  jobWarehouse: Warehouse | '';
  workScope?: string | null;
  sections?: string | null;
  productId: string;
  manufacturerId: string;
  manufacturer: string;
  productName: string;
  productCode: string;
  tubesPerCase: number;
  sourceWarehouse: Warehouse;
  destinationWarehouse: Warehouse;
  pendingTubes: number;
  status: CaulkTransferStatus;
  createdAt: string;
  createdBy: string;
  receivedAt: string;
  receivedBy: string;
  cancelledAt: string;
  cancelledBy: string;
  updatedAt: string;
  updatedBy: string;
  notes: string;
}

export interface JobCaulkRequirementLine {
  requirementId: string;
  jobNumber: string;
  productId: string;
  manufacturerId: string;
  manufacturer: string;
  productName: string;
  productCode: string;
  tubesPerCase: number;
  requiredTubes: number;
  allocatedTubes: number;
  remainingTubes: number;
  autoPlanningSuppressed?: boolean;
  notes: string;
  updatedAt: string;
}

export interface CaulkJobAllocationEntry {
  caulkAllocationId: string;
  requirementId: string;
  productId: string;
  manufacturerId: string;
  manufacturer: string;
  productName: string;
  productCode: string;
  tubesPerCase: number;
  warehouse: Warehouse;
  allocatedTubes: number;
  reservedTubesRemaining: number;
  checkedOutTubesTotal: number;
  returnedUnusedTubesTotal: number;
  usedTubesTotal: number;
  overageTubesTotal: number;
  outstandingCheckoutTubes: number;
  openCheckoutCount: number;
  status: 'ACTIVE' | 'CANCELLED' | string;
  allocationSource: AllocationSource;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  resolvedAt: string;
  resolvedBy: string;
  notes: string;
  pendingTransfer?: CaulkPendingTransferSummary | null;
}

export interface CaulkJobCheckoutEntry {
  caulkCheckoutId: string;
  caulkAllocationId: string;
  productId: string;
  manufacturerId: string;
  manufacturer: string;
  productName: string;
  productCode: string;
  tubesPerCase: number;
  warehouse: Warehouse;
  checkoutTubes: number;
  overageTubes: number;
  status: 'OPEN' | 'CLOSED' | string;
  checkedOutAt: string;
  checkedOutBy: string;
  checkedInAt: string;
  checkedInBy: string;
  unusedTubes: number;
  usedTubes: number;
  notes: string;
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
  warehouse?: Warehouse;
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
  productId?: string;
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
  jobId?: string;
  jobNumber?: string;
  jobWarehouse?: Warehouse | '';
  workScope?: string | null;
  sections?: string | null;
  createdAt: string;
  createdBy: string;
}

export interface ListCaulkTransactionsParams {
  warehouse?: Warehouse | 'ALL' | '';
  productId?: string;
  limit?: number;
}

export interface ListPendingCaulkTransfersParams {
  warehouse: Warehouse;
  productId?: string;
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

export interface AddCaulkJobAllocationPayload {
  jobId?: string;
  jobNumber: string;
  requirementId?: string;
  productId: string;
  warehouse: Warehouse;
  transferFromWarehouse?: Warehouse;
  allocatedTubes: number;
  notes?: string;
}

export interface UpdateCaulkJobAllocationPayload {
  caulkAllocationId: string;
  productId?: string;
  warehouse?: Warehouse;
  transferFromWarehouse?: Warehouse;
  allocatedTubes?: number;
  notes?: string;
}

export interface CheckoutCaulkJobAllocationPayload {
  caulkAllocationId: string;
  checkoutTubes: number;
  notes?: string;
}

export interface CheckinCaulkJobAllocationPayload {
  caulkCheckoutId: string;
  unusedLooseTubes?: number;
  unusedCases?: number;
  unusedTubes?: number;
  notes?: string;
}

export interface RemoveCaulkJobAllocationPayload {
  caulkAllocationId: string;
  reason?: string;
}

export interface ReceiveCaulkTransferPayload {
  transferId: string;
}

export interface CancelCaulkTransferPayload {
  transferId: string;
  reason?: string;
}

export interface CaulkJobAllocationMutationResult {
  jobId?: string;
  jobNumber: string;
  caulkAllocationId: string;
  productId?: string;
  warehouse?: string;
}

export interface CaulkTransferMutationResult extends CaulkJobAllocationMutationResult {
  transferId: string;
  sourceWarehouse?: Warehouse;
  destinationWarehouse?: Warehouse;
}

export interface CaulkJobCheckoutMutationResult extends CaulkJobAllocationMutationResult {
  caulkCheckoutId: string;
}

export interface RemoveCaulkJobAllocationResult extends CaulkJobAllocationMutationResult {
  releasedReservedTubes: number;
  autoPlanningSuppressed?: boolean;
}
