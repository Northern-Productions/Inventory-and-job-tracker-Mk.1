import type { SetBoxStatusPayload, UpdateBoxPayload, Warehouse } from '../../../../domain';
import type { ZeroedInventoryEditTrigger } from '../../utils/boxZeroedTransition';

export interface PendingOwnerChange {
  boxId: string;
  ownerCompanyId: string;
  note?: string;
}

export type ConfirmState =
  | {
      type: 'checkout';
      payload: SetBoxStatusPayload;
      message: string;
    }
  | {
      type: 'checkin';
      payload: SetBoxStatusPayload;
      message: string;
    }
  | null;

export interface PendingZeroedEditState {
  activePayload: UpdateBoxPayload;
  zeroedPayload: UpdateBoxPayload;
  ownerChange?: PendingOwnerChange;
  missingFields: string[];
  trigger: ZeroedInventoryEditTrigger;
}

export interface PendingZeroedReactivationState {
  payload: UpdateBoxPayload;
  ownerChange?: PendingOwnerChange;
}

export type TransferActionState = 'receive' | 'cancel' | null;

export interface TransferDestinationAnalysis {
  suggestedDestination: Warehouse | '';
  conflictMessage: string;
  isResolvingAllocations: boolean;
  resolutionWarning: string;
}
