import type { SetBoxStatusPayload, UpdateBoxPayload, Warehouse } from '../../../../domain';
import type { ZeroedInventoryEditTrigger } from '../../utils/boxZeroedTransition';

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
  missingFields: string[];
  trigger: ZeroedInventoryEditTrigger;
}

export interface PendingZeroedReactivationState {
  payload: UpdateBoxPayload;
}

export type TransferActionState = 'receive' | 'cancel' | null;

export interface TransferDestinationAnalysis {
  suggestedDestination: Warehouse | '';
  conflictMessage: string;
  isResolvingAllocations: boolean;
  resolutionWarning: string;
}
