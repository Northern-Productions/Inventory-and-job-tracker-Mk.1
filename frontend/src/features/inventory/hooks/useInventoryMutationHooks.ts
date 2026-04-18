// Purpose: Backward-compatible export surface for inventory mutation hooks.
export {
  useAllocateBox,
  useAddCaulkJobAllocation,
  useCancelCaulkTransfer,
  useCheckinCaulkJobAllocation,
  useCheckoutCaulkJobAllocation,
  useReceiveCaulkTransfer,
  useRemoveCaulkJobAllocation,
  useRemoveJobBoxAllocations,
  useUpdateCaulkJobAllocation
} from './mutations/allocationMutations';
export { useUndoAudit } from './mutations/auditMutations';
export {
  useAddBox,
  useCancelBoxTransfer,
  useDeleteBox,
  useReceiveOrderedBox,
  useReceiveBoxTransfer,
  useSetBoxStatus,
  useStartBoxTransfer,
  useUpdateBox
} from './mutations/boxMutations';
export {
  useCreateFilmOrder,
  useDeleteFilmOrder
} from './mutations/planning/filmOrderMutations';
export {
  useCancelJob,
  useCompleteJob,
  useCreateJob,
  useDeleteJob,
  useReopenJob,
  useUpdateJob
} from './mutations/planning/jobLifecycleMutations';
export {
  useSetJobStagedForPickup,
  useCheckoutAllJobMaterials
} from './mutations/planning/jobMaterialWorkflowMutations';
