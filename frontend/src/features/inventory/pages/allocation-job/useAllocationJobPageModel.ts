import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useToast } from '../../../../components/Toast';
import type {
  CaulkJobCheckoutEntry,
  FilmOrderEntry,
  JobCaulkRequirementLine,
  JobDetail,
  JobFilmTransferAlert,
  JobRequirementLine,
  JobNumberAmbiguityCandidate
} from '../../../../domain';
import { useIsPhoneLayout } from '../../../../hooks/useIsPhoneLayout';
import { safeDecodePathParam } from '../../../../lib/url';
import { useAuth } from '../../../auth/AuthContext';
import { listCaulkStock } from '../../../../api/features/caulkClient';
import { searchBoxes } from '../../../../api/features/inventoryClient';
import { resolveRequirementScheduleContext } from '../../utils/jobRequirementSchedule';
import {
  useAddCaulkJobAllocation,
  useAllocateBox,
  useCancelCaulkTransfer,
  useCheckinCaulkJobAllocation,
  useClearAllocationPlannerSuppression,
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
  useJobById,
  useReceiveCaulkTransfer,
  useRemoveCaulkJobAllocation,
  useReopenJob,
  useRemoveJobBoxAllocations,
  useSetBoxStatus,
  useStartBoxTransfer,
  useCancelBoxTransfer,
  useSetJobPhaseState,
  useSetJobRequirementState,
  useSetJobStagedForPickup,
  useUpdateCaulkJobAllocation,
  useUpdateJob
} from '../../hooks/useInventoryQueries';
import { summarizeReturnedMaterials } from '../../utils/jobReturnedMaterials';
import {
  canMarkJobStagedForPickup,
  getJobStagingBlockingMessageWithOptions,
  isLaborOnlyJob
} from '../../utils/jobStaging';
import { useActionAccess } from '../../hooks/useActionAccess';
import { useWarehouseRegistry } from '../../hooks/useWarehouseRegistry';
import { inventoryKeys } from '../../hooks/inventoryQueryKeys';
import { reconcileJobDetailCaulkCoverage } from '../../cache/jobRequirementCoverage';
import { buildAllocationJobRoute } from '../../utils/jobRoutes';
import { useCaulkWorkflow } from './useCaulkWorkflow';
import { useJobFilmWorkflow } from './useJobFilmWorkflow';
import { useJobLifecycleWorkflow } from './useJobLifecycleWorkflow';
import { buildAddBoxTarget } from './helpers';
import { collectPreferredLinkedBoxIds } from '../../components/job-allocate-dialog/helpers';
import {
  findUnresolvedOrderForRequirement,
  getOrderableFilmRequirements,
  normalizeFilmRequirementOrderKey
} from './filmRequirementOrders';
import { findMatchingBoxesForRequirement } from '../../utils/jobAllocationMatching';
import { prioritizeCandidateBoxes } from '../../utils/jobAllocationSelection';
import {
  buildStaleFilmOrderPromptKey,
  createFilmOrderCoverageSnapshot,
  findStaleManualFilmOrdersAfterCoverageTransition,
  type FilmOrderCoverageSnapshot
} from './filmOrderCoveragePrompt';

export function useAllocationJobPageModel() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isPhoneLayout = useIsPhoneLayout();
  const toast = useToast();
  const auth = useAuth();
  const ensureActionAccess = useActionAccess();
  const warehouseRegistry = useWarehouseRegistry();
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const routeJobId = safeDecodePathParam(params.jobId);
  const jobNumber = safeDecodePathParam(params.jobNumber);
  const jobByNumberQuery = useJob(routeJobId ? '' : jobNumber);
  const jobByIdQuery = useJobById(routeJobId);
  const jobQuery = routeJobId ? jobByIdQuery : jobByNumberQuery;
  const updateJobMutation = useUpdateJob();
  const createFilmOrderMutation = useCreateFilmOrder();
  const allocateBoxMutation = useAllocateBox();
  const addCaulkAllocationMutation = useAddCaulkJobAllocation();
  const updateCaulkAllocationMutation = useUpdateCaulkJobAllocation();
  const checkoutCaulkAllocationMutation = useCheckoutCaulkJobAllocation();
  const checkoutAllJobMaterialsMutation = useCheckoutAllJobMaterials();
  const checkinCaulkAllocationMutation = useCheckinCaulkJobAllocation();
  const removeCaulkAllocationMutation = useRemoveCaulkJobAllocation();
  const receiveCaulkTransferMutation = useReceiveCaulkTransfer();
  const cancelCaulkTransferMutation = useCancelCaulkTransfer();
  const startBoxTransferMutation = useStartBoxTransfer();
  const cancelBoxTransferMutation = useCancelBoxTransfer();
  const completeJobMutation = useCompleteJob();
  const deleteJobMutation = useDeleteJob();
  const reopenJobMutation = useReopenJob();
  const deleteFilmOrderMutation = useDeleteFilmOrder();
  const pendingDeleteFilmOrderIds = usePendingDeleteFilmOrderIds();
  const pendingRemoveJobBoxAllocationIds = usePendingRemoveJobBoxAllocationIds();
  const pendingReceiveCaulkTransferIds = usePendingReceiveCaulkTransferIds();
  const pendingCancelCaulkTransferIds = usePendingCancelCaulkTransferIds();
  const removeJobBoxAllocationsMutation = useRemoveJobBoxAllocations();
  const clearAutoPlanningSuppressionMutation = useClearAllocationPlannerSuppression();
  const setBoxStatusMutation = useSetBoxStatus();
  const setJobPhaseStateMutation = useSetJobPhaseState();
  const setJobRequirementStateMutation = useSetJobRequirementState();
  const setJobStagedForPickupMutation = useSetJobStagedForPickup();
  const caulkProductsQuery = useCaulkProducts();
  const [isOrderAllConfirmOpen, setIsOrderAllConfirmOpen] = useState(false);
  const [staleFilmOrderPromptOrders, setStaleFilmOrderPromptOrders] = useState<FilmOrderEntry[]>([]);
  const [filmAutoAllocateRequirementId, setFilmAutoAllocateRequirementId] = useState('');
  const [caulkAutoAllocateRequirementId, setCaulkAutoAllocateRequirementId] = useState('');
  const [filmTransferActionBoxId, setFilmTransferActionBoxId] = useState('');
  const [pendingFilmRequirementStateIds, setPendingFilmRequirementStateIds] = useState<Set<string>>(
    () => new Set()
  );
  const [pendingCaulkRequirementStateIds, setPendingCaulkRequirementStateIds] = useState<Set<string>>(
    () => new Set()
  );
  const [dismissedStaleFilmOrderPromptKeys, setDismissedStaleFilmOrderPromptKeys] = useState<
    Set<string>
  >(() => new Set());
  const didHandleScanCheckinKey = useRef('');

  const rawDetail = jobQuery.data;
  const detail = useMemo(
    () => (rawDetail ? reconcileJobDetailCaulkCoverage(rawDetail) : rawDetail),
    [rawDetail]
  );
  const summary = detail?.summary;
  const jobQueryError =
    jobQuery.error && typeof jobQuery.error === 'object'
      ? (jobQuery.error as {
          code?: unknown;
          jobNumber?: unknown;
          candidates?: unknown;
        })
      : null;
  const legacyJobNumberAmbiguity =
    !routeJobId &&
    jobQuery.isError &&
    jobQueryError?.code === 'JOB_NUMBER_AMBIGUOUS'
      ? {
          jobNumber:
            typeof jobQueryError.jobNumber === 'string' && jobQueryError.jobNumber.trim()
              ? jobQueryError.jobNumber.trim()
              : jobNumber,
          candidates: Array.isArray(jobQueryError.candidates)
            ? (jobQueryError.candidates as JobNumberAmbiguityCandidate[])
            : []
        }
      : null;
  const requirements = detail?.requirements || [];
  const phases = detail?.phases || detail?.summary?.phases || [];
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
    () => getJobStagingBlockingMessageWithOptions(detail),
    [detail]
  );

  useEffect(() => {
    if (routeJobId || !summary?.jobId) {
      return;
    }

    navigate(
      buildAllocationJobRoute({
        jobId: summary.jobId,
        jobNumber: summary.jobNumber
      }),
      { replace: true }
    );
  }, [navigate, routeJobId, summary?.jobId, summary?.jobNumber]);
  const canMarkStagedPickup = useMemo(
    () => canMarkJobStagedForPickup(detail),
    [detail]
  );
  const activePhaseScope = useMemo(() => {
    if (!phases.length) {
      return {
        hasPhaseScope: false,
        activePhaseIds: new Set<string>(),
        fallbackPhaseId: ''
      };
    }
    const activePhases = phases.filter(
      (phase) => String(phase.workflowStatus || '').trim().toUpperCase() !== 'PLACEHOLDER'
    );
    return {
      hasPhaseScope: true,
      activePhaseIds: new Set(activePhases.map((phase) => String(phase.phaseId || '').trim()).filter(Boolean)),
      fallbackPhaseId: String((phases.find((phase) => phase.isPrimary) || phases[0])?.phaseId || '').trim()
    };
  }, [phases]);
  const isActivePhaseEntry = useCallback(
    (entry: { phaseId?: string | null } | unknown) => {
      if (!activePhaseScope.hasPhaseScope) {
        return true;
      }
      const phaseId = String((entry as { phaseId?: string | null })?.phaseId || '').trim();
      if (phaseId) {
        return activePhaseScope.activePhaseIds.has(phaseId);
      }
      return Boolean(activePhaseScope.fallbackPhaseId && activePhaseScope.activePhaseIds.has(activePhaseScope.fallbackPhaseId));
    },
    [activePhaseScope]
  );
  const activeFilmRequirementIds = useMemo(
    () =>
      new Set(
        requirements
          .filter(isActivePhaseEntry)
          .map((entry) => String(entry.requirementId || '').trim())
          .filter(Boolean)
      ),
    [isActivePhaseEntry, requirements]
  );
  const activeCaulkRequirementIds = useMemo(
    () =>
      new Set(
        caulkRequirements
          .filter(isActivePhaseEntry)
          .map((entry) => String(entry.requirementId || '').trim())
          .filter(Boolean)
      ),
    [caulkRequirements, isActivePhaseEntry]
  );
  const isActiveFilmAllocationEntry = useCallback(
    (entry: { requirementId?: string | null; phaseId?: string | null }) => {
      const requirementId = String(entry.requirementId || '').trim();
      return requirementId ? activeFilmRequirementIds.has(requirementId) : isActivePhaseEntry(entry);
    },
    [activeFilmRequirementIds, isActivePhaseEntry]
  );
  const isActiveCaulkAllocationEntry = useCallback(
    (entry: { requirementId?: string | null; phaseId?: string | null }) => {
      const requirementId = String(entry.requirementId || '').trim();
      return requirementId ? activeCaulkRequirementIds.has(requirementId) : isActivePhaseEntry(entry);
    },
    [activeCaulkRequirementIds, isActivePhaseEntry]
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
  const visibleCaulkAllocations = useMemo(
    () =>
      caulkAllocations.filter((entry) => {
        if (entry.status === 'ACTIVE') {
          return true;
        }
        return Boolean(openCaulkCheckoutByAllocationId[entry.caulkAllocationId]);
      }),
    [caulkAllocations, openCaulkCheckoutByAllocationId]
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
          isActiveFilmAllocationEntry(entry) &&
          entry.boxStatus === 'IN_STOCK' &&
          !entry.checkedOutOnThisJob &&
          !filmTransferAlertsByBoxId[entry.boxId]
      ) ||
      visibleCaulkAllocations.some(
        (entry) =>
          entry.status === 'ACTIVE' &&
          isActiveCaulkAllocationEntry(entry) &&
          !entry.pendingTransfer &&
          entry.reservedTubesRemaining > 0 &&
          !openCaulkCheckoutByAllocationId[entry.caulkAllocationId]
      ),
    [
      caulkTransferAlerts,
      filmTransferAlertsByBoxId,
      isActiveCaulkAllocationEntry,
      isActiveFilmAllocationEntry,
      openCaulkCheckoutByAllocationId,
      visibleAllocations,
      visibleCaulkAllocations
    ]
  );
  const totalRequiredCaulkTubes = useMemo(
    () =>
      caulkRequirements.reduce(
        (sum, entry) => (entry.status === 'COMPLETE' ? sum : sum + entry.requiredTubes),
        0
      ),
    [caulkRequirements]
  );
  const totalAllocatedCaulkTubes = useMemo(
    () =>
      caulkRequirements.reduce(
        (sum, entry) => (entry.status === 'COMPLETE' ? sum : sum + entry.allocatedTubes),
        0
      ),
    [caulkRequirements]
  );
  const totalRemainingCaulkTubes = useMemo(
    () =>
      caulkRequirements.reduce(
        (sum, entry) => (entry.status === 'COMPLETE' ? sum : sum + entry.remainingTubes),
        0
      ),
    [caulkRequirements]
  );
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

  const maybeOpenStaleFilmOrderPromptAfterUserChange = useCallback(
    async (previousSnapshot: FilmOrderCoverageSnapshot, afterDetailOverride?: JobDetail) => {
      const normalizedJobNumber = summary?.jobNumber || jobNumber;
      if (!normalizedJobNumber) {
        return;
      }

      const nextAfterDetail =
        afterDetailOverride ||
        (await jobQuery.refetch()).data ||
        queryClient.getQueryData<JobDetail>(
          routeJobId ? inventoryKeys.jobById(routeJobId) : inventoryKeys.job(normalizedJobNumber)
        );
      if (!nextAfterDetail) {
        return;
      }
      const afterDetail = reconcileJobDetailCaulkCoverage(nextAfterDetail);

      const staleOrders = findStaleManualFilmOrdersAfterCoverageTransition({
        before: previousSnapshot,
        after: createFilmOrderCoverageSnapshot(afterDetail),
        dismissedPromptKeys: dismissedStaleFilmOrderPromptKeys
      });
      if (staleOrders.length > 0) {
        setStaleFilmOrderPromptOrders(staleOrders);
      }
    },
    [
      dismissedStaleFilmOrderPromptKeys,
      jobNumber,
      jobQuery,
      queryClient,
      routeJobId,
      summary?.jobNumber
    ]
  );

  function handleKeepStaleFilmOrders() {
    const promptKeys = staleFilmOrderPromptOrders.map(buildStaleFilmOrderPromptKey).filter(Boolean);
    setDismissedStaleFilmOrderPromptKeys((current) => {
      const next = new Set(current);
      for (const key of promptKeys) {
        next.add(key);
      }
      return next;
    });
    setStaleFilmOrderPromptOrders([]);
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
    canonicalJobId: routeJobId || undefined,
    deleteFilmOrder: deleteFilmOrderMutation.mutateAsync,
    checkoutAllJobMaterials: checkoutAllJobMaterialsMutation.mutateAsync,
    setJobStagedForPickup: setJobStagedForPickupMutation.mutateAsync,
    onUserDrivenFilmCoverageChange: maybeOpenStaleFilmOrderPromptAfterUserChange
  });
  const filmCatalogQuery = useFilmCatalog({ enabled: lifecycleWorkflow.isEditOpen });

  const filmWorkflow = useJobFilmWorkflow({
    summary,
    isReadOnlyJob,
    previousHasOutstandingMaterials: hasOutstandingReturnedMaterials,
    filmTransferAlertsByBoxId,
    pendingRemoveJobBoxAllocationIds,
    canonicalJobId: routeJobId || undefined,
    filmCoverageSnapshot: createFilmOrderCoverageSnapshot(detail),
    ensureSignedIn,
    maybeOpenReturnCompletionPrompt: lifecycleWorkflow.maybeOpenReturnCompletionPrompt,
    onUserDrivenFilmCoverageChange: maybeOpenStaleFilmOrderPromptAfterUserChange,
    pushToast: toast.push,
    removeJobBoxAllocations: removeJobBoxAllocationsMutation.mutateAsync,
    setBoxStatus: setBoxStatusMutation.mutateAsync
  });

  const caulkWorkflow = useCaulkWorkflow({
    canonicalJobId: routeJobId || undefined,
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

  useEffect(() => {
    const scanAction = String(searchParams.get('scanAction') || '').trim();
    if (scanAction !== 'checkin') {
      return;
    }

    const scannedBoxId = String(searchParams.get('boxId') || '').trim();
    const jobIdentity = routeJobId || summary?.jobId || summary?.jobNumber || jobNumber;
    const scanKey = `${jobIdentity}:${scannedBoxId}`.toUpperCase();
    if (!scannedBoxId || !jobIdentity || didHandleScanCheckinKey.current === scanKey) {
      return;
    }

    if (!detail || jobQuery.isLoading) {
      return;
    }

    const normalizedBoxId = scannedBoxId.toUpperCase();
    const checkedOutEntries = visibleAllocations.filter(
      (entry) =>
        String(entry.boxId || '').trim().toUpperCase() === normalizedBoxId &&
        entry.checkedOutOnThisJob &&
        entry.boxStatus === 'CHECKED_OUT'
    );

    didHandleScanCheckinKey.current = scanKey;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('scanAction');
    nextParams.delete('boxId');
    setSearchParams(nextParams, { replace: true });

    if (checkedOutEntries.length > 0) {
      filmWorkflow.openFilmCheckinDialog(checkedOutEntries[0]);
      return;
    }

    toast.push({
      title: 'Scanned box is not checked out on this job',
      description: `Box ${scannedBoxId} was not found as a checked-out box on this job. Open the box details or search Jobs if it was checked out elsewhere.`,
      variant: 'warning'
    });
  }, [
    detail,
    filmWorkflow,
    jobNumber,
    jobQuery.isLoading,
    routeJobId,
    searchParams,
    setSearchParams,
    summary?.jobId,
    summary?.jobNumber,
    toast,
    visibleAllocations
  ]);

  async function handleCancelStaleFilmOrders() {
    const orders = staleFilmOrderPromptOrders;
    setStaleFilmOrderPromptOrders([]);

    for (const order of orders) {
      await lifecycleWorkflow.handleDeleteFilmOrder(
        order,
        `Cancelled after job requirements were fulfilled for ${order.filmName}.`
      );
    }
  }

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
      ...(routeJobId ? { jobId: routeJobId } : {}),
      jobNumber: summary.jobNumber,
      requirementId: requirement.requirementId,
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

  async function handleAutoAllocateFilmRequirement(requirement: JobRequirementLine) {
    if (
      isReadOnlyJob ||
      !summary ||
      !ensureActionAccess({
        actionLabel: 'auto-allocating film',
        feature: 'allocations',
        requireWriteAccess: true
      })
    ) {
      return;
    }

    if (requirement.status === 'COMPLETE') {
      toast.push({
        title: 'Requirement is complete',
        description: 'Reactivate this requirement before allocating more film.',
        variant: 'error'
      });
      return;
    }

    const remainingFeet = Math.max(0, Math.floor(Number(requirement.remainingFeet || 0)));
    if (remainingFeet <= 0) {
      toast.push({
        title: 'No film to allocate',
        description: 'This requirement is already fully covered.',
        variant: 'warning'
      });
      return;
    }

    const { installDate: effectiveInstallDate, crewLeader: effectiveCrewLeader } =
      resolveRequirementScheduleContext(requirement, {
        installDate: summary.installDate,
        crewLeader: summary.crewLeader
      });
    if (effectiveInstallDate.trim() && !effectiveCrewLeader.trim()) {
      toast.push({
        title: 'Crew leader required',
        description: 'Add a crew leader before allocating film to a scheduled phase.',
        variant: 'error'
      });
      return;
    }

    if (!summary.warehouse) {
      toast.push({
        title: 'Warehouse required',
        description: 'Assign a warehouse to this job before auto-allocating material.',
        variant: 'error'
      });
      return;
    }

    const searchableWarehouses = [summary.warehouse];
    const previousSnapshot = createFilmOrderCoverageSnapshot(detail);
    setFilmAutoAllocateRequirementId(requirement.requirementId);

    try {
      const searchableBoxes = await searchBoxes({
        warehouses: searchableWarehouses,
        manufacturer: requirement.manufacturer.trim(),
        q: requirement.filmName.trim(),
        showRetired: false
      });
      const matchingBoxes = findMatchingBoxesForRequirement(
        searchableBoxes,
        requirement,
        summary.warehouse
      );
      const prioritizedBoxes = prioritizeCandidateBoxes(
        matchingBoxes,
        collectPreferredLinkedBoxIds(requirement, filmOrders),
        summary.warehouse
      );
      const sourceBox = prioritizedBoxes[0];
      if (!sourceBox) {
        toast.push({
          title: 'No matching film available',
          description: `${requirement.manufacturer} ${requirement.filmName} has no allocatable boxes for this requirement.`,
          variant: 'warning'
        });
        return;
      }

      const { result, warnings } = await allocateBoxMutation.mutateAsync({
        ...((routeJobId || summary.jobId) ? { jobId: routeJobId || summary.jobId } : {}),
        boxId: sourceBox.boxId,
        jobNumber: summary.jobNumber,
        installDate: effectiveInstallDate,
        crewLeader: effectiveCrewLeader,
        requestedFeet: remainingFeet,
        requestedWidthIn: requirement.widthIn,
        requirementId: requirement.requirementId,
        crossWarehouse: false,
        jobWarehouse: summary.warehouse,
        autoAllocate: true
      });
      const coveredFeet = result.allocations.reduce(
        (sum, entry) => sum + Number(entry.coveredFeet ?? entry.allocatedFeet ?? 0),
        0
      );
      const remainingSuffix =
        result.remainingUncoveredFeet > 0
          ? ` ${result.remainingUncoveredFeet} LF still remains for this requirement.`
          : '';
      const warningSuffix = warnings.length ? ` ${warnings.join(' ')}` : '';
      toast.push({
        title: coveredFeet > 0 ? 'Film auto allocated' : 'No film allocated',
        description: `${coveredFeet} LF was allocated to ${requirement.filmName}.${remainingSuffix}${warningSuffix}`,
        variant: coveredFeet > 0 ? 'success' : 'warning'
      });
      await maybeOpenStaleFilmOrderPromptAfterUserChange(previousSnapshot);
    } catch (error) {
      toast.push({
        title: 'Unable to auto allocate film',
        description: error instanceof Error ? error.message : 'The allocation request failed.',
        variant: 'error'
      });
    } finally {
      setFilmAutoAllocateRequirementId((current) =>
        current === requirement.requirementId ? '' : current
      );
    }
  }

  async function handleAutoAllocateCaulkRequirement(requirement: JobCaulkRequirementLine) {
    if (
      isReadOnlyJob ||
      !summary ||
      !ensureActionAccess({
        actionLabel: 'auto-allocating caulk',
        feature: 'allocations',
        requireWriteAccess: true
      })
    ) {
      return;
    }

    if (requirement.status === 'COMPLETE') {
      toast.push({
        title: 'Requirement is complete',
        description: 'Reactivate this requirement before allocating more caulk.',
        variant: 'error'
      });
      return;
    }

    const remainingTubes = Math.max(0, Math.floor(Number(requirement.remainingTubes || 0)));
    if (remainingTubes <= 0) {
      toast.push({
        title: 'No caulk to allocate',
        description: 'This requirement is already fully covered.',
        variant: 'warning'
      });
      return;
    }

    if (!summary.warehouse) {
      toast.push({
        title: 'Warehouse required',
        description: 'Assign a warehouse to this job before auto-allocating material.',
        variant: 'error'
      });
      return;
    }

    if (!requirement.productId) {
      toast.push({
        title: 'Caulk product required',
        description: 'This caulk requirement is missing a product identity.',
        variant: 'error'
      });
      return;
    }

    setCaulkAutoAllocateRequirementId(requirement.requirementId);

    try {
      const stockRows = await listCaulkStock({
        warehouse: summary.warehouse,
        productId: requirement.productId
      });
      const warehouseKey = summary.warehouse.trim().toUpperCase();
      const matchingStockRows = stockRows.filter(
        (entry) =>
          entry.productId === requirement.productId &&
          String(entry.warehouse || '').trim().toUpperCase() === warehouseKey
      );
      if (matchingStockRows.length > 1) {
        toast.push({
          title: 'Choose exact caulk owner',
          description:
            'Multiple owner rows exist for this caulk product and warehouse. Use Add Caulk to choose the exact owner stock row.',
          variant: 'error'
        });
        return;
      }

      const stockRow = matchingStockRows[0] || null;
      const availableTubes = Math.max(0, Math.floor(Number(stockRow?.tubesOnHand || 0)));
      const allocatedTubes = Math.min(remainingTubes, availableTubes);
      if (allocatedTubes <= 0) {
        toast.push({
          title: 'No caulk stock available',
          description: `${requirement.productName || requirement.productCode || 'Caulk'} has no tubes available in ${summary.warehouse}.`,
          variant: 'warning'
        });
        return;
      }

      const { warnings } = await addCaulkAllocationMutation.mutateAsync({
        ...((routeJobId || summary.jobId) ? { jobId: routeJobId || summary.jobId } : {}),
        jobNumber: summary.jobNumber,
        requirementId: requirement.requirementId,
        productId: requirement.productId,
        stockId: stockRow?.stockId || undefined,
        ownerCompanyId: stockRow?.ownerCompanyId || undefined,
        warehouse: summary.warehouse,
        allocatedTubes,
        notes: 'Auto allocated from requirement row.'
      });
      const remainingSuffix =
        allocatedTubes < remainingTubes
          ? ` ${remainingTubes - allocatedTubes} tube${remainingTubes - allocatedTubes === 1 ? '' : 's'} still remain for this requirement.`
          : '';
      const warningSuffix = warnings.length ? ` ${warnings.join(' ')}` : '';
      toast.push({
        title: 'Caulk auto allocated',
        description: `${allocatedTubes} tube${allocatedTubes === 1 ? '' : 's'} of ${requirement.productName || requirement.productCode || 'caulk'} were allocated.${remainingSuffix}${warningSuffix}`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to auto allocate caulk',
        description: error instanceof Error ? error.message : 'The allocation request failed.',
        variant: 'error'
      });
    } finally {
      setCaulkAutoAllocateRequirementId((current) =>
        current === requirement.requirementId ? '' : current
      );
    }
  }

  async function handleResumeAutoPlanning(requirement: (typeof requirements)[number]) {
    if (
      isReadOnlyJob ||
      !summary ||
      !ensureActionAccess({
        actionLabel: 'resuming auto planning',
        feature: 'allocations',
        requireWriteAccess: true
      })
    ) {
      return;
    }

    try {
      await clearAutoPlanningSuppressionMutation.mutateAsync({
        ...(routeJobId ? { jobId: routeJobId } : {}),
        jobNumber: summary.jobNumber,
        requirementId: requirement.requirementId,
        materialType: 'FILM',
        reason: 'User resumed auto-planning from job detail page.'
      });
      toast.push({
        title: 'Auto planning resumed',
        description: `${requirement.filmName} can be planned automatically again.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to resume auto planning',
        description: error instanceof Error ? error.message : 'The resume request failed.',
        variant: 'error'
      });
    }
  }

  async function handleSetRequirementState(
    requirement: JobRequirementLine,
    nextStatus: 'ACTIVE' | 'COMPLETE'
  ) {
    const requirementId = String(requirement.requirementId || '').trim();
    if (
      isReadOnlyJob ||
      !summary ||
      !requirementId ||
      pendingFilmRequirementStateIds.has(requirementId) ||
      !ensureActionAccess({
        actionLabel: 'changing requirement state',
        feature: 'jobs',
        requireWriteAccess: true
      })
    ) {
      return;
    }

    setPendingFilmRequirementStateIds((current) => {
      const next = new Set(current);
      next.add(requirementId);
      return next;
    });

    try {
      await setJobRequirementStateMutation.mutateAsync({
        ...(routeJobId ? { jobId: routeJobId } : {}),
        jobNumber: summary.jobNumber,
        requirementId,
        status: nextStatus
      });
      toast.push({
        title: nextStatus === 'COMPLETE' ? 'Requirement completed' : 'Requirement reactivated',
        description:
          nextStatus === 'COMPLETE'
            ? `${requirement.filmName} is marked complete.`
            : `${requirement.filmName} is active again for punch list work.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to update requirement',
        description: error instanceof Error ? error.message : 'The requirement update failed.',
        variant: 'error'
      });
    } finally {
      setPendingFilmRequirementStateIds((current) => {
        if (!current.has(requirementId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(requirementId);
        return next;
      });
    }
  }

  async function handleSetCaulkRequirementState(
    requirement: JobCaulkRequirementLine,
    nextStatus: 'ACTIVE' | 'COMPLETE'
  ) {
    const requirementId = String(requirement.requirementId || '').trim();
    if (
      isReadOnlyJob ||
      !summary ||
      !requirementId ||
      pendingCaulkRequirementStateIds.has(requirementId) ||
      !ensureActionAccess({
        actionLabel: 'changing caulk requirement state',
        feature: 'jobs',
        requireWriteAccess: true
      })
    ) {
      return;
    }

    setPendingCaulkRequirementStateIds((current) => {
      const next = new Set(current);
      next.add(requirementId);
      return next;
    });

    try {
      await setJobRequirementStateMutation.mutateAsync({
        ...(routeJobId ? { jobId: routeJobId } : {}),
        jobNumber: summary.jobNumber,
        requirementId,
        materialType: 'CAULK',
        status: nextStatus
      });
      toast.push({
        title: nextStatus === 'COMPLETE' ? 'Caulk requirement completed' : 'Caulk requirement reactivated',
        description:
          nextStatus === 'COMPLETE'
            ? `${requirement.productName || requirement.productCode || 'Caulk'} is marked complete.`
            : `${requirement.productName || requirement.productCode || 'Caulk'} is active again for punch list work.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to update caulk requirement',
        description: error instanceof Error ? error.message : 'The caulk requirement update failed.',
        variant: 'error'
      });
    } finally {
      setPendingCaulkRequirementStateIds((current) => {
        if (!current.has(requirementId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(requirementId);
        return next;
      });
    }
  }

  async function handleSetPhaseState(
    phase: NonNullable<typeof phases>[number],
    nextStatus: 'ACTIVE' | 'COMPLETE'
  ) {
    if (
      isReadOnlyJob ||
      !summary ||
      !ensureActionAccess({
        actionLabel: 'changing phase state',
        feature: 'jobs',
        requireWriteAccess: true
      })
    ) {
      return;
    }

    try {
      await setJobPhaseStateMutation.mutateAsync({
        ...(routeJobId ? { jobId: routeJobId } : {}),
        jobNumber: summary.jobNumber,
        phaseId: phase.phaseId,
        status: nextStatus
      });
      toast.push({
        title: nextStatus === 'COMPLETE' ? 'Phase completed' : 'Phase reactivated',
        description:
          nextStatus === 'COMPLETE'
            ? `Phase ${phase.phaseNumber} is marked complete.`
            : `Phase ${phase.phaseNumber} is active again.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to update phase',
        description: error instanceof Error ? error.message : 'The phase update failed.',
        variant: 'error'
      });
    }
  }

  async function handleSetPhaseWorkflowState(
    phase: NonNullable<typeof phases>[number],
    nextWorkflowStatus: 'ACTIVE' | 'PLACEHOLDER'
  ) {
    if (
      isReadOnlyJob ||
      !summary ||
      !ensureActionAccess({
        actionLabel: 'changing phase workflow state',
        feature: 'jobs',
        requireWriteAccess: true
      })
    ) {
      return false;
    }

    try {
      const { warnings } = await setJobPhaseStateMutation.mutateAsync({
        ...(routeJobId ? { jobId: routeJobId } : {}),
        jobNumber: summary.jobNumber,
        phaseId: phase.phaseId,
        workflowStatus: nextWorkflowStatus
      });
      toast.push({
        title: nextWorkflowStatus === 'ACTIVE' ? 'Phase activated' : 'Phase set as placeholder',
        description:
          warnings?.[0] ||
          (nextWorkflowStatus === 'ACTIVE'
            ? `Phase ${phase.phaseNumber} is part of the current workflow.`
            : `Phase ${phase.phaseNumber} is planning-only until activated.`),
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to update phase',
        description: error instanceof Error ? error.message : 'The phase update failed.',
        variant: 'error'
      });
      return false;
    }

    return true;
  }

  async function handleResumeCaulkAutoPlanning(requirement: JobCaulkRequirementLine) {
    if (
      isReadOnlyJob ||
      !summary ||
      !ensureActionAccess({
        actionLabel: 'resuming caulk auto planning',
        feature: 'allocations',
        requireWriteAccess: true
      })
    ) {
      return;
    }

    try {
      await clearAutoPlanningSuppressionMutation.mutateAsync({
        ...(routeJobId ? { jobId: routeJobId } : {}),
        jobNumber: summary.jobNumber,
        requirementId: requirement.requirementId,
        materialType: 'CAULK',
        reason: 'User resumed caulk auto-planning from job detail page.'
      });
      toast.push({
        title: 'Caulk auto planning resumed',
        description: `${requirement.productName} can be planned automatically again.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to resume caulk auto planning',
        description: error instanceof Error ? error.message : 'The resume request failed.',
        variant: 'error'
      });
    }
  }

  async function handleOrderAllFilmRequirements() {
    if (
      isReadOnlyJob ||
      createFilmOrderMutation.isPending ||
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

  async function handleStartFilmTransferFromAlert(alert: JobFilmTransferAlert) {
    if (
      isReadOnlyJob ||
      !summary ||
      !ensureActionAccess({
        actionLabel: 'starting film transfer',
        feature: 'inventory',
        requireWriteAccess: true
      })
    ) {
      return;
    }

    setFilmTransferActionBoxId(alert.boxId);
    try {
      await startBoxTransferMutation.mutateAsync({
        boxId: alert.boxId,
        toWarehouse: alert.destinationWarehouse,
        notes: `Started from job ${summary.jobNumber} transfer alert.`
      });
      toast.push({
        title: 'Film transfer started',
        description: `${alert.boxId} is moving from ${alert.sourceWarehouse} to ${alert.destinationWarehouse}.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to start film transfer',
        description: error instanceof Error ? error.message : 'The transfer request failed.',
        variant: 'error'
      });
    } finally {
      setFilmTransferActionBoxId('');
    }
  }

  async function handleCancelFilmTransferFromAlert(alert: JobFilmTransferAlert) {
    if (
      isReadOnlyJob ||
      !summary ||
      !alert.transferId ||
      !ensureActionAccess({
        actionLabel: 'cancelling film transfer',
        feature: 'inventory',
        requireWriteAccess: true
      })
    ) {
      return;
    }

    setFilmTransferActionBoxId(alert.boxId);
    try {
      await cancelBoxTransferMutation.mutateAsync({
        transferId: alert.transferId,
        reason: `Cancelled from job ${summary.jobNumber} transfer alert.`
      });
      toast.push({
        title: 'Film transfer cancelled',
        description: `${alert.boxId} transfer was cancelled.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to cancel film transfer',
        description: error instanceof Error ? error.message : 'The cancel request failed.',
        variant: 'error'
      });
    } finally {
      setFilmTransferActionBoxId('');
    }
  }

  return {
    auth,
    canonicalJobId: routeJobId || undefined,
    isPhoneLayout,
    jobQuery,
    detail,
    summary,
    phases,
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
    isActiveFilmAllocationEntry,
    openCaulkCheckoutByAllocationId,
    visibleCaulkAllocations,
    isActiveCaulkAllocationEntry,
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
    pendingFilmRequirementStateIds,
    pendingCaulkRequirementStateIds,
    isPhaseStatePending: setJobPhaseStateMutation.isPending,
    isResumeAutoPlanningPending: clearAutoPlanningSuppressionMutation.isPending,
    filmAutoAllocatePendingRequirementId: filmAutoAllocateRequirementId,
    caulkAutoAllocatePendingRequirementId: caulkAutoAllocateRequirementId,
    filmTransferActionBoxId,
    isFilmTransferActionPending:
      startBoxTransferMutation.isPending || cancelBoxTransferMutation.isPending,
    isOrderAllConfirmOpen,
    setIsOrderAllConfirmOpen,
    staleFilmOrderPromptOrders,
    handleKeepStaleFilmOrders,
    handleCancelStaleFilmOrders,
    maybeOpenStaleFilmOrderPromptAfterUserChange,
    handleOrderFilmRequirement,
    handleAutoAllocateFilmRequirement,
    handleAutoAllocateCaulkRequirement,
    handleSetRequirementState,
    handleSetCaulkRequirementState,
    handleSetPhaseState,
    handleSetPhaseWorkflowState,
    handleResumeAutoPlanning,
    handleResumeCaulkAutoPlanning,
    handleOrderAllFilmRequirements,
    handleStartFilmTransferFromAlert,
    handleCancelFilmTransferFromAlert,
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
    legacyJobNumberAmbiguity,
    openAmbiguousJobCandidate: (candidate: JobNumberAmbiguityCandidate) => {
      const routeTarget = String(candidate.routeTarget || '').trim();
      if (routeTarget) {
        navigate(routeTarget);
      }
    },
    goBackToAllocations: () => navigate('/allocations'),
    openInventoryBox: (boxId: string) => navigate(`/inventory/${encodeURIComponent(boxId)}`),
    openOrderFilm: (order: Parameters<typeof buildAddBoxTarget>[0]) => navigate(buildAddBoxTarget(order))
  };
}
