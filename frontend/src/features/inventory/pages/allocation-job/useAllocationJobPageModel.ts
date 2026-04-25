import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../../../components/Toast';
import type { CaulkJobCheckoutEntry, JobFilmTransferAlert } from '../../../../domain';
import { useIsPhoneLayout } from '../../../../hooks/useIsPhoneLayout';
import { safeDecodePathParam } from '../../../../lib/url';
import { useAuth } from '../../../auth/AuthContext';
import {
  useAddCaulkJobAllocation,
  useCancelCaulkTransfer,
  useCheckinCaulkJobAllocation,
  useCheckoutAllJobMaterials,
  useCheckoutCaulkJobAllocation,
  useCaulkProducts,
  useCompleteJob,
  useCreateFilmOrder,
  useDeleteJob,
  useDeleteFilmOrder,
  useFilmCatalog,
  usePendingDeleteFilmOrderIds,
  usePendingCancelCaulkTransferIds,
  usePendingRemoveJobBoxAllocationIds,
  usePendingReceiveCaulkTransferIds,
  useJob,
  useReceiveCaulkTransfer,
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
import {
  findUnresolvedOrderForRequirement,
  getOrderableFilmRequirements,
  normalizeFilmRequirementOrderKey
} from './filmRequirementOrders';

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
  const createFilmOrderMutation = useCreateFilmOrder();
  const addCaulkAllocationMutation = useAddCaulkJobAllocation();
  const updateCaulkAllocationMutation = useUpdateCaulkJobAllocation();
  const checkoutCaulkAllocationMutation = useCheckoutCaulkJobAllocation();
  const checkoutAllJobMaterialsMutation = useCheckoutAllJobMaterials();
  const checkinCaulkAllocationMutation = useCheckinCaulkJobAllocation();
  const removeCaulkAllocationMutation = useRemoveCaulkJobAllocation();
  const receiveCaulkTransferMutation = useReceiveCaulkTransfer();
  const cancelCaulkTransferMutation = useCancelCaulkTransfer();
  const completeJobMutation = useCompleteJob();
  const deleteJobMutation = useDeleteJob();
  const reopenJobMutation = useReopenJob();
  const deleteFilmOrderMutation = useDeleteFilmOrder();
  const pendingDeleteFilmOrderIds = usePendingDeleteFilmOrderIds();
  const pendingRemoveJobBoxAllocationIds = usePendingRemoveJobBoxAllocationIds();
  const pendingReceiveCaulkTransferIds = usePendingReceiveCaulkTransferIds();
  const pendingCancelCaulkTransferIds = usePendingCancelCaulkTransferIds();
  const removeJobBoxAllocationsMutation = useRemoveJobBoxAllocations();
  const setBoxStatusMutation = useSetBoxStatus();
  const setJobStagedForPickupMutation = useSetJobStagedForPickup();
  const caulkProductsQuery = useCaulkProducts();
  const [isOrderAllConfirmOpen, setIsOrderAllConfirmOpen] = useState(false);

  const detail = jobQuery.data;
  const summary = detail?.summary;
  const requirements = detail?.requirements || [];
  const allocations = detail?.allocations || [];
  const filmTransferAlerts = detail?.filmTransferAlerts || [];
  const caulkTransferAlerts = detail?.caulkTransferAlerts || [];
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
      allocations.filter((entry) => {
        /**
         * PURPOSE:
         * Keeps current film return rows visible even after checkout marks the
         * allocation FULFILLED; returned-material state belongs to the box.
         *
         * AFFECTS:
         * Allocated Boxes, film Check In actions, completion blockers, and
         * installer pickup visibility for checked-out film.
         *
         * WHEN CHANGING THIS, ALSO CHECK:
         * shared/checkoutSemantics.mjs, jobReturnedMaterials.ts,
         * AllocatedBoxesSection, and box status mutation cache updates.
         *
         * COMMON FAILURE MODES:
         * Hiding a checked-out box that still needs return handling, or showing
         * historical fulfilled allocations after a box has already returned.
         */
        const isCurrentCheckedOutReturn =
          entry.checkedOutOnThisJob && entry.boxStatus === 'CHECKED_OUT';
        return (
          isCurrentCheckedOutReturn ||
          (entry.status === 'ACTIVE' && !String(entry.resolvedAt || '').trim())
        );
      }),
    [allocations]
  );
  const filmOrders = detail?.filmOrders || [];
  const orderableFilmRequirements = useMemo(
    () => getOrderableFilmRequirements(requirements, filmOrders),
    [requirements, filmOrders]
  );
  const orderableFilmOrderGroups = useMemo(() => {
    const grouped = new Map<
      string,
      { requirement: (typeof requirements)[number]; requestedFeet: number }
    >();
    for (const requirement of orderableFilmRequirements) {
      const key = normalizeFilmRequirementOrderKey(requirement);
      const current = grouped.get(key);
      if (current) {
        current.requestedFeet += Math.max(0, Number(requirement.remainingFeet || 0));
      } else {
        grouped.set(key, {
          requirement,
          requestedFeet: Math.max(0, Number(requirement.remainingFeet || 0))
        });
      }
    }
    return Array.from(grouped.values());
  }, [orderableFilmRequirements]);
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
  const pendingCaulkTransferByAllocationId = useMemo(
    () =>
      Object.fromEntries(
        visibleCaulkAllocations
          .filter((entry) => entry.pendingTransfer?.transferId)
          .map((entry) => [entry.caulkAllocationId, entry.pendingTransfer!])
      ) as Record<string, NonNullable<(typeof visibleCaulkAllocations)[number]['pendingTransfer']>>,
    [visibleCaulkAllocations]
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
          !entry.pendingTransfer &&
          entry.reservedTubesRemaining > 0 &&
          !openCaulkCheckoutByAllocationId[entry.caulkAllocationId]
      ),
    [
      caulkTransferAlerts,
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
    caulkTransferAlerts,
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
    canManageTransfers: auth.hasFeatureAccess('inventory', 'write'),
    pendingTransferByAllocationId: pendingCaulkTransferByAllocationId,
    isCaulkTransferPending: (transferId: string) =>
      pendingReceiveCaulkTransferIds.has(String(transferId || '').trim().toUpperCase()) ||
      pendingCancelCaulkTransferIds.has(String(transferId || '').trim().toUpperCase()),
    addCaulkAllocation: addCaulkAllocationMutation.mutateAsync,
    addCaulkAllocationPending: addCaulkAllocationMutation.isPending,
    updateCaulkAllocation: updateCaulkAllocationMutation.mutateAsync,
    updateCaulkAllocationPending: updateCaulkAllocationMutation.isPending,
    checkoutCaulkAllocation: checkoutCaulkAllocationMutation.mutateAsync,
    checkoutCaulkAllocationPending: checkoutCaulkAllocationMutation.isPending,
    checkinCaulkAllocation: checkinCaulkAllocationMutation.mutateAsync,
    checkinCaulkAllocationPending: checkinCaulkAllocationMutation.isPending,
    removeCaulkAllocation: removeCaulkAllocationMutation.mutateAsync,
    removeCaulkAllocationPending: removeCaulkAllocationMutation.isPending,
    receiveCaulkTransfer: receiveCaulkTransferMutation.mutateAsync,
    receiveCaulkTransferPending: receiveCaulkTransferMutation.isPending,
    cancelCaulkTransfer: cancelCaulkTransferMutation.mutateAsync,
    cancelCaulkTransferPending: cancelCaulkTransferMutation.isPending
  });

  async function createOrderForRequirement(
    requirement: (typeof requirements)[number],
    requestedFeetOverride?: number
  ) {
    if (!summary) {
      return false;
    }

    const remainingFeet = Math.max(
      0,
      Number(requestedFeetOverride ?? requirement.remainingFeet ?? 0)
    );
    if (remainingFeet <= 0) {
      toast.push({
        title: 'No film to order',
        description: 'This requirement is already fully covered.',
        variant: 'error'
      });
      return false;
    }

    if (findUnresolvedOrderForRequirement(requirement, filmOrders)) {
      toast.push({
        title: 'Film order already exists',
        description: 'Cancel the existing unresolved order before creating another one for this requirement.',
        variant: 'error'
      });
      return false;
    }

    await createFilmOrderMutation.mutateAsync({
      jobNumber: summary.jobNumber,
      warehouse: summary.warehouse,
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: requirement.widthIn,
      requestedFeet: remainingFeet
    });
    return true;
  }

  async function handleOrderFilmRequirement(requirement: (typeof requirements)[number]) {
    if (
      isReadOnlyJob ||
      !ensureActionAccess({
        actionLabel: 'creating film orders',
        feature: 'film_orders',
        requireWriteAccess: true
      })
    ) {
      return;
    }

    try {
      const created = await createOrderForRequirement(requirement);
      if (created) {
        toast.push({
          title: 'Film order created',
          description: `${Math.max(0, Number(requirement.remainingFeet || 0))} LF of ${requirement.filmName} was added for job ${summary?.jobNumber}.`,
          variant: 'success'
        });
      }
    } catch (error) {
      toast.push({
        title: 'Unable to create film order',
        description: error instanceof Error ? error.message : 'The create request failed.',
        variant: 'error'
      });
    }
  }

  async function handleOrderAllFilmRequirements() {
    if (
      isReadOnlyJob ||
      !ensureActionAccess({
        actionLabel: 'creating film orders',
        feature: 'film_orders',
        requireWriteAccess: true
      })
    ) {
      return;
    }

    const targets = orderableFilmOrderGroups;
    if (!targets.length) {
      setIsOrderAllConfirmOpen(false);
      return;
    }

    let createdCount = 0;
    try {
      for (const target of targets) {
        const created = await createOrderForRequirement(target.requirement, target.requestedFeet);
        if (created) {
          createdCount += 1;
        }
      }

      setIsOrderAllConfirmOpen(false);
      toast.push({
        title: createdCount === 1 ? 'Film order created' : 'Film orders created',
        description: `${createdCount} unmet film requirement${createdCount === 1 ? '' : 's'} queued for job ${summary?.jobNumber}.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to create all film orders',
        description: error instanceof Error ? error.message : 'One of the create requests failed.',
        variant: 'error'
      });
    }
  }

  return {
    auth,
    isPhoneLayout,
    jobQuery,
    detail,
    summary,
    requirements,
    filmTransferAlerts,
    caulkTransferAlerts,
    filmTransferAlertsByBoxId,
    usageTimeline,
    caulkRequirements,
    caulkAllocations,
    caulkCheckouts,
    caulkProducts,
    caulkProductsQuery,
    filmCatalogQuery,
    filmOrders,
    orderableFilmRequirements,
    orderableFilmOrderGroups,
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
    isCreateFilmOrderPending: createFilmOrderMutation.isPending,
    isOrderAllConfirmOpen,
    setIsOrderAllConfirmOpen,
    handleOrderFilmRequirement,
    handleOrderAllFilmRequirements,
    handleCancelRequirementOrder: lifecycleWorkflow.setFilmOrderToDelete,
    lifecycleWorkflow,
    filmWorkflow,
    caulkWorkflow,
    isReopenPending: reopenJobMutation.isPending,
    isCheckoutAllPending: checkoutAllJobMaterialsMutation.isPending,
    isStagedPickupPending: setJobStagedForPickupMutation.isPending,
    isBoxStatusPending: setBoxStatusMutation.isPending,
    isCheckoutCaulkPending: checkoutCaulkAllocationMutation.isPending,
    isReceiveCaulkTransferPending: receiveCaulkTransferMutation.isPending,
    isCancelCaulkTransferPending: cancelCaulkTransferMutation.isPending,
    isDeleteJobPending: deleteJobMutation.isPending,
    isCompleteJobPending: completeJobMutation.isPending,
    isUpdateJobPending: updateJobMutation.isPending,
    isCheckinCaulkPending: checkinCaulkAllocationMutation.isPending,
    goBackToAllocations: () => navigate('/allocations'),
    openInventoryBox: (boxId: string) => navigate(`/inventory/${encodeURIComponent(boxId)}`),
    openOrderFilm: (order: Parameters<typeof buildAddBoxTarget>[0]) => navigate(buildAddBoxTarget(order))
  };
}
