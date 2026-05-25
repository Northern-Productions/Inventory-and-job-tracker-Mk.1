import { useSearchParams } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { formatDate, formatDateTime } from '../../../lib/date';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';
import { CaulkAllocationsSection } from './allocation-job/CaulkAllocationsSection';
import { CaulkCheckoutCyclesSection } from './allocation-job/CaulkCheckoutCyclesSection';
import { AllocatedBoxesSection } from './allocation-job/AllocatedBoxesSection';
import { JobCompletionSection } from './allocation-job/JobCompletionSection';
import { JobPhasesSection } from './allocation-job/JobPhasesSection';
import { JobUsageHistorySection } from './allocation-job/JobUsageHistorySection';
import { JobConfirmationDialogs } from './allocation-job/JobConfirmationDialogs';
import { JobOverviewHeroSection } from './allocation-job/JobOverviewHeroSection';
import { JobWorkflowDialogs } from './allocation-job/JobWorkflowDialogs';
import { RelatedFilmOrdersSection } from './allocation-job/RelatedFilmOrdersSection';
import { useAllocationJobPageModel } from './allocation-job/useAllocationJobPageModel';

export default function AllocationJobPage() {
  const [searchParams] = useSearchParams();
  const focusedPhaseId = searchParams.get('phaseId') || '';
  const {
    auth,
    canonicalJobId,
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
    isCreateFilmOrderPending,
    isRequirementStatePending,
    isPhaseStatePending,
    isResumeAutoPlanningPending,
    filmAutoAllocatePendingRequirementId,
    caulkAutoAllocatePendingRequirementId,
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
    handleCancelRequirementOrder,
    lifecycleWorkflow,
    filmWorkflow,
    caulkWorkflow,
    isReopenPending,
    isCheckoutAllPending,
    isStagedPickupPending,
    isBoxStatusPending,
    isCheckoutCaulkPending,
    isDeleteJobPending,
    isCompleteJobPending,
    isUpdateJobPending,
    legacyJobNumberAmbiguity,
    openAmbiguousJobCandidate,
    goBackToAllocations,
    openInventoryBox,
    openOrderFilm
  } = useAllocationJobPageModel();
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
    isCaulkTransferPending,
    openAddCaulkAllocationDialog,
    openEditCaulkAllocationDialog,
    handleSubmitCaulkAllocationDialog,
    openCaulkCheckoutDialog,
    handleSubmitCaulkCheckoutDialog,
    openCaulkCheckinDialog,
    handleSubmitCaulkCheckinDialog,
    handleRemoveCaulkAllocation,
    handleReceiveCaulkTransfer,
    handleCancelCaulkTransfer
  } = caulkWorkflow;

  if (jobQuery.isLoading && !detail) {
    return <DeferredLoadingState when label="Loading job details..." />;
  }

  if (legacyJobNumberAmbiguity) {
    return (
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>Choose Job {legacyJobNumberAmbiguity.jobNumber}</h2>
            <p className="muted-text">More than one job uses this number. Choose the Work Scope to continue.</p>
          </div>
          <Button type="button" variant="ghost" onClick={goBackToAllocations}>
            Back to Jobs
          </Button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Work Scope</th>
                <th>Warehouse</th>
                <th>Install Date</th>
                <th>Crew Leader</th>
                <th>Status</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {legacyJobNumberAmbiguity.candidates.map((candidate) => (
                <tr key={candidate.jobId}>
                  <td>{formatJobDisplayLabel(candidate)}</td>
                  <td>{candidate.workScope || candidate.sections || 'Unscoped'}</td>
                  <td>{candidate.warehouse || '--'}</td>
                  <td>{formatDate(candidate.installDate || '')}</td>
                  <td>{candidate.crewLeader || '--'}</td>
                  <td>
                    {candidate.status || candidate.lifecycleStatus ? (
                      <span className={`badge badge-${candidate.status || candidate.lifecycleStatus}`}>
                        {candidate.status || candidate.lifecycleStatus}
                      </span>
                    ) : (
                      '--'
                    )}
                  </td>
                  <td>{formatDateTime(candidate.updatedAt || '')}</td>
                  <td>
                    <Button type="button" size="sm" onClick={() => openAmbiguousJobCandidate(candidate)}>
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  if (jobQuery.isError || !detail || !summary) {
    return (
      <section className="panel">
        <p className="error-text">{jobQuery.error?.message || 'Job not found.'}</p>
        <Button type="button" variant="ghost" onClick={goBackToAllocations}>
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
        caulkTransferAlerts={caulkTransferAlerts}
        isOwner={auth.isOwner}
        editPending={isUpdateJobPending}
        reopenPending={isReopenPending}
        checkoutAllPending={isCheckoutAllPending}
        stagedPickupPending={isStagedPickupPending}
        statusPending={isBoxStatusPending}
        caulkCheckoutPending={isCheckoutCaulkPending}
        onOpenEdit={() => lifecycleWorkflow.setIsEditOpen(true)}
        onOpenReopenConfirm={() => lifecycleWorkflow.setIsReopenConfirmOpen(true)}
        onBack={goBackToAllocations}
        onCheckoutAll={() => void lifecycleWorkflow.handleCheckoutAllMaterials()}
        onToggleStagedPickup={(nextIsStaged) =>
          void lifecycleWorkflow.handleSetStagedPickup(nextIsStaged)
        }
        onOpenTransferBox={openInventoryBox}
      />

      <JobPhasesSection
        phases={phases}
        focusedPhaseId={focusedPhaseId}
        requirements={requirements}
        caulkRequirements={caulkRequirements}
        filmOrders={filmOrders}
        isPhoneLayout={isPhoneLayout}
        isReadOnlyJob={isReadOnlyJob}
        isAuthenticated={auth.isAuthenticated}
        clientIdConfigured={auth.clientIdConfigured}
        canOrderAll={orderableFilmOrderGroups.length > 0 && !isReadOnlyJob && auth.isAuthenticated && auth.clientIdConfigured}
        isCreateFilmOrderPending={isCreateFilmOrderPending}
        isRequirementStatePending={isRequirementStatePending}
        isPhaseStatePending={isPhaseStatePending}
        isResumeAutoPlanningPending={isResumeAutoPlanningPending}
        filmAutoAllocatePendingRequirementId={filmAutoAllocatePendingRequirementId}
        caulkAutoAllocatePendingRequirementId={caulkAutoAllocatePendingRequirementId}
        pendingDeleteFilmOrderIds={pendingDeleteFilmOrderIds}
        onOrderRequirement={(requirement) => void handleOrderFilmRequirement(requirement)}
        onAutoAllocateRequirement={(requirement) => void handleAutoAllocateFilmRequirement(requirement)}
        onAutoAllocateCaulkRequirement={(requirement) => void handleAutoAllocateCaulkRequirement(requirement)}
        onSetRequirementState={(requirement, nextStatus) =>
          void handleSetRequirementState(requirement, nextStatus)
        }
        onSetCaulkRequirementState={(requirement, nextStatus) =>
          void handleSetCaulkRequirementState(requirement, nextStatus)
        }
        onSetPhaseState={(phase, nextStatus) => void handleSetPhaseState(phase, nextStatus)}
        onSetPhaseWorkflowState={(phase, nextWorkflowStatus) =>
          handleSetPhaseWorkflowState(phase, nextWorkflowStatus)
        }
        onResumeAutoPlanning={(requirement) => void handleResumeAutoPlanning(requirement)}
        onResumeCaulkAutoPlanning={(requirement) => void handleResumeCaulkAutoPlanning(requirement)}
        onCancelRequirementOrder={handleCancelRequirementOrder}
        onOrderAll={() => setIsOrderAllConfirmOpen(true)}
      />

      <AllocatedBoxesSection
        entries={visibleAllocations}
        isPhoneLayout={isPhoneLayout}
        isReadOnlyJob={isReadOnlyJob}
        canOpenAllocateDialog={canAllocate}
        allocateButtonLabel={isExtraFilmMode ? 'Allocate Extra' : 'Allocate Film'}
        isAuthenticated={auth.isAuthenticated}
        clientIdConfigured={auth.clientIdConfigured}
        isStatusMutationPending={filmWorkflow.isBoxStatusPending}
        filmTransferAlertsByBoxId={filmTransferAlertsByBoxId}
        isWorkflowActiveAllocation={isActiveFilmAllocationEntry}
        onOpenAllocateDialog={filmWorkflow.openAllocateDialog}
        onOpenBox={openInventoryBox}
        onOpenFilmCheckin={filmWorkflow.openFilmCheckinDialog}
        onCheckoutAllocation={(entry) => void filmWorkflow.handleCheckoutAllocation(entry)}
        onRemoveAllocation={filmWorkflow.setAllocationToRemove}
        isAllocationRemovalPending={filmWorkflow.isAllocationRemovalPending}
      />

      <CaulkAllocationsSection
        entries={visibleCaulkAllocations}
        isPhoneLayout={isPhoneLayout}
        isReadOnlyJob={isReadOnlyJob}
        canManageTransfers={auth.hasFeatureAccess('inventory', 'write')}
        canOpenAllocateDialog={canAddCaulkAllocation}
        isAuthenticated={auth.isAuthenticated}
        clientIdConfigured={auth.clientIdConfigured}
        openCaulkCheckoutByAllocationId={openCaulkCheckoutByAllocationId}
        isWorkflowActiveAllocation={isActiveCaulkAllocationEntry}
        productsErrorMessage={
          caulkProductsQuery.isError
            ? caulkProductsQuery.error instanceof Error
              ? caulkProductsQuery.error.message
              : 'Caulk products could not be loaded.'
            : ''
        }
        isCaulkAllocationPending={caulkWorkflow.isCaulkAllocationPending}
        isCaulkCheckoutPending={caulkWorkflow.isCaulkCheckoutPending}
        isCaulkTransferPending={isCaulkTransferPending}
        onOpenAllocateDialog={openAddCaulkAllocationDialog}
        onOpenEdit={openEditCaulkAllocationDialog}
        onOpenCheckout={openCaulkCheckoutDialog}
        onOpenCheckin={openCaulkCheckinDialog}
        onReceiveTransfer={(entry) => void handleReceiveCaulkTransfer(entry)}
        onCancelTransfer={(entry) => void handleCancelCaulkTransfer(entry)}
        onRemove={setCaulkAllocationToRemove}
      />

      <CaulkCheckoutCyclesSection
        entries={caulkCheckouts}
        isPhoneLayout={isPhoneLayout}
        isReadOnlyJob={isReadOnlyJob}
        isCaulkCheckoutPending={caulkWorkflow.isCaulkCheckoutPending}
        onOpenCheckin={openCaulkCheckinDialog}
      />

      <JobUsageHistorySection
        entries={usageTimeline}
        isPhoneLayout={isPhoneLayout}
        onOpenFilmBox={openInventoryBox}
      />

      <RelatedFilmOrdersSection
        orders={filmOrders}
        isPhoneLayout={isPhoneLayout}
        isReadOnlyJob={isReadOnlyJob}
        pendingDeleteFilmOrderIds={pendingDeleteFilmOrderIds}
        onOrderFilm={openOrderFilm}
        onDeleteOrder={lifecycleWorkflow.setFilmOrderToDelete}
      />

      <JobCompletionSection
        canDeleteJob={canDeleteJob}
        isReadOnlyJob={isReadOnlyJob}
        deletePending={isDeleteJobPending}
        completePending={isCompleteJobPending}
        pendingCaulkMutation={pendingCaulkMutation}
        completionDisabled={
          isDeleteJobPending ||
          isCompleteJobPending ||
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
        deleteJobPending={isDeleteJobPending}
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
        staleFilmOrderPromptOrders={staleFilmOrderPromptOrders}
        onKeepStaleFilmOrders={handleKeepStaleFilmOrders}
        onConfirmCancelStaleFilmOrders={() => void handleCancelStaleFilmOrders()}
        isOrderAllConfirmOpen={isOrderAllConfirmOpen}
        orderableFilmRequirementCount={orderableFilmOrderGroups.length}
        onCancelOrderAll={() => setIsOrderAllConfirmOpen(false)}
        onConfirmOrderAll={() => void handleOrderAllFilmRequirements()}
        allocationToRemove={filmWorkflow.allocationToRemove}
        onCancelRemoveAllocation={() => filmWorkflow.setAllocationToRemove(null)}
        onConfirmRemoveAllocation={(entry, reason) => {
          filmWorkflow.setAllocationToRemove(null);
          void filmWorkflow.handleRemoveAllocation(entry, reason);
        }}
        filmCheckinEntry={filmWorkflow.filmCheckinEntry}
        filmCheckinBox={filmWorkflow.filmCheckinBox}
        filmCheckinInitialDraft={filmWorkflow.filmCheckinDraftOverride}
        filmCheckinBoxLoading={filmWorkflow.filmCheckinBoxLoading}
        filmCheckinBoxError={filmWorkflow.filmCheckinBoxError}
        filmCheckinPending={
          filmWorkflow.filmCheckinEntry
            ? filmWorkflow.isBoxStatusPending(filmWorkflow.filmCheckinEntry.boxId)
            : false
        }
        filmCheckinReleaseJobNumber={summary.jobNumber}
        onCancelFilmCheckin={() => filmWorkflow.setFilmCheckinEntry(null)}
        onConfirmFilmCheckin={(draft) => void filmWorkflow.handleFilmCheckinConfirm(draft)}
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
        canonicalJobId={canonicalJobId}
        caulkAllocationEditor={caulkAllocationEditor}
        setCaulkAllocationEditor={setCaulkAllocationEditor}
        caulkAllocationEditorError={caulkAllocationEditorError}
        setCaulkAllocationEditorError={setCaulkAllocationEditorError}
        pendingCaulkMutation={pendingCaulkMutation}
        caulkAllocationEditorPending={
          caulkAllocationEditor
            ? caulkAllocationEditor.mode === 'edit'
              ? caulkWorkflow.isCaulkAllocationPending(caulkAllocationEditor.caulkAllocationId)
              : false
            : false
        }
        caulkRequirements={caulkRequirements}
        caulkAllocations={caulkAllocations}
        caulkProducts={caulkProducts}
        warehouseOptions={warehouseOptions}
        onSubmitCaulkAllocation={() => void handleSubmitCaulkAllocationDialog()}
        caulkCheckoutDraft={caulkCheckoutDraft}
        setCaulkCheckoutDraft={setCaulkCheckoutDraft}
        caulkCheckoutError={caulkCheckoutError}
        setCaulkCheckoutError={setCaulkCheckoutError}
        checkoutCaulkAllocationPending={
          caulkCheckoutDraft
            ? caulkWorkflow.isCaulkAllocationPending(caulkCheckoutDraft.caulkAllocationId)
            : false
        }
        onSubmitCaulkCheckout={() => void handleSubmitCaulkCheckoutDialog()}
        caulkCheckinDraft={caulkCheckinDraft}
        setCaulkCheckinDraft={setCaulkCheckinDraft}
        caulkCheckinError={caulkCheckinError}
        setCaulkCheckinError={setCaulkCheckinError}
        checkinCaulkAllocationPending={
          caulkCheckinDraft
            ? caulkWorkflow.isCaulkCheckoutPending(
                caulkCheckinDraft.caulkCheckoutId,
                caulkCheckinDraft.caulkAllocationId
              )
            : false
        }
        onSubmitCaulkCheckin={() => void handleSubmitCaulkCheckinDialog()}
        isEditOpen={lifecycleWorkflow.isEditOpen}
        editDraftOverride={lifecycleWorkflow.editDraftOverride}
        jobNumber={summary.jobNumber}
        warehouse={summary.warehouse}
        sections={summary.sections}
        installDate={summary.installDate}
        crewLeader={summary.crewLeader}
        phases={phases}
        requirements={requirements}
        filmOrders={filmOrders}
        filmCatalogEntries={filmCatalogQuery.data}
        filmCatalogLoading={filmCatalogQuery.isLoading}
        filmCatalogError={filmCatalogQuery.error}
        caulkProductLoading={caulkProductsQuery.isLoading}
        caulkProductError={caulkProductsQuery.error}
        updateJobPending={isUpdateJobPending}
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
        onRequirementAllocationApplied={maybeOpenStaleFilmOrderPromptAfterUserChange}
      />
    </>
  );
}
