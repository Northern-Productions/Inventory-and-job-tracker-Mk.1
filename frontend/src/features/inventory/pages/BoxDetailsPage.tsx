import { Button } from '../../../components/Button';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { AllocationsPanel } from '../components/AllocationsPanel';
import { BoxForm } from '../components/BoxForm';
import { HistoryPanel } from '../components/HistoryPanel';
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
    receiveOrderedMutation,
    boxDealersQuery,
    filmCatalogQuery,
    allocationsQuery,
    canWriteInventory,
    isEditing,
    setIsEditing,
    isAllocationsSectionCollapsed,
    setIsAllocationsSectionCollapsed,
    isHistorySectionCollapsed,
    setIsHistorySectionCollapsed,
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
    goBackToInventory
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

  const canTransferBoxFromEdit =
    !pendingTransfer &&
    !isAddBoxPending &&
    !shouldBlockEditWhileAllocationsResolve &&
    !transferWorkflow.transferMutationsPending &&
    box.status === 'IN_STOCK' &&
    auth.isAuthenticated &&
    auth.clientIdConfigured &&
    canWriteInventory;

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
          dealerEntries={boxDealersQuery.data}
          dealerLoading={boxDealersQuery.isLoading}
          dealerError={boxDealersQuery.error}
          filmCatalogEntries={filmCatalogQuery.data}
          filmCatalogLoading={filmCatalogQuery.isLoading}
          filmCatalogError={filmCatalogQuery.error}
          onSubmit={boxActions.handleEditSubmit}
          onCancel={() => {
            boxActions.resetEditWorkflow();
            setIsEditing(false);
          }}
          onDelete={() => void boxActions.handleDeleteBox()}
          onTransferBox={transferWorkflow.openTransferDialog}
          transferBoxDisabled={!canTransferBoxFromEdit}
          transferBoxPending={transferWorkflow.transferMutationsPending}
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
        deletePending={deleteMutation.isPending}
        statusPending={statusMutation.isPending || receiveOrderedMutation.isPending}
        allocationsLoading={allocationsQuery.isLoading}
        currentFeetOnRoll={currentFeetOnRoll}
        displayedAllocatedFeet={displayedAllocatedFeet}
        onHandAssetCost={onHandAssetCost}
        isQrSectionOpen={isQrSectionOpen}
        qrCodeDataUrl={qrCodeDataUrl}
        qrCodeError={qrCodeError}
        onStartEdit={() => setIsEditing(true)}
        onSetTransferActionState={transferWorkflow.setTransferActionState}
        onToggleQrSection={() => setIsQrSectionOpen((current) => !current)}
        onCopyQrImage={() => void handleCopyQrImage()}
        onDownloadQrImage={handleDownloadQrImage}
        onCopyQrCode={() => void handleCopyQrCode()}
        onOpenOrderedReceiveDialog={() => boxActions.handleStatusChange('IN_STOCK')}
      />

      <AllocationsPanel
        boxId={box.boxId}
        collapsed={isAllocationsSectionCollapsed}
        onToggle={() => setIsAllocationsSectionCollapsed((current) => !current)}
      />
      <HistoryPanel
        boxId={box.boxId}
        collapsed={isHistorySectionCollapsed}
        onToggle={() => setIsHistorySectionCollapsed((current) => !current)}
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
        orderedReceiveOpen={boxActions.isOrderedReceiveOpen}
        orderedReceivePending={receiveOrderedMutation.isPending}
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
        onCancelOrderedReceive={boxActions.handleCancelOrderedReceive}
        onConfirmFilmCheckin={(draft) => void boxActions.handleFilmCheckinConfirm(draft)}
        onConfirmOrderedReceive={(draft) => void boxActions.handleOrderedReceiveConfirm(draft)}
        onConfirmStatusConfirm={(reason) => void boxActions.handleConfirm(reason)}
      />
    </>
  );
}
