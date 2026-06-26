export type InventoryOwnershipResourceType = 'film_box' | 'caulk_stock';

export interface OwnerCompanyEntry {
  ownerCompanyId: string;
  code: string;
  displayName: string;
  lookupKey: string;
  isActive: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  deactivatedAt: string;
  deactivatedBy: string;
}

export interface UpsertOwnerCompanyPayload {
  code: string;
  displayName?: string;
}

export interface DeactivateOwnerCompanyPayload {
  ownerCompanyId: string;
  note?: string;
}

export interface ChangeFilmBoxOwnerPayload {
  boxId: string;
  ownerCompanyId: string;
  note?: string;
}

export interface ChangeCaulkStockOwnerPayload {
  stockId: string;
  ownerCompanyId: string;
  note?: string;
}

export interface BulkOwnershipTransferPayload {
  filmBoxIds?: string[];
  caulkStockIds?: string[];
  ownerCompanyId: string;
  note?: string;
}

export interface OwnershipEventEntry {
  eventId: string;
  resourceType: InventoryOwnershipResourceType;
  resourceId: string;
  resourceLabel: string;
  oldOwnerCompanyId: string;
  oldOwnerCode: string;
  oldOwnerDisplayName: string;
  newOwnerCompanyId: string;
  newOwnerCode: string;
  newOwnerDisplayName: string;
  actor: string;
  note: string;
  batchId: string;
  createdAt: string;
}

export interface OwnershipMutationResult {
  changedCount: number;
  batchId: string;
  events: OwnershipEventEntry[];
}
