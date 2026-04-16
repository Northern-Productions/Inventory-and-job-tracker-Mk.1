import { useMutationState } from '@tanstack/react-query';
import { getAllocationsByBox, previewAllocationPlan } from '../../../../api/features/allocationsClient';
import { getAuditByBox, getRollHistoryByBox } from '../../../../api/features/auditClient';
import { getBox, getBoxTransfer, getBoxTransferPlan, searchBoxes } from '../../../../api/features/inventoryClient';
import type {
  AddBoxPayload,
  AllocateBoxPayload,
  BoxTransferPlanParams,
  SearchBoxesParams
} from '../../../../domain';
import { inventoryKeys } from '../inventoryQueryKeys';
import { useInventoryReadQuery } from './shared';

export function useSearchBoxes(params: SearchBoxesParams) {
  return useSearchBoxesWithOptions(params, { enabled: true });
}

export function useSearchBoxesWithOptions(
  params: SearchBoxesParams,
  options: { enabled?: boolean } = {}
) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.list(params),
    queryFn: () => searchBoxes(params),
    enabled: options.enabled ?? true
  });
}

export function useBox(boxId: string) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.box(boxId),
    queryFn: () => getBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useBoxTransfer(boxId: string, options: { enabled?: boolean } = {}) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.boxTransfer(boxId),
    queryFn: () => getBoxTransfer(boxId),
    enabled: Boolean(boxId) && (options.enabled ?? true)
  });
}

export function useBoxTransferPlan(
  params: BoxTransferPlanParams | null,
  options: { enabled?: boolean } = {}
) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.boxTransferPlan(params),
    queryFn: () => {
      if (!params) {
        throw new Error('Transfer plan parameters are required.');
      }

      return getBoxTransferPlan(params);
    },
    enabled: (options.enabled ?? true) && Boolean(params?.boxId) && Boolean(params?.toWarehouse)
  });
}

export function useBoxHistory(boxId: string) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.history(boxId),
    queryFn: () => getAuditByBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useBoxAllocations(boxId: string) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.allocations(boxId),
    queryFn: () => getAllocationsByBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useAllocationPreview(payload: AllocateBoxPayload | null) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.allocationPreview(payload),
    queryFn: () => {
      if (!payload) {
        throw new Error('Allocation preview payload is required.');
      }

      return previewAllocationPlan(payload);
    },
    enabled: Boolean(payload)
  });
}

export function useRollHistory(boxId: string) {
  return useInventoryReadQuery({
    queryKey: inventoryKeys.rollHistory(boxId),
    queryFn: () => getRollHistoryByBox(boxId),
    enabled: Boolean(boxId)
  });
}

export function useIsAddBoxPending(boxId: string) {
  const pendingBoxIds = useMutationState({
    filters: {
      mutationKey: inventoryKeys.addBoxMutation,
      status: 'pending'
    },
    select: (mutation) => {
      const variables = mutation.state.variables as AddBoxPayload | undefined;
      return variables?.boxId || '';
    }
  });
  const normalizedBoxId = boxId.trim().toUpperCase();

  if (!normalizedBoxId) {
    return false;
  }

  return pendingBoxIds.some((pendingBoxId) => pendingBoxId.trim().toUpperCase() === normalizedBoxId);
}
