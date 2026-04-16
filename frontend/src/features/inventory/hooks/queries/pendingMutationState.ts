import { useMemo } from 'react';
import { useMutationState } from '@tanstack/react-query';
import type {
  AddCaulkJobAllocationPayload,
  CancelCaulkTransferPayload,
  CheckinCaulkJobAllocationPayload,
  CheckoutCaulkJobAllocationPayload,
  FilmOrderEntry,
  ReceiveCaulkTransferPayload,
  RemoveCaulkJobAllocationPayload,
  RemoveJobBoxAllocationsPayload,
  SetBoxStatusPayload,
  UpdateCaulkJobAllocationPayload,
  UpdateJobPayload
} from '../../../../domain';
import { inventoryKeys } from '../inventoryQueryKeys';

function usePendingStringSet<Variables>(
  mutationKey: readonly unknown[],
  selector: (variables: Variables | undefined) => string
) {
  const pendingValues = useMutationState({
    filters: {
      mutationKey,
      status: 'pending'
    },
    select: (mutation) => selector(mutation.state.variables as Variables | undefined)
  });

  return useMemo(() => {
    const nextValues = new Set<string>();
    for (let index = 0; index < pendingValues.length; index += 1) {
      const value = String(pendingValues[index] || '').trim().toUpperCase();
      if (value) {
        nextValues.add(value);
      }
    }

    return nextValues;
  }, [pendingValues]);
}

export function usePendingUpdateJobNumbers() {
  return usePendingStringSet<UpdateJobPayload>(inventoryKeys.updateJobMutation, (variables) =>
    String(variables?.jobNumber || '')
  );
}

export function usePendingSetBoxStatusBoxIds() {
  return usePendingStringSet<SetBoxStatusPayload>(inventoryKeys.setBoxStatusMutation, (variables) =>
    String(variables?.boxId || '')
  );
}

export function usePendingRemoveJobBoxAllocationIds() {
  return usePendingStringSet<RemoveJobBoxAllocationsPayload>(
    inventoryKeys.removeJobBoxAllocationMutation,
    (variables) => String(variables?.allocationId || '')
  );
}

export function usePendingDeleteFilmOrderIds() {
  return usePendingStringSet<
    Pick<FilmOrderEntry, 'filmOrderId'> | { filmOrderId?: string }
  >(inventoryKeys.deleteFilmOrderMutation, (variables) => String(variables?.filmOrderId || ''));
}

export function usePendingAddCaulkAllocationJobNumbers() {
  return usePendingStringSet<AddCaulkJobAllocationPayload>(
    inventoryKeys.addCaulkAllocationMutation,
    (variables) => String(variables?.jobNumber || '')
  );
}

export function usePendingUpdateCaulkAllocationIds() {
  return usePendingStringSet<UpdateCaulkJobAllocationPayload>(
    inventoryKeys.updateCaulkAllocationMutation,
    (variables) => String(variables?.caulkAllocationId || '')
  );
}

export function usePendingRemoveCaulkAllocationIds() {
  return usePendingStringSet<RemoveCaulkJobAllocationPayload>(
    inventoryKeys.removeCaulkAllocationMutation,
    (variables) => String(variables?.caulkAllocationId || '')
  );
}

export function usePendingCheckoutCaulkAllocationIds() {
  return usePendingStringSet<CheckoutCaulkJobAllocationPayload>(
    inventoryKeys.checkoutCaulkAllocationMutation,
    (variables) => String(variables?.caulkAllocationId || '')
  );
}

export function usePendingCheckinCaulkCheckoutIds() {
  return usePendingStringSet<CheckinCaulkJobAllocationPayload>(
    inventoryKeys.checkinCaulkAllocationMutation,
    (variables) => String(variables?.caulkCheckoutId || '')
  );
}

export function usePendingReceiveCaulkTransferIds() {
  return usePendingStringSet<ReceiveCaulkTransferPayload>(
    inventoryKeys.receiveCaulkTransferMutation,
    (variables) => String(variables?.transferId || '')
  );
}

export function usePendingCancelCaulkTransferIds() {
  return usePendingStringSet<CancelCaulkTransferPayload>(
    inventoryKeys.cancelCaulkTransferMutation,
    (variables) => String(variables?.transferId || '')
  );
}
