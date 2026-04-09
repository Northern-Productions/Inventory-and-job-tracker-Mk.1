import type { Warehouse } from '../../../../domain';

export interface CaulkAllocationEditorState {
  mode: 'add' | 'edit';
  caulkAllocationId: string;
  requirementId: string;
  productId: string;
  warehouse: Warehouse;
  allocatedTubes: string;
  notes: string;
  lockProductWarehouse: boolean;
  minAllocatedTubes: number;
}

export interface CaulkCheckoutDraft {
  caulkAllocationId: string;
  productLabel: string;
  reservedTubesRemaining: number;
}

export interface CaulkCheckinDraft {
  caulkCheckoutId: string;
  caulkAllocationId: string;
  productLabel: string;
  checkoutTubes: number;
  tubesPerCase: number;
  unusedLooseTubes: string;
  unusedCases: string;
  notes: string;
}
