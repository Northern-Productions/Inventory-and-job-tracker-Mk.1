import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { listCaulkProducts } from '../../../api/features/caulkClient';
import { Button } from '../../../components/Button';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { useToast } from '../../../components/Toast';
import type { CaulkJobCheckoutEntry, JobFilmTransferAlert } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { safeDecodePathParam } from '../../../lib/url';
import { useAuth } from '../../auth/AuthContext';
import {
  useAddCaulkJobAllocation,
  useCheckinCaulkJobAllocation,
  useCheckoutAllJobMaterials,
  useCheckoutCaulkJobAllocation,
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
} from '../hooks/useInventoryQueries';
import { summarizeReturnedMaterials } from '../utils/jobReturnedMaterials';
import {
  canMarkJobStagedForPickupWithAutoCheckout,
  getJobStagingBlockingMessageWithOptions,
  isLaborOnlyJob
} from '../utils/jobStaging';
import { useActionAccess } from '../hooks/useActionAccess';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { CaulkAllocationsSection } from './allocation-job/CaulkAllocationsSection';
import { CaulkCheckoutCyclesSection } from './allocation-job/CaulkCheckoutCyclesSection';
import { CaulkRequirementsSection } from './allocation-job/CaulkRequirementsSection';
import { AllocatedBoxesSection } from './allocation-job/AllocatedBoxesSection';
import { JobCompletionSection } from './allocation-job/JobCompletionSection';
import { FilmRequirementsSection } from './allocation-job/FilmRequirementsSection';
import { JobUsageHistorySection } from './allocation-job/JobUsageHistorySection';
import { JobConfirmationDialogs } from './allocation-job/JobConfirmationDialogs';
import { JobOverviewHeroSection } from './allocation-job/JobOverviewHeroSection';
import { JobWorkflowDialogs } from './allocation-job/JobWorkflowDialogs';
import { RelatedFilmOrdersSection } from './allocation-job/RelatedFilmOrdersSection';
import { useCaulkWorkflow } from './allocation-job/useCaulkWorkflow';
import { useJobFilmWorkflow } from './allocation-job/useJobFilmWorkflow';
import { useJobLifecycleWorkflow } from './allocation-job/useJobLifecycleWorkflow';
import { buildAddBoxTarget } from './allocation-job/helpers';

export default function AllocationJobPage() {
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
  const filmCatalogQuery = useFilmCatalog();
  const caulkProductsQuery = useQuery({
    queryKey: ['caulk', 'products'],
    queryFn: () => listCaulkProducts()
  });

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

  const {
    caulkAllocationToRemove,
    setCaulkAllocationToRemove,
    caulkAllocationEditor,
    setCaulkAllocationEditor,
    caulkAllocationEditorError,
    setCaulkAllocationEditorError,
    caulkCheckoutDraft,
    setCaulkCheckoutDraft,
    caulkCheckoutError,
    setCaulkCheckoutError,
    caulkCheckinDraft,
    setCaulkCheckinDraft,
    caulkCheckinError,
    setCaulkCheckinError,
    warehouseOptions,
    pendingCaulkMutation,
    openAddCaulkAllocationDialog,
    openEditCaulkAllocationDialog,
    handleSubmitCaulkAllocationDialog,
    openCaulkCheckoutDialog,
    handleSubmitCaulkCheckoutDialog,
    openCaulkCheckinDialog,
    handleSubmitCaulkCheckinDialog,
    handleRemoveCaulkAllocation
  } = useCaulkWorkflow({
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

  if (jobQuery.isLoading && !detail) {
    return <DeferredLoadingState when label="Loading job details..." />;
  }

  if (jobQuery.isError || !detail || !summary) {
    return (
      <section className="panel">
        <p className="error-text">{jobQuery.error?.message || 'Job not found.'}</p>
        <Button type="button" variant="ghost" onClick={() => navigate('/allocations')}>
          Back to Jobs
        </Button>
      </section>
    );
  }

  return (
    <>
      <JobOverviewHeroSection
        summary={summary}
        isReadOnlyJob={isReadOnlyJob}
        isLaborOnlyDisplayJob={isLaborOnlyDisplayJob}
        totalRequiredCaulkTubes={totalRequiredCaulkTubes}
        totalAllocatedCaulkTubes={totalAllocatedCaulkTubes}
        totalRemainingCaulkTubes={totalRemainingCaulkTubes}
        stagingBlockingMessage={stagingBlockingMessage}
        canEditStagedPickup={canEditStagedPickup}
        canMarkStagedPickup={canMarkStagedPickup}
        hasCheckoutableMaterials={hasCheckoutableMaterials}
        filmTransferAlerts={filmTransferAlerts}
        isOwner={auth.isOwner}
        reopenPending={reopenJobMutation.isPending}
        checkoutAllPending={checkoutAllJobMaterialsMutation.isPending}
        stagedPickupPending={setJobStagedForPickupMutation.isPending}
        statusPending={setBoxStatusMutation.isPending}
        caulkCheckoutPending={checkoutCaulkAllocationMutation.isPending}
        onOpenEdit={() => lifecycleWorkflow.setIsEditOpen(true)}
        onOpenReopenConfirm={() => lifecycleWorkflow.setIsReopenConfirmOpen(true)}
        onBack={() => navigate('/allocations')}
        onCheckoutAll={() => void lifecycleWorkflow.handleCheckoutAllMaterials()}
        onToggleStagedPickup={(nextIsStaged) =>
          void lifecycleWorkflow.handleSetStagedPickup(nextIsStaged)
        }
        onOpenTransferBox={(boxId) => navigate(`/inventory/${encodeURIComponent(boxId)}`)}
      />

      <FilmRequirementsSection requirements={requirements} isPhoneLayout={isPhoneLayout} />

      <CaulkRequirementsSection requirements={caulkRequirements} isPhoneLayout={isPhoneLayout} />

      <AllocatedBoxesSection
        entries={visibleAllocations}
        isPhoneLayout={isPhoneLayout}
        isReadOnlyJob={isReadOnlyJob}
        canOpenAllocateDialog={canAllocate}
        allocateButtonLabel={isExtraFilmMode ? 'Allocate Extra' : 'Allocate Film'}
        isAuthenticated={auth.isAuthenticated}
        clientIdConfigured={auth.clientIdConfigured}
        isStatusMutationPending={setBoxStatusMutation.isPending}
        filmTransferAlertsByBoxId={filmTransferAlertsByBoxId}
        onOpenAllocateDialog={filmWorkflow.openAllocateDialog}
        onOpenBox={(boxId) => navigate(`/inventory/${encodeURIComponent(boxId)}`)}
        onOpenFilmCheckin={filmWorkflow.openFilmCheckinDialog}
        onCheckoutAllocation={(entry) => void filmWorkflow.handleCheckoutAllocation(entry)}
        onRemoveAllocation={filmWorkflow.setAllocationToRemove}
        isAllocationRemovalPending={filmWorkflow.isAllocationRemovalPending}
      />

      <CaulkAllocationsSection
        entries={visibleCaulkAllocations}
        isPhoneLayout={isPhoneLayout}
        isReadOnlyJob={isReadOnlyJob}
        canOpenAllocateDialog={canAddCaulkAllocation}
        isAuthenticated={auth.isAuthenticated}
        clientIdConfigured={auth.clientIdConfigured}
        pendingCaulkMutation={pendingCaulkMutation}
        openCaulkCheckoutByAllocationId={openCaulkCheckoutByAllocationId}
        productsErrorMessage={
          caulkProductsQuery.isError
            ? caulkProductsQuery.error instanceof Error
              ? caulkProductsQuery.error.message
              : 'Caulk products could not be loaded.'
            : ''
        }
        onOpenAllocateDialog={openAddCaulkAllocationDialog}
        onOpenEdit={openEditCaulkAllocationDialog}
        onOpenCheckout={openCaulkCheckoutDialog}
        onOpenCheckin={openCaulkCheckinDialog}
        onRemove={setCaulkAllocationToRemove}
      />

      <CaulkCheckoutCyclesSection
        entries={caulkCheckouts}
        isPhoneLayout={isPhoneLayout}
        isReadOnlyJob={isReadOnlyJob}
        pendingCaulkMutation={pendingCaulkMutation}
        onOpenCheckin={openCaulkCheckinDialog}
      />

      <JobUsageHistorySection
        entries={usageTimeline}
        isPhoneLayout={isPhoneLayout}
        onOpenFilmBox={(boxId) => navigate(`/inventory/${encodeURIComponent(boxId)}`)}
      />

      <RelatedFilmOrdersSection
        orders={filmOrders}
        isPhoneLayout={isPhoneLayout}
        isReadOnlyJob={isReadOnlyJob}
        pendingDeleteFilmOrderIds={pendingDeleteFilmOrderIds}
        onOrderFilm={(order) => navigate(buildAddBoxTarget(order))}
        onDeleteOrder={lifecycleWorkflow.setFilmOrderToDelete}
      />

      <JobCompletionSection
        canDeleteJob={canDeleteJob}
        isReadOnlyJob={isReadOnlyJob}
        deletePending={deleteJobMutation.isPending}
        completePending={completeJobMutation.isPending}
        pendingCaulkMutation={pendingCaulkMutation}
        completionDisabled={
          deleteJobMutation.isPending ||
          completeJobMutation.isPending ||
          pendingCaulkMutation ||
          hasOutstandingReturnedMaterials ||
          !auth.isAuthenticated ||
          !auth.clientIdConfigured
        }
        completionBlockedMessage={completionBlockedMessage}
        onOpenDelete={() => lifecycleWorkflow.setIsDeleteJobConfirmOpen(true)}
        onOpenComplete={() => lifecycleWorkflow.setIsCompleteConfirmOpen(true)}
      />

      <JobConfirmationDialogs
        jobNumber={summary.jobNumber}
        isDeleteJobConfirmOpen={lifecycleWorkflow.isDeleteJobConfirmOpen}
        deleteJobPending={deleteJobMutation.isPending}
        onCancelDeleteJob={() => lifecycleWorkflow.setIsDeleteJobConfirmOpen(false)}
        onConfirmDeleteJob={() => {
          lifecycleWorkflow.setIsDeleteJobConfirmOpen(false);
          void lifecycleWorkflow.handleDeleteJob();
        }}
        filmOrderToDelete={lifecycleWorkflow.filmOrderToDelete}
        onCancelDeleteFilmOrder={() => lifecycleWorkflow.setFilmOrderToDelete(null)}
        onConfirmDeleteFilmOrder={(order, reason) => {
          lifecycleWorkflow.setFilmOrderToDelete(null);
          void lifecycleWorkflow.handleDeleteFilmOrder(order, reason);
        }}
        allocationToRemove={filmWorkflow.allocationToRemove}
        onCancelRemoveAllocation={() => filmWorkflow.setAllocationToRemove(null)}
        onConfirmRemoveAllocation={(entry, reason) => {
          filmWorkflow.setAllocationToRemove(null);
          void filmWorkflow.handleRemoveAllocation(entry, reason);
        }}
        filmCheckinEntry={filmWorkflow.filmCheckinEntry}
        filmCheckinDialogMessage={filmWorkflow.filmCheckinDialogMessage}
        onCancelFilmCheckin={() => filmWorkflow.setFilmCheckinEntry(null)}
        onConfirmFilmCheckin={(reason) => void filmWorkflow.handleFilmCheckinConfirm(reason)}
        caulkAllocationToRemove={caulkAllocationToRemove}
        onCancelRemoveCaulkAllocation={() => setCaulkAllocationToRemove(null)}
        onConfirmRemoveCaulkAllocation={(entry, reason) => {
          setCaulkAllocationToRemove(null);
          void handleRemoveCaulkAllocation(entry, reason);
        }}
        isCompleteConfirmOpen={lifecycleWorkflow.isCompleteConfirmOpen}
        onCancelCompleteJob={() => lifecycleWorkflow.setIsCompleteConfirmOpen(false)}
        onConfirmCompleteJob={(reason) => {
          lifecycleWorkflow.setIsCompleteConfirmOpen(false);
          void lifecycleWorkflow.handleCompleteJob(reason);
        }}
        isReturnCompletePromptOpen={lifecycleWorkflow.isReturnCompletePromptOpen}
        onCancelReturnCompletePrompt={() => lifecycleWorkflow.setIsReturnCompletePromptOpen(false)}
        onConfirmReturnCompletePrompt={() => {
          lifecycleWorkflow.setIsReturnCompletePromptOpen(false);
          void lifecycleWorkflow.handleCompleteJob(
            'Marked completed after all job materials were returned.'
          );
        }}
        isReopenConfirmOpen={lifecycleWorkflow.isReopenConfirmOpen}
        onCancelReopenJob={() => lifecycleWorkflow.setIsReopenConfirmOpen(false)}
        onConfirmReopenJob={(reason) => {
          lifecycleWorkflow.setIsReopenConfirmOpen(false);
          void lifecycleWorkflow.handleReopenJob(reason);
        }}
      />

      <JobWorkflowDialogs
        caulkAllocationEditor={caulkAllocationEditor}
        setCaulkAllocationEditor={setCaulkAllocationEditor}
        caulkAllocationEditorError={caulkAllocationEditorError}
        setCaulkAllocationEditorError={setCaulkAllocationEditorError}
        pendingCaulkMutation={pendingCaulkMutation}
        caulkRequirements={caulkRequirements}
        caulkAllocations={caulkAllocations}
        caulkProducts={caulkProducts}
        warehouseOptions={warehouseOptions}
        onSubmitCaulkAllocation={() => void handleSubmitCaulkAllocationDialog()}
        caulkCheckoutDraft={caulkCheckoutDraft}
        setCaulkCheckoutDraft={setCaulkCheckoutDraft}
        caulkCheckoutError={caulkCheckoutError}
        setCaulkCheckoutError={setCaulkCheckoutError}
        checkoutCaulkAllocationPending={checkoutCaulkAllocationMutation.isPending}
        onSubmitCaulkCheckout={() => void handleSubmitCaulkCheckoutDialog()}
        caulkCheckinDraft={caulkCheckinDraft}
        setCaulkCheckinDraft={setCaulkCheckinDraft}
        caulkCheckinError={caulkCheckinError}
        setCaulkCheckinError={setCaulkCheckinError}
        checkinCaulkAllocationPending={checkinCaulkAllocationMutation.isPending}
        onSubmitCaulkCheckin={() => void handleSubmitCaulkCheckinDialog()}
        isEditOpen={lifecycleWorkflow.isEditOpen}
        jobNumber={summary.jobNumber}
        warehouse={summary.warehouse}
        sections={summary.sections}
        installDate={summary.installDate}
        crewLeader={summary.crewLeader}
        requirements={requirements}
        filmOrders={filmOrders}
        filmCatalogEntries={filmCatalogQuery.data}
        filmCatalogLoading={filmCatalogQuery.isLoading}
        filmCatalogError={filmCatalogQuery.error}
        caulkProductLoading={caulkProductsQuery.isLoading}
        caulkProductError={caulkProductsQuery.error}
        updateJobPending={updateJobMutation.isPending}
        onCancelEdit={() => lifecycleWorkflow.setIsEditOpen(false)}
        onSubmitEdit={(payload) => void lifecycleWorkflow.handleUpdateJob(payload)}
        pendingLaborOnlyUpdate={lifecycleWorkflow.pendingLaborOnlyUpdate}
        onCancelLaborOnly={() => lifecycleWorkflow.setPendingLaborOnlyUpdate(null)}
        onConfirmLaborOnly={() => {
          if (!lifecycleWorkflow.pendingLaborOnlyUpdate) {
            return;
          }

          void lifecycleWorkflow.submitUpdateJob(lifecycleWorkflow.pendingLaborOnlyUpdate, true);
        }}
        isAllocateOpen={filmWorkflow.isAllocateOpen}
        isExtraFilmMode={isExtraFilmMode}
        onCancelAllocate={filmWorkflow.closeAllocateDialog}
      />
    </>
  );
}
