import { Button } from '../../../components/Button';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { AllocateDialog } from '../components/AllocateDialog';
import { AllocationsPanel } from '../components/AllocationsPanel';
import { BoxForm } from '../components/BoxForm';
import { HistoryPanel } from '../components/HistoryPanel';
import { RollHistoryPanel } from '../components/RollHistoryPanel';
import { BoxConfirmationDialogs } from './box-details/BoxConfirmationDialogs';
import { BoxDetailHeroSection } from './box-details/BoxDetailHeroSection';
import { TransferBoxDialog } from './box-details/TransferBoxDialog';
import { useBoxDetailsPageModel } from './box-details/useBoxDetailsPageModel';

export default function BoxDetailsPage() {
  const {
    auth,
    boxQuery,
    box,
    pendingTransfer,
    isAddBoxPending,
    updateMutation,
    deleteMutation,
    statusMutation,
    filmCatalogQuery,
    allocationsQuery,
    canWriteInventory,
    canWriteAllocations,
    isEditing,
    setIsEditing,
    isAllocateOpen,
    setIsAllocateOpen,
    isAllocationsSectionCollapsed,
    setIsAllocationsSectionCollapsed,
    isHistorySectionCollapsed,
    setIsHistorySectionCollapsed,
    isRollHistorySectionCollapsed,
    setIsRollHistorySectionCollapsed,
    transferDestinationAnalysis,
    displayedAllocatedFeet,
    filmCheckinReleaseJobNumber,
    currentFeetOnRoll,
    shouldBlockEditWhileAllocationsResolve,
    onHandAssetCost,
    checkoutJobOptions,
    initialDraft,
    boxActions,
    isQrSectionOpen,
    setIsQrSectionOpen,
    qrCodeDataUrl,
    qrCodeError,
    handleCopyQrCode,
    handleCopyQrImage,
    handleDownloadQrImage,
    transferWorkflow,
    goBackToInventory,
    openAllocationJob
  } = useBoxDetailsPageModel();

  if (boxQuery.isLoading && !box) {
    return <DeferredLoadingState when label="Loading box details..." />;
  }

  if (!box) {
    return (
      <section className="panel">
        <p className="error-text">{boxQuery.error?.message || 'Box not found.'}</p>
        <Button type="button" variant="ghost" onClick={goBackToInventory}>
          Back to Inventory
        </Button>
      </section>
    );
  }

  return (
    <>
      {isAddBoxPending ? (
        <section className="panel">
          <p className="muted-text">
            Saving box... details are shown optimistically and actions are temporarily disabled.
          </p>
        </section>
      ) : null}
      {isEditing ? (
        <BoxForm
          initialDraft={initialDraft}
          resetKey={`${box.boxId}-${box.status}`}
          mode="edit"
          submitLabel="Save Changes"
          submitting={updateMutation.isPending}
          deleting={deleteMutation.isPending}
          preserveInitialFeetInEdit={Boolean(box.receivedDate)}
          filmCatalogEntries={filmCatalogQuery.data}
          filmCatalogLoading={filmCatalogQuery.isLoading}
          filmCatalogError={filmCatalogQuery.error}
          onSubmit={boxActions.handleEditSubmit}
          onCancel={() => {
            boxActions.resetEditWorkflow();
            setIsEditing(false);
          }}
          onDelete={() => void boxActions.handleDeleteBox()}
        />
      ) : null}

      <BoxDetailHeroSection
        box={box}
        pendingTransfer={pendingTransfer}
        isEditing={isEditing}
        isAddBoxPending={isAddBoxPending}
        shouldBlockEditWhileAllocationsResolve={shouldBlockEditWhileAllocationsResolve}
        transferMutationsPending={transferWorkflow.transferMutationsPending}
        isAuthenticated={auth.isAuthenticated}
        clientIdConfigured={auth.clientIdConfigured}
        canWriteInventory={canWriteInventory}
        canWriteAllocations={canWriteAllocations}
        deletePending={deleteMutation.isPending}
        statusPending={statusMutation.isPending}
        allocationsLoading={allocationsQuery.isLoading}
        currentFeetOnRoll={currentFeetOnRoll}
        displayedAllocatedFeet={displayedAllocatedFeet}
        onHandAssetCost={onHandAssetCost}
        isQrSectionOpen={isQrSectionOpen}
        qrCodeDataUrl={qrCodeDataUrl}
        qrCodeError={qrCodeError}
        onOpenTransferDialog={transferWorkflow.openTransferDialog}
        onStartEdit={() => setIsEditing(true)}
        onOpenLastCheckoutJob={openAllocationJob}
        onSetTransferActionState={transferWorkflow.setTransferActionState}
        onToggleQrSection={() => setIsQrSectionOpen((current) => !current)}
        onCopyQrImage={() => void handleCopyQrImage()}
        onDownloadQrImage={handleDownloadQrImage}
        onCopyQrCode={() => void handleCopyQrCode()}
        onCheckIn={() => void boxActions.handleStatusChange('IN_STOCK')}
        onOpenAllocateDialog={() => setIsAllocateOpen(true)}
        onCheckOut={() => void boxActions.handleStatusChange('CHECKED_OUT')}
      />

      <AllocationsPanel
        boxId={box.boxId}
        feetAvailable={box.feetAvailable}
        collapsed={isAllocationsSectionCollapsed}
        onToggle={() => setIsAllocationsSectionCollapsed((current) => !current)}
      />
      <HistoryPanel
        boxId={box.boxId}
        collapsed={isHistorySectionCollapsed}
        onToggle={() => setIsHistorySectionCollapsed((current) => !current)}
      />
      <RollHistoryPanel
        boxId={box.boxId}
        collapsed={isRollHistorySectionCollapsed}
        onToggle={() => setIsRollHistorySectionCollapsed((current) => !current)}
      />

      <AllocateDialog
        open={isAllocateOpen}
        box={box}
        onCancel={() => setIsAllocateOpen(false)}
      />
      <TransferBoxDialog
        open={transferWorkflow.isTransferDialogOpen}
        currentWarehouse={box.warehouse}
        transferDestination={transferWorkflow.transferDestination}
        transferDestinationOptions={transferWorkflow.transferDestinationOptions}
        transferDestinationAnalysis={transferDestinationAnalysis}
        transferDestinationPrefix={transferWorkflow.transferDestinationPrefix}
        transferDestinationBoxIdOverride={transferWorkflow.transferDestinationBoxIdOverride}
        transferPlan={transferWorkflow.transferPlan}
        transferPlanPending={transferWorkflow.transferPlanPending}
        transferPlanErrorMessage={transferWorkflow.transferPlanErrorMessage}
        transferPlanConflictMessage={transferWorkflow.transferPlanConflictMessage}
        isTransferRenameDialogOpen={transferWorkflow.isTransferRenameDialogOpen}
        isTransferOverridePrefixOnly={transferWorkflow.isTransferOverridePrefixOnly}
        transferNotes={transferWorkflow.transferNotes}
        pending={transferWorkflow.transferMutationsPending}
        onClose={transferWorkflow.closeTransferDialog}
        onOpenRenameDialog={transferWorkflow.openTransferRenameDialog}
        onCloseRenameDialog={transferWorkflow.closeTransferRenameDialog}
        onApplyRenameDialog={transferWorkflow.applyTransferRenameDialog}
        onTransferDestinationChange={transferWorkflow.handleTransferDestinationChange}
        onTransferDestinationBoxIdOverrideChange={
          transferWorkflow.handleTransferDestinationBoxIdOverrideChange
        }
        onTransferNotesChange={transferWorkflow.setTransferNotes}
        onSubmit={() => void transferWorkflow.handleStartTransfer()}
      />
      <BoxConfirmationDialogs
        box={box}
        pendingZeroedEditState={boxActions.pendingZeroedEditState}
        pendingZeroedReactivationState={boxActions.pendingZeroedReactivationState}
        pendingTransfer={pendingTransfer}
        transferActionState={transferWorkflow.transferActionState}
        confirmState={boxActions.confirmState}
        filmCheckinOpen={boxActions.isFilmCheckinOpen}
        filmCheckinPending={statusMutation.isPending}
        filmCheckinReleaseJobNumber={filmCheckinReleaseJobNumber}
        checkoutJobOptions={checkoutJobOptions}
        onCancelZeroedEdit={boxActions.handleCancelZeroedEdit}
        onKeepActiveZeroedEdit={(payload) => void boxActions.handleKeepActiveZeroedEdit(payload)}
        onConfirmZeroedEdit={(payload) => void boxActions.handleConfirmZeroedEdit(payload)}
        onCancelZeroedReactivation={boxActions.handleCancelZeroedReactivation}
        onConfirmZeroedReactivation={(payload) => void boxActions.handleConfirmZeroedReactivation(payload)}
        onCancelTransferAction={() => transferWorkflow.setTransferActionState(null)}
        onConfirmReceiveTransfer={() => void transferWorkflow.handleReceiveTransfer()}
        onConfirmCancelTransfer={() => void transferWorkflow.handleCancelTransfer()}
        onCancelStatusConfirm={boxActions.handleCancelConfirm}
        onCancelFilmCheckin={boxActions.handleCancelFilmCheckin}
        onConfirmFilmCheckin={(draft) => void boxActions.handleFilmCheckinConfirm(draft)}
        onConfirmStatusConfirm={(reason) => void boxActions.handleConfirm(reason)}
      />
    </>
  );
}
