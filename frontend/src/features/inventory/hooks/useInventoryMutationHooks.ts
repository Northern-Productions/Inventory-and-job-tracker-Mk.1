// Purpose: Backward-compatible export surface for inventory mutation hooks.
export {
  useAllocateBox,
  useAddCaulkJobAllocation,
  useCheckinCaulkJobAllocation,
  useCheckoutCaulkJobAllocation,
  useRemoveCaulkJobAllocation,
  useRemoveJobBoxAllocations,
  useUpdateCaulkJobAllocation
} from './mutations/allocationMutations';
export { useUndoAudit } from './mutations/auditMutations';
export {
  useAddBox,
  useCancelBoxTransfer,
  useDeleteBox,
  useReceiveBoxTransfer,
  useSetBoxStatus,
  useStartBoxTransfer,
  useUpdateBox
} from './mutations/boxMutations';
export {
  useCancelJob,
  useCheckoutAllJobMaterials,
  useCompleteJob,
  useCreateFilmOrder,
  useCreateJob,
  useDeleteFilmOrder,
  useDeleteJob,
  useReopenJob,
  useSetJobStagedForPickup,
  useUpdateJob
} from './mutations/planningMutations';
