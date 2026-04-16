import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../../../components/Toast';
import type { CaulkJobCheckoutEntry, JobFilmTransferAlert } from '../../../../domain';
import { useIsPhoneLayout } from '../../../../hooks/useIsPhoneLayout';
import { safeDecodePathParam } from '../../../../lib/url';
import { useAuth } from '../../../auth/AuthContext';
import {
  useAddCaulkJobAllocation,
  useCheckinCaulkJobAllocation,
  useCheckoutAllJobMaterials,
  useCheckoutCaulkJobAllocation,
  useCaulkProducts,
  useCompleteJob,
  useDeleteJob,
  useDeleteFilmOrder,
  useFilmCatalog,
  usePendingDeleteFilmOrderIds,
  usePendingRemoveJobBoxAllocationIds,
  useJob,
  useRemoveCaulkJobAllocation,
  useReopenJob,
  useRemoveJobBoxAllocations,
  useSetBoxStatus,
  useSetJobStagedForPickup,
  useUpdateCaulkJobAllocation,
  useUpdateJob
} from '../../hooks/useInventoryQueries';
import { summarizeReturnedMaterials } from '../../utils/jobReturnedMaterials';
import {
  canMarkJobStagedForPickupWithAutoCheckout,
  getJobStagingBlockingMessageWithOptions,
  isLaborOnlyJob
} from '../../utils/jobStaging';
import { useActionAccess } from '../../hooks/useActionAccess';
import { useWarehouseRegistry } from '../../hooks/useWarehouseRegistry';
import { useCaulkWorkflow } from './useCaulkWorkflow';
import { useJobFilmWorkflow } from './useJobFilmWorkflow';
import { useJobLifecycleWorkflow } from './useJobLifecycleWorkflow';
import { buildAddBoxTarget } from './helpers';

export function useAllocationJobPageModel() {
  const navigate = useNavigate();
  const isPhoneLayout = useIsPhoneLayout();
  const toast = useToast();
  const auth = useAuth();
  const ensureActionAccess = useActionAccess();
  const warehouseRegistry = useWarehouseRegistry();
  const params = useParams();
  const jobNumber = safeDecodePathParam(params.jobNumber);
  const jobQuery = useJob(jobNumber);
  const updateJobMutation = useUpdateJob();
  const addCaulkAllocationMutation = useAddCaulkJobAllocation();
  const updateCaulkAllocationMutation = useUpdateCaulkJobAllocation();
  const checkoutCaulkAllocationMutation = useCheckoutCaulkJobAllocation();
  const checkoutAllJobMaterialsMutation = useCheckoutAllJobMaterials();
  const checkinCaulkAllocationMutation = useCheckinCaulkJobAllocation();
  const removeCaulkAllocationMutation = useRemoveCaulkJobAllocation();
  const completeJobMutation = useCompleteJob();
  const deleteJobMutation = useDeleteJob();
  const reopenJobMutation = useReopenJob();
  const deleteFilmOrderMutation = useDeleteFilmOrder();
  const pendingDeleteFilmOrderIds = usePendingDeleteFilmOrderIds();
  const pendingRemoveJobBoxAllocationIds = usePendingRemoveJobBoxAllocationIds();
  const removeJobBoxAllocationsMutation = useRemoveJobBoxAllocations();
  const setBoxStatusMutation = useSetBoxStatus();
  const setJobStagedForPickupMutation = useSetJobStagedForPickup();
  const caulkProductsQuery = useCaulkProducts();

  const detail = jobQuery.data;
  const summary = detail?.summary;
  const requirements = detail?.requirements || [];
  const allocations = detail?.allocations || [];
  const filmTransferAlerts = detail?.filmTransferAlerts || [];
  const filmTransferAlertsByBoxId = useMemo(
    () =>
      Object.fromEntries(
        filmTransferAlerts.map((alert) => [alert.boxId, alert])
      ) as Record<string, JobFilmTransferAlert>,
    [filmTransferAlerts]
  );
  const usageTimeline = detail?.usageTimeline || [];
  const caulkRequirements = detail?.caulkRequirements || [];
  const caulkAllocations = detail?.caulkAllocations || [];
  const caulkCheckouts = detail?.caulkCheckouts || [];
  const caulkProducts = caulkProductsQuery.data || [];
  const isClosedJob =
    summary?.lifecycleStatus === 'COMPLETED' || summary?.lifecycleStatus === 'CANCELLED';
  const isReadOnlyJob = isClosedJob;
  const isLaborOnlyDisplayJob = useMemo(() => isLaborOnlyJob(detail), [detail]);
  const stagingBlockingMessage = useMemo(
    () => getJobStagingBlockingMessageWithOptions(detail, { allowAutoCheckout: true }),
    [detail]
  );
  const canMarkStagedPickup = useMemo(
    () => canMarkJobStagedForPickupWithAutoCheckout(detail),
    [detail]
  );
  const visibleAllocations = useMemo(
    () =>
      allocations.filter(
        (entry) =>
          entry.status === 'ACTIVE' &&
          (!String(entry.resolvedAt || '').trim() || entry.checkedOutOnThisJob)
      ),
    [allocations]
  );
  const filmOrders = detail?.filmOrders || [];
  const isExtraFilmMode = useMemo(
    () => requirements.length > 0 && requirements.every((entry) => entry.remainingFeet <= 0),
    [requirements]
  );
  const canAllocate = useMemo(
    () => !isReadOnlyJob && requirements.length > 0,
    [isReadOnlyJob, requirements.length]
  );
  const canAddCaulkAllocation = useMemo(
    () => !isReadOnlyJob && (caulkRequirements.length > 0 || caulkProducts.length > 0),
    [isReadOnlyJob, caulkRequirements.length, caulkProducts.length]
  );
  const openCaulkCheckoutByAllocationId = useMemo(
    () =>
      Object.fromEntries(
        caulkCheckouts
          .filter((entry) => entry.status === 'OPEN')
          .map((entry) => [entry.caulkAllocationId, entry])
      ) as Record<string, CaulkJobCheckoutEntry>,
    [caulkCheckouts]
  );
  const caulkCheckoutsByAllocationId = useMemo(() => {
    const grouped: Record<string, CaulkJobCheckoutEntry[]> = {};
    for (const checkout of caulkCheckouts) {
      if (!grouped[checkout.caulkAllocationId]) {
        grouped[checkout.caulkAllocationId] = [];
      }
      grouped[checkout.caulkAllocationId].push(checkout);
    }
    return grouped;
  }, [caulkCheckouts]);
  const visibleCaulkAllocations = useMemo(
    () =>
      caulkAllocations.filter((entry) => {
        if (entry.status === 'ACTIVE') {
          return true;
        }
        return Boolean(caulkCheckoutsByAllocationId[entry.caulkAllocationId]?.length);
      }),
    [caulkAllocations, caulkCheckoutsByAllocationId]
  );
  const hasCheckoutableMaterials = useMemo(
    () =>
      visibleAllocations.some(
        (entry) =>
          entry.status === 'ACTIVE' &&
          entry.boxStatus === 'IN_STOCK' &&
          !entry.checkedOutOnThisJob &&
          !filmTransferAlertsByBoxId[entry.boxId]
      ) ||
      visibleCaulkAllocations.some(
        (entry) =>
          entry.status === 'ACTIVE' &&
          entry.reservedTubesRemaining > 0 &&
          !openCaulkCheckoutByAllocationId[entry.caulkAllocationId]
      ),
    [
      filmTransferAlertsByBoxId,
      openCaulkCheckoutByAllocationId,
      visibleAllocations,
      visibleCaulkAllocations
    ]
  );
  const totalRequiredCaulkTubes = useMemo(
    () => caulkRequirements.reduce((sum, entry) => sum + entry.requiredTubes, 0),
    [caulkRequirements]
  );
  const totalAllocatedCaulkTubes = useMemo(
    () =>
      caulkAllocations.reduce(
        (sum, entry) => (entry.status === 'ACTIVE' ? sum + entry.allocatedTubes : sum),
        0
      ),
    [caulkAllocations]
  );
  const totalRemainingCaulkTubes = Math.max(totalRequiredCaulkTubes - totalAllocatedCaulkTubes, 0);
  const canDeleteJob = auth.clientIdConfigured && auth.isAuthenticated && (auth.isOwner || auth.isAdmin);
  const canEditStagedPickup =
    auth.clientIdConfigured &&
    auth.isAuthenticated &&
    auth.hasFeatureAccess('jobs', 'write') &&
    !isReadOnlyJob;
  const returnedMaterialsSummary = useMemo(
    () => summarizeReturnedMaterials(detail),
    [detail]
  );
  const hasOutstandingReturnedMaterials = returnedMaterialsSummary.hasOutstandingMaterials;
  const completionBlockedMessage = hasOutstandingReturnedMaterials
    ? `Return ${returnedMaterialsSummary.checkedOutFilmCount} checked-out box${returnedMaterialsSummary.checkedOutFilmCount === 1 ? '' : 'es'} and ${returnedMaterialsSummary.openCaulkCheckoutCount} open caulk checkout${returnedMaterialsSummary.openCaulkCheckoutCount === 1 ? '' : 's'} before completing this job.`
    : '';

  function ensureSignedIn(actionLabel: string) {
    return ensureActionAccess({
      actionLabel
    });
  }

  const lifecycleWorkflow = useJobLifecycleWorkflow({
    detail,
    summary,
    isReadOnlyJob,
    stagingBlockingMessage,
    filmTransferAlerts,
    isOwner: auth.isOwner,
    isAdmin: auth.isAdmin,
    ensureSignedIn,
    pushToast: toast.push,
    navigateToAllocations: () => navigate('/allocations', { replace: true }),
    navigateToJobDetail: (nextJobNumber) =>
      navigate(`/allocations/${encodeURIComponent(nextJobNumber)}`, { replace: true }),
    updateJob: updateJobMutation.mutateAsync,
    completeJob: completeJobMutation.mutateAsync,
    deleteJob: deleteJobMutation.mutateAsync,
    reopenJob: reopenJobMutation.mutateAsync,
    deleteFilmOrder: deleteFilmOrderMutation.mutateAsync,
    checkoutAllJobMaterials: checkoutAllJobMaterialsMutation.mutateAsync,
    setJobStagedForPickup: setJobStagedForPickupMutation.mutateAsync
  });
  const filmCatalogQuery = useFilmCatalog({ enabled: lifecycleWorkflow.isEditOpen });

  const filmWorkflow = useJobFilmWorkflow({
    summary,
    isReadOnlyJob,
    previousHasOutstandingMaterials: hasOutstandingReturnedMaterials,
    filmTransferAlertsByBoxId,
    pendingRemoveJobBoxAllocationIds,
    ensureSignedIn,
    maybeOpenReturnCompletionPrompt: lifecycleWorkflow.maybeOpenReturnCompletionPrompt,
    pushToast: toast.push,
    removeJobBoxAllocations: removeJobBoxAllocationsMutation.mutateAsync,
    setBoxStatus: setBoxStatusMutation.mutateAsync
  });

  const caulkWorkflow = useCaulkWorkflow({
    jobNumber: summary?.jobNumber,
    warehouse: summary?.warehouse,
    isReadOnlyJob,
    caulkProducts,
    caulkRequirements,
    warehouseEntries: warehouseRegistry.entries,
    previousHasOutstandingMaterials: hasOutstandingReturnedMaterials,
    ensureSignedIn,
    maybeOpenReturnCompletionPrompt: lifecycleWorkflow.maybeOpenReturnCompletionPrompt,
    pushToast: toast.push,
    addCaulkAllocation: addCaulkAllocationMutation.mutateAsync,
    addCaulkAllocationPending: addCaulkAllocationMutation.isPending,
    updateCaulkAllocation: updateCaulkAllocationMutation.mutateAsync,
    updateCaulkAllocationPending: updateCaulkAllocationMutation.isPending,
    checkoutCaulkAllocation: checkoutCaulkAllocationMutation.mutateAsync,
    checkoutCaulkAllocationPending: checkoutCaulkAllocationMutation.isPending,
    checkinCaulkAllocation: checkinCaulkAllocationMutation.mutateAsync,
    checkinCaulkAllocationPending: checkinCaulkAllocationMutation.isPending,
    removeCaulkAllocation: removeCaulkAllocationMutation.mutateAsync,
    removeCaulkAllocationPending: removeCaulkAllocationMutation.isPending
  });

  return {
    auth,
    isPhoneLayout,
    jobQuery,
    detail,
    summary,
    requirements,
    filmTransferAlerts,
    filmTransferAlertsByBoxId,
    usageTimeline,
    caulkRequirements,
    caulkAllocations,
    caulkCheckouts,
    caulkProducts,
    caulkProductsQuery,
    filmCatalogQuery,
    filmOrders,
    isReadOnlyJob,
    isLaborOnlyDisplayJob,
    stagingBlockingMessage,
    canMarkStagedPickup,
    visibleAllocations,
    openCaulkCheckoutByAllocationId,
    visibleCaulkAllocations,
    hasCheckoutableMaterials,
    totalRequiredCaulkTubes,
    totalAllocatedCaulkTubes,
    totalRemainingCaulkTubes,
    canDeleteJob,
    canEditStagedPickup,
    hasOutstandingReturnedMaterials,
    completionBlockedMessage,
    canAllocate,
    canAddCaulkAllocation,
    isExtraFilmMode,
    pendingDeleteFilmOrderIds,
    lifecycleWorkflow,
    filmWorkflow,
    caulkWorkflow,
    isReopenPending: reopenJobMutation.isPending,
    isCheckoutAllPending: checkoutAllJobMaterialsMutation.isPending,
    isStagedPickupPending: setJobStagedForPickupMutation.isPending,
    isBoxStatusPending: setBoxStatusMutation.isPending,
    isCheckoutCaulkPending: checkoutCaulkAllocationMutation.isPending,
    isDeleteJobPending: deleteJobMutation.isPending,
    isCompleteJobPending: completeJobMutation.isPending,
    isUpdateJobPending: updateJobMutation.isPending,
    isCheckinCaulkPending: checkinCaulkAllocationMutation.isPending,
    goBackToAllocations: () => navigate('/allocations'),
    openInventoryBox: (boxId: string) => navigate(`/inventory/${encodeURIComponent(boxId)}`),
    openOrderFilm: (order: Parameters<typeof buildAddBoxTarget>[0]) => navigate(buildAddBoxTarget(order))
  };
}
