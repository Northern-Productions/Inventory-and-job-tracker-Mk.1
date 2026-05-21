// Purpose: Backward-compatible export surface for inventory mutation hooks.
export {
  useAllocateBox,
  useAddCaulkJobAllocation,
  useCancelCaulkTransfer,
  useCheckinCaulkJobAllocation,
  useCheckoutCaulkJobAllocation,
  useReceiveCaulkTransfer,
  useClearAllocationPlannerSuppression,
  useRemoveCaulkJobAllocation,
  useRemoveJobBoxAllocations,
  useUpdateCaulkJobAllocation
} from './mutations/allocationMutations';
export { useUndoAudit } from './mutations/auditMutations';
export {
  useAddBox,
  useCancelBoxTransfer,
  useDeleteBox,
  useMarkLabelsPrinted,
  useReceiveOrderedBox,
  useReceiveBoxTransfer,
  useSetBoxStatus,
  useStartBoxTransfer,
  useUpsertBoxDealer,
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
  useSetJobRequirementState,
  useUpdateJob
} from './mutations/planning/jobLifecycleMutations';
export {
  useSetJobStagedForPickup,
  useCheckoutAllJobMaterials
} from './mutations/planning/jobMaterialWorkflowMutations';
