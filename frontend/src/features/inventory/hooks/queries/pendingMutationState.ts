import { useMemo } from 'react';
import { useMutationState } from '@tanstack/react-query';
import type { FilmOrderEntry, RemoveJobBoxAllocationsPayload } from '../../../../domain';
import { inventoryKeys } from '../inventoryQueryKeys';

export function usePendingRemoveJobBoxAllocationIds() {
  const pendingAllocationIds = useMutationState({
    filters: {
      mutationKey: inventoryKeys.removeJobBoxAllocationMutation,
      status: 'pending'
    },
    select: (mutation) => {
      const variables = mutation.state.variables as RemoveJobBoxAllocationsPayload | undefined;
      return String(variables?.allocationId || '').trim().toUpperCase();
    }
  });

  return useMemo(() => {
    const nextIds = new Set<string>();
    for (let index = 0; index < pendingAllocationIds.length; index += 1) {
      const allocationId = String(pendingAllocationIds[index] || '').trim().toUpperCase();
      if (allocationId) {
        nextIds.add(allocationId);
      }
    }

    return nextIds;
  }, [pendingAllocationIds]);
}

export function usePendingDeleteFilmOrderIds() {
  const pendingFilmOrderIds = useMutationState({
    filters: {
      mutationKey: inventoryKeys.deleteFilmOrderMutation,
      status: 'pending'
    },
    select: (mutation) => {
      const variables =
        mutation.state.variables as Pick<FilmOrderEntry, 'filmOrderId'> | { filmOrderId?: string } | undefined;
      return String(variables?.filmOrderId || '').trim().toUpperCase();
    }
  });

  return useMemo(() => {
    const nextIds = new Set<string>();
    for (let index = 0; index < pendingFilmOrderIds.length; index += 1) {
      const filmOrderId = String(pendingFilmOrderIds[index] || '').trim().toUpperCase();
      if (filmOrderId) {
        nextIds.add(filmOrderId);
      }
    }

    return nextIds;
  }, [pendingFilmOrderIds]);
}
