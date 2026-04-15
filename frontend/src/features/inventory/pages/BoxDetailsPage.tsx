import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { useToast } from '../../../components/Toast';
import { type Box } from '../../../domain';
import { safeDecodePathParam } from '../../../lib/url';
import { useAuth } from '../../auth/AuthContext';
import { AllocateDialog } from '../components/AllocateDialog';
import { AllocationsPanel } from '../components/AllocationsPanel';
import { BoxForm } from '../components/BoxForm';
import { HistoryPanel } from '../components/HistoryPanel';
import { RollHistoryPanel } from '../components/RollHistoryPanel';
import {
  useBoxAllocations,
  useBox,
  useBoxTransfer,
  useCancelBoxTransfer,
  useDeleteBox,
  useFilmCatalog,
  useIsAddBoxPending,
  useJobSummariesByNumbers,
  useReceiveBoxTransfer,
  useStartBoxTransfer,
  useSetBoxStatus,
  useUndoAudit,
  useUpdateBox
} from '../hooks/useInventoryQueries';
import { useActionAccess } from '../hooks/useActionAccess';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import {
  boxNeedsAllocationsToResolveCurrentFeet,
  createDraftFromBox,
  deriveCurrentFeetOnRollForBox,
  getDisplayedAllocatedFeetForBox
} from '../utils/boxHelpers';
import { BoxConfirmationDialogs } from './box-details/BoxConfirmationDialogs';
import { BoxDetailHeroSection } from './box-details/BoxDetailHeroSection';
import {
  buildTransferDestinationAnalysis,
  createFallbackBox
} from './box-details/helpers';
import { TransferBoxDialog } from './box-details/TransferBoxDialog';
import { useBoxDetailActions } from './box-details/useBoxDetailActions';
import { useBoxQrCode } from './box-details/useBoxQrCode';
import { useBoxTransferWorkflow } from './box-details/useBoxTransferWorkflow';

export default function BoxDetailsPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const auth = useAuth();
  const ensureActionAccess = useActionAccess();
  const canWriteInventory = auth.hasFeatureAccess('inventory', 'write');
  const canWriteAllocations = auth.hasFeatureAccess('allocations', 'write');
  const boxId = safeDecodePathParam(params.boxId);
  const boxQuery = useBox(boxId);
  const boxTransferQuery = useBoxTransfer(boxId);
  const isAddBoxPending = useIsAddBoxPending(boxId);
  const updateMutation = useUpdateBox();
  const deleteMutation = useDeleteBox();
  const statusMutation = useSetBoxStatus();
  const startTransferMutation = useStartBoxTransfer();
  const receiveTransferMutation = useReceiveBoxTransfer();
  const cancelTransferMutation = useCancelBoxTransfer();
  const undoMutation = useUndoAudit();
  const filmCatalogQuery = useFilmCatalog();
  const allocationsQuery = useBoxAllocations(boxId);
  const warehouseRegistry = useWarehouseRegistry();
  const [isEditing, setIsEditing] = useState(false);
  const [isAllocateOpen, setIsAllocateOpen] = useState(false);
  const [isAllocationsSectionCollapsed, setIsAllocationsSectionCollapsed] = useState(true);
  const [isHistorySectionCollapsed, setIsHistorySectionCollapsed] = useState(true);
  const [isRollHistorySectionCollapsed, setIsRollHistorySectionCollapsed] = useState(true);
  const didHandleScanCheckIn = useRef(false);

  const box = boxQuery.data;
  const transferEntry = boxTransferQuery.data;
  const pendingTransfer = transferEntry?.status === 'PENDING' ? transferEntry : null;
  const allocations = allocationsQuery.data || [];
  const activeAllocationJobNumbers = useMemo(
    () =>
      Array.from(
        new Set(
          allocations
            .filter((entry) => entry.status === 'ACTIVE' && entry.jobNumber.trim())
            .map((entry) => entry.jobNumber.trim())
        )
      ),
    [allocations]
  );
  const activeAllocationJobsQuery = useJobSummariesByNumbers(activeAllocationJobNumbers, {
    enabled: Boolean(box?.boxId)
  });
  const transferDestinationAnalysis = useMemo(
    () =>
      buildTransferDestinationAnalysis(
        box,
        allocations,
        activeAllocationJobsQuery.data || [],
        activeAllocationJobsQuery
      ),
    [activeAllocationJobsQuery, allocations, box]
  );
  const transferDestinationOptions = useMemo(() => {
    const seenCodes = new Set<string>();
    const options = [
      {
        label: 'Select destination warehouse',
        value: ''
      }
    ];

    for (const entry of warehouseRegistry.entries) {
      if (!entry.code || entry.code === box?.warehouse || seenCodes.has(entry.code)) {
        continue;
      }

      seenCodes.add(entry.code);
      options.push({
        label: `${entry.code} · ${entry.name}`,
        value: entry.code
      });
    }

    return options;
  }, [box?.warehouse, warehouseRegistry.entries]);
  const transferMutationsPending =
    startTransferMutation.isPending || receiveTransferMutation.isPending || cancelTransferMutation.isPending;
  const allocationsForCurrentFeet =
    allocationsQuery.isLoading || allocationsQuery.isError ? null : allocations;
  const displayedAllocatedFeet = box
    ? getDisplayedAllocatedFeetForBox(box, allocations)
    : 0;
  const filmCheckinReleaseJobNumber = useMemo(() => {
    const checkoutJob = box?.lastCheckoutJob.trim();
    if (!checkoutJob) {
      return '';
    }

    const checkoutJobKey = checkoutJob.toUpperCase();
    return allocations.some(
      (entry) => entry.status === 'ACTIVE' && entry.jobNumber.trim().toUpperCase() === checkoutJobKey
    )
      ? checkoutJob
      : '';
  }, [allocations, box?.lastCheckoutJob]);
  const currentFeetOnRoll = box ? deriveCurrentFeetOnRollForBox(box, allocationsForCurrentFeet) : null;
  const shouldBlockEditWhileAllocationsResolve = Boolean(
    box &&
      boxNeedsAllocationsToResolveCurrentFeet(box) &&
      (allocationsQuery.isLoading || allocationsQuery.isError)
  );
  const onHandAssetCost =
    box &&
    currentFeetOnRoll !== null &&
    typeof box.pricePerLf === 'number' &&
    Number.isFinite(box.pricePerLf)
      ? Math.max(currentFeetOnRoll, 0) * box.pricePerLf
      : null;
  const checkoutJobOptions = useMemo(() => {
    const activeAllocations = allocations
      .filter((entry) => entry.status === 'ACTIVE' && entry.jobNumber.trim())
      .slice()
      .sort((left, right) => {
        const leftTime = new Date(left.createdAt).getTime();
        const rightTime = new Date(right.createdAt).getTime();

        if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
          return 0;
        }

        if (Number.isNaN(leftTime)) {
          return 1;
        }

        if (Number.isNaN(rightTime)) {
          return -1;
        }

        return leftTime - rightTime;
      });
    const seenJobNumbers = new Set<string>();

    return activeAllocations.reduce<Array<{ label: string; value: string }>>((options, entry) => {
      const jobNumber = entry.jobNumber.trim();
      if (seenJobNumbers.has(jobNumber)) {
        return options;
      }

      seenJobNumbers.add(jobNumber);
      options.push({
        label: jobNumber,
        value: jobNumber
      });
      return options;
    }, []);
  }, [allocations]);
  const initialDraft = useMemo(
    () =>
      box
        ? createDraftFromBox(box, allocationsForCurrentFeet)
        : createDraftFromBox(createFallbackBox(boxId)),
    [allocationsForCurrentFeet, box, boxId]
  );
  function ensureSignedIn(actionLabel: string, feature: 'inventory' | 'allocations' = 'inventory') {
    return ensureActionAccess({
      actionLabel,
      feature,
      requireWriteAccess: true,
      notConfiguredDescription:
        'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before trying to change inventory.',
      signInDescription: `Sign in with email/password before you ${actionLabel}.`
    });
  }
  const boxActions = useBoxDetailActions({
    box,
    boxId,
    allocations,
    allocationsLoading: allocationsQuery.isLoading,
    allocationsError: allocationsQuery.isError,
    checkoutJobOptions,
    ensureSignedIn,
    navigate,
    pushToast: toast.push,
    onEditComplete: () => setIsEditing(false),
    updateBox: updateMutation.mutateAsync,
    deleteBox: deleteMutation.mutateAsync,
    setBoxStatus: statusMutation.mutateAsync,
    undoAudit: undoMutation.mutateAsync
  });
  const {
    isQrSectionOpen,
    setIsQrSectionOpen,
    qrCodeDataUrl,
    qrCodeError,
    handleCopyQrCode,
    handleCopyQrImage,
    handleDownloadQrImage
  } = useBoxQrCode({
    boxId: box?.boxId,
    showQrFromSearchParam: searchParams.get('showQr') === '1',
    pushToast: toast.push
  });
  const transferWorkflow = useBoxTransferWorkflow({
    box,
    pendingTransfer,
    transferDestinationAnalysis,
    warehouseEntries: warehouseRegistry.entries,
    ensureSignedIn,
    pushToast: toast.push,
    startTransfer: startTransferMutation.mutateAsync,
    startTransferPending: startTransferMutation.isPending,
    receiveTransfer: receiveTransferMutation.mutateAsync,
    receiveTransferPending: receiveTransferMutation.isPending,
    cancelTransfer: cancelTransferMutation.mutateAsync,
    cancelTransferPending: cancelTransferMutation.isPending
  });

  useEffect(() => {
    if (!box || !box.boxId) {
      return;
    }
    if (box.boxId === boxId) {
      return;
    }
    const nextSearch = searchParams.toString();
    const nextUrl = nextSearch
      ? `/inventory/${encodeURIComponent(box.boxId)}?${nextSearch}`
      : `/inventory/${encodeURIComponent(box.boxId)}`;
    navigate(nextUrl, { replace: true });
  }, [box, boxId, navigate, searchParams]);

  useEffect(() => {
    setIsAllocationsSectionCollapsed(true);
    setIsHistorySectionCollapsed(true);
    setIsRollHistorySectionCollapsed(true);
  }, [boxId]);

  useEffect(() => {
    if (searchParams.get('scanAction') !== 'checkin' || didHandleScanCheckIn.current || !box) {
      return;
    }

    didHandleScanCheckIn.current = true;

    if (box.status === 'CHECKED_OUT') {
      void boxActions.handleStatusChange('IN_STOCK');
    }
  }, [box, boxActions, searchParams]);

  if (boxQuery.isLoading && !box) {
    return <DeferredLoadingState when label="Loading box details..." />;
  }

  if (!box) {
    return (
      <section className="panel">
        <p className="error-text">{boxQuery.error?.message || 'Box not found.'}</p>
        <Button type="button" variant="ghost" onClick={() => navigate('/')}>
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
        onOpenLastCheckoutJob={(jobNumber) => navigate(`/allocations/${encodeURIComponent(jobNumber)}`)}
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
