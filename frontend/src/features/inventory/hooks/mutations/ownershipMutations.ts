import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  bulkTransferOwnership,
  changeCaulkStockOwner,
  changeFilmBoxOwner,
  deactivateOwnerCompany,
  upsertOwnerCompany
} from '../../../../api/features/ownershipClient';
import type {
  BulkOwnershipTransferPayload,
  ChangeCaulkStockOwnerPayload,
  ChangeFilmBoxOwnerPayload,
  DeactivateOwnerCompanyPayload,
  UpsertOwnerCompanyPayload
} from '../../../../domain';
import { inventoryKeys } from '../inventoryQueryKeys';

function invalidateOwnershipSurfaces(queryClient: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: inventoryKeys.ownerCompaniesRoot }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.listRoot }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.boxRoot }),
    queryClient.invalidateQueries({ queryKey: ['caulk', 'stock'] }),
    queryClient.invalidateQueries({ queryKey: ['caulk', 'transactions'] }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.activityRoot }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.reportsRoot }),
    queryClient.invalidateQueries({ queryKey: inventoryKeys.ownerReportsRoot })
  ]);
}

export function useUpsertOwnerCompany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: inventoryKeys.upsertOwnerCompanyMutation,
    mutationFn: (payload: UpsertOwnerCompanyPayload) => upsertOwnerCompany(payload),
    onSuccess: () => invalidateOwnershipSurfaces(queryClient)
  });
}

export function useDeactivateOwnerCompany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: inventoryKeys.deactivateOwnerCompanyMutation,
    mutationFn: (payload: DeactivateOwnerCompanyPayload) => deactivateOwnerCompany(payload),
    onSuccess: () => invalidateOwnershipSurfaces(queryClient)
  });
}

export function useChangeFilmBoxOwner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: inventoryKeys.changeFilmBoxOwnerMutation,
    mutationFn: (payload: ChangeFilmBoxOwnerPayload) => changeFilmBoxOwner(payload),
    onSuccess: (_result, variables) =>
      Promise.all([
        invalidateOwnershipSurfaces(queryClient),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.box(variables.boxId) }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.history(variables.boxId) })
      ])
  });
}

export function useChangeCaulkStockOwner() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: inventoryKeys.changeCaulkStockOwnerMutation,
    mutationFn: (payload: ChangeCaulkStockOwnerPayload) => changeCaulkStockOwner(payload),
    onSuccess: () => invalidateOwnershipSurfaces(queryClient)
  });
}

export function useBulkOwnershipTransfer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: inventoryKeys.bulkOwnershipTransferMutation,
    mutationFn: (payload: BulkOwnershipTransferPayload) => bulkTransferOwnership(payload),
    onSuccess: () => invalidateOwnershipSurfaces(queryClient)
  });
}
