import { useQueries } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getJob } from '../../../api/features/jobsClient';
import { APIError } from '../../../api/http';
import { Button } from '../../../components/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { DialogSurface } from '../../../components/DialogSurface';
import { Input, TextArea } from '../../../components/Input';
import { Select } from '../../../components/Select';
import { useToast } from '../../../components/Toast';
import {
  WAREHOUSE_CODES,
  getWarehouseLabel,
  type Box,
  type SetBoxStatusPayload,
  type UpdateBoxPayload,
  type Warehouse
} from '../../../domain';
import { formatDate } from '../../../lib/date';
import { safeDecodePathParam } from '../../../lib/url';
import { useAuth } from '../../auth/AuthContext';
import { AllocateDialog } from '../components/AllocateDialog';
import { AllocationsPanel } from '../components/AllocationsPanel';
import { BoxForm } from '../components/BoxForm';
import { HistoryPanel } from '../components/HistoryPanel';
import { RollHistoryPanel } from '../components/RollHistoryPanel';
import {
  useBoxAllocations,
  useBoxTransfer,
  useCancelBoxTransfer,
  useFilmCatalog,
  useIsAddBoxPending,
  useBox,
  useReceiveBoxTransfer,
  useDeleteBox,
  useSetBoxStatus,
  useStartBoxTransfer,
  useUndoAudit,
  useUpdateBox
} from '../hooks/useInventoryQueries';
import { useActionAccess } from '../hooks/useActionAccess';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { parseUpdateBoxDraft } from '../schemas/boxSchemas';
import {
  boxNeedsAllocationsToResolveCurrentFeet,
  createDraftFromBox,
  deriveCurrentFeetOnRollForBox,
  deriveFeetAvailableFromRollWeight,
  getDisplayedAllocatedFeetForBox,
  type BoxDraft
} from '../utils/boxHelpers';
import {
  confirmWarnings,
  getAddOrEditWarnings,
  getCheckInWarnings,
  getCheckoutWarnings
} from '../utils/boxWarnings';
import {
  buildZeroedInventoryPayloadForEdit,
  buildZeroedInventoryReactivationPayloadForEdit,
  buildZeroedInventoryWarningMessage,
  ZEROED_BOX_REACTIVATION_PROMPT,
  getZeroedInventoryEditTrigger,
  getIncompleteBoxHistoryFieldsForZeroedEdit,
  shouldPromptZeroedInventoryReactivationOnEdit,
  type ZeroedInventoryEditTrigger
} from '../utils/boxZeroedTransition';

type ConfirmState =
  | {
      type: 'checkout';
      payload: SetBoxStatusPayload;
      message: string;
    }
  | {
      type: 'checkin';
      payload: SetBoxStatusPayload;
      message: string;
    }
  | null;

interface PendingZeroedEditState {
  payload: UpdateBoxPayload;
  missingFields: string[];
  trigger: ZeroedInventoryEditTrigger;
}

interface PendingZeroedReactivationState {
  payload: UpdateBoxPayload;
}

type TransferActionState = 'receive' | 'cancel' | null;

interface TransferDestinationAnalysis {
  suggestedDestination: Warehouse | '';
  conflictMessage: string;
  isResolvingAllocations: boolean;
  resolutionWarning: string;
}

function DetailField({
  label,
  value,
  labelClassName = ''
}: {
  label: string;
  value: ReactNode;
  labelClassName?: string;
}) {
  return (
    <div className="key-value">
      <dt className={labelClassName}>{label}</dt>
      <dd>{value === '' || value === null ? '--' : value}</dd>
    </div>
  );
}

function createStatusConfirmState(
  boxId: string,
  status: SetBoxStatusPayload['status'],
  message: string
): Exclude<ConfirmState, null> {
  return {
    type: status === 'CHECKED_OUT' ? 'checkout' : 'checkin',
    payload: {
      boxId,
      status
    },
    message
  };
}

const USD_CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});

function formatUsdAmount(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '--';
  }
  return USD_CURRENCY_FORMATTER.format(value);
}

function formatPricePerLf(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '--';
  }
  return `${USD_CURRENCY_FORMATTER.format(value)} / LF`;
}

function formatBoxStatusLabel(status: string) {
  return status === 'TRANSFER' ? 'Transfer' : status.replace(/_/g, ' ');
}

function buildTransferDestinationAnalysis(
  box: Box | undefined,
  allocations: Array<{ status: string; jobNumber: string }>,
  allocationJobs: Array<{ summary?: { warehouse?: Warehouse } } | null>,
  allocationQueryStates: Array<{ isLoading?: boolean; isFetching?: boolean; isError?: boolean }>
): TransferDestinationAnalysis {
  if (!box) {
    return {
      suggestedDestination: '',
      conflictMessage: '',
      isResolvingAllocations: false,
      resolutionWarning: ''
    };
  }

  const activeJobAllocations = allocations.filter(
    (entry) => entry.status === 'ACTIVE' && entry.jobNumber.trim()
  );

  if (!activeJobAllocations.length) {
    return {
      suggestedDestination: '',
      conflictMessage: '',
      isResolvingAllocations: false,
      resolutionWarning: ''
    };
  }

  const isResolvingAllocations = allocationQueryStates.some(
    (query) => query.isLoading || query.isFetching
  );

  if (isResolvingAllocations) {
    return {
      suggestedDestination: '',
      conflictMessage: '',
      isResolvingAllocations: true,
      resolutionWarning: ''
    };
  }

  if (allocationQueryStates.some((query) => query.isError)) {
    return {
      suggestedDestination: '',
      conflictMessage: '',
      isResolvingAllocations: false,
      resolutionWarning:
        'Some allocation destinations could not be loaded. You can still try the transfer and the server will verify it.'
    };
  }

  const destinationWarehouses = new Set<Warehouse>();
  let hasSameWarehouseAllocation = false;

  for (let index = 0; index < activeJobAllocations.length; index += 1) {
    const destinationWarehouse = allocationJobs[index]?.summary?.warehouse;
    if (!destinationWarehouse) {
      continue;
    }

    if (destinationWarehouse === box.warehouse) {
      hasSameWarehouseAllocation = true;
      continue;
    }

    destinationWarehouses.add(destinationWarehouse);
  }

  if (hasSameWarehouseAllocation) {
    return {
      suggestedDestination: '',
      conflictMessage:
        'This box is still allocated to a job in its current warehouse. Remove that allocation before starting a transfer.',
      isResolvingAllocations: false,
      resolutionWarning: ''
    };
  }

  if (destinationWarehouses.size > 1) {
    return {
      suggestedDestination: '',
      conflictMessage:
        'This box is allocated to jobs in more than one destination warehouse. Remove the conflicting allocations before starting a transfer.',
      isResolvingAllocations: false,
      resolutionWarning: ''
    };
  }

  return {
    suggestedDestination: destinationWarehouses.size === 1 ? Array.from(destinationWarehouses)[0] : '',
    conflictMessage: '',
    isResolvingAllocations: false,
    resolutionWarning: ''
  };
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  const didCopy = document.execCommand('copy');
  document.body.removeChild(textarea);

  if (!didCopy) {
    throw new Error('Clipboard access is not available.');
  }
}

async function createBlobFromDataUrl(dataUrl: string) {
  const response = await fetch(dataUrl);
  return response.blob();
}

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
  const [isTransferDialogOpen, setIsTransferDialogOpen] = useState(false);
  const [transferDestination, setTransferDestination] = useState<Warehouse | ''>('');
  const [transferNotes, setTransferNotes] = useState('');
  const [transferActionState, setTransferActionState] = useState<TransferActionState>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const [pendingZeroedEditState, setPendingZeroedEditState] = useState<PendingZeroedEditState | null>(null);
  const [pendingZeroedReactivationState, setPendingZeroedReactivationState] =
    useState<PendingZeroedReactivationState | null>(null);
  const [isQrSectionOpen, setIsQrSectionOpen] = useState(() => searchParams.get('showQr') === '1');
  const [isAllocationsSectionCollapsed, setIsAllocationsSectionCollapsed] = useState(true);
  const [isHistorySectionCollapsed, setIsHistorySectionCollapsed] = useState(true);
  const [isRollHistorySectionCollapsed, setIsRollHistorySectionCollapsed] = useState(true);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [qrCodeError, setQrCodeError] = useState('');
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
  const activeAllocationJobQueries = useQueries({
    queries: activeAllocationJobNumbers.map((jobNumber) => ({
      queryKey: inventoryKeys.job(jobNumber),
      queryFn: () => getJob(jobNumber),
      enabled: Boolean(box?.boxId)
    }))
  });
  const transferDestinationAnalysis = useMemo(
    () =>
      buildTransferDestinationAnalysis(
        box,
        allocations,
        activeAllocationJobQueries.map((query) => query.data || null),
        activeAllocationJobQueries
      ),
    [activeAllocationJobQueries, allocations, box]
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
    setPendingZeroedEditState(null);
    setPendingZeroedReactivationState(null);
    setIsTransferDialogOpen(false);
    setTransferActionState(null);
    setTransferDestination('');
    setTransferNotes('');
    setIsAllocationsSectionCollapsed(true);
    setIsHistorySectionCollapsed(true);
    setIsRollHistorySectionCollapsed(true);
  }, [boxId]);

  useEffect(() => {
    if (!box?.boxId) {
      return;
    }

    if (searchParams.get('showQr') === '1') {
      setIsQrSectionOpen(true);
    }
  }, [box?.boxId, searchParams]);

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

  useEffect(() => {
    let isActive = true;

    if (!box?.boxId) {
      setQrCodeDataUrl('');
      setQrCodeError('');
      return () => {
        isActive = false;
      };
    }

    setQrCodeDataUrl('');
    setQrCodeError('');

    void QRCode.toDataURL(box.boxId, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
      color: {
        dark: '#12343b',
        light: '#ffffffff'
      }
    })
      .then((nextDataUrl: string) => {
        if (!isActive) {
          return;
        }

        setQrCodeDataUrl(nextDataUrl);
      })
      .catch(() => {
        if (!isActive) {
          return;
        }

        setQrCodeError('The QR image could not be generated. You can still copy the BoxID text.');
      });

    return () => {
      isActive = false;
    };
  }, [box?.boxId]);

  async function handleCopyQrCode() {
    if (!box) {
      return;
    }

    try {
      await copyTextToClipboard(box.boxId);
      toast.push({
        title: 'QR code copied',
        description: `${box.boxId} is ready to paste into your label software.`,
        variant: 'success'
      });
    } catch (_error) {
      toast.push({
        title: 'Copy failed',
        description: 'Clipboard access is unavailable. Copy the BoxID manually from the QR code section.',
        variant: 'error'
      });
    }
  }

  async function handleCopyQrImage() {
    if (!box || !qrCodeDataUrl) {
      return;
    }

    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      toast.push({
        title: 'Image copy is not supported',
        description: 'Use Download QR PNG or Copy QR Code on this device/browser.',
        variant: 'error'
      });
      return;
    }

    try {
      const imageBlob = await createBlobFromDataUrl(qrCodeDataUrl);
      await navigator.clipboard.write([
        new ClipboardItem({
          [imageBlob.type]: imageBlob
        })
      ]);

      toast.push({
        title: 'QR image copied',
        description: `${box.boxId} is ready to paste into your label software.`,
        variant: 'success'
      });
    } catch (_error) {
      toast.push({
        title: 'Image copy failed',
        description: 'Use Download QR PNG or Copy QR Code instead.',
        variant: 'error'
      });
    }
  }

  function handleDownloadQrImage() {
    if (!box || !qrCodeDataUrl) {
      return;
    }

    const link = document.createElement('a');
    link.href = qrCodeDataUrl;
    link.download = `${box.boxId}-qr.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  async function pushUndoToast(
    logId: string,
    title: string,
    boxIdValue: string,
    warnings: string[],
    successDescription = `${boxIdValue} was saved successfully.`,
    onUndoSuccess?: (restoredBox: Box | null) => void
  ) {
    toast.push({
      title,
      description: warnings.join(' ') || successDescription,
      actionLabel: 'Undo',
      onAction: async () => {
        try {
          const undone = await undoMutation.mutateAsync({
            logId,
            reason: 'Undo from success toast'
          });

          toast.push({
            title: 'Undo completed',
            description: undone.warnings.join(' ') || `${boxIdValue} was reverted.`,
            variant: 'success'
          });
          onUndoSuccess?.(undone.result.box);
        } catch (error) {
          toast.push({
            title: 'Undo failed',
            description:
              error instanceof Error ? error.message : 'The undo request could not be completed.',
            variant: 'error'
          });
        }
      }
    });
  }

  async function handleDeleteBox() {
    if (!box) {
      return;
    }

    if (!ensureSignedIn('delete this box', 'inventory')) {
      return;
    }

    try {
      const deletePromise = deleteMutation.mutateAsync({
        boxId: box.boxId,
        reason: 'Deleted from box details.'
      });
      navigate('/', { replace: true });
      await deletePromise;
    } catch (error) {
      navigate(`/inventory/${encodeURIComponent(box.boxId)}`, { replace: true });
      toast.push({
        title: 'Delete failed',
        description:
          error instanceof APIError || error instanceof Error
            ? error.message
            : 'The box could not be deleted.',
        variant: 'error'
      });
    }
  }

  function openTransferDialog() {
    if (!box) {
      return;
    }

    setTransferNotes('');
    setTransferDestination(transferDestinationAnalysis.suggestedDestination || '');
    setIsTransferDialogOpen(true);
  }

  function closeTransferDialog() {
    setIsTransferDialogOpen(false);
    setTransferNotes('');
    setTransferDestination('');
  }

  async function handleStartTransfer() {
    if (!box) {
      return;
    }

    if (!ensureSignedIn('start box transfers', 'inventory')) {
      return;
    }

    if (!transferDestination) {
      toast.push({
        title: 'Destination required',
        description: 'Choose the warehouse this box is being sent to before starting the transfer.',
        variant: 'error'
      });
      return;
    }

    try {
      const { result, warnings } = await startTransferMutation.mutateAsync({
        boxId: box.boxId,
        toWarehouse: transferDestination,
        notes: transferNotes.trim() || undefined
      });
      closeTransferDialog();
      toast.push({
        title: 'Transfer started',
        description:
          warnings.join(' ') ||
          `${result.box.boxId} is now marked for transfer from ${result.transfer.sourceWarehouse} to ${result.transfer.destinationWarehouse}.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to start transfer',
        description: error instanceof Error ? error.message : 'The transfer could not be started.',
        variant: 'error'
      });
    }
  }

  async function handleReceiveTransfer() {
    if (!pendingTransfer) {
      return;
    }

    if (!ensureSignedIn('receive box transfers', 'inventory')) {
      return;
    }

    try {
      const { result, warnings } = await receiveTransferMutation.mutateAsync({
        transferId: pendingTransfer.transferId
      });
      setTransferActionState(null);
      toast.push({
        title: 'Transfer received',
        description:
          warnings.join(' ') ||
          `${result.transfer.sourceBoxId} was received into ${result.transfer.destinationWarehouse} as ${result.box.boxId}.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to receive transfer',
        description: error instanceof Error ? error.message : 'The transfer could not be received.',
        variant: 'error'
      });
    }
  }

  async function handleCancelTransfer() {
    if (!pendingTransfer) {
      return;
    }

    if (!ensureSignedIn('cancel box transfers', 'inventory')) {
      return;
    }

    try {
      const { result, warnings } = await cancelTransferMutation.mutateAsync({
        transferId: pendingTransfer.transferId,
        reason: 'Cancelled from box details.'
      });
      setTransferActionState(null);
      const cancellationSummary =
        result.cancelledAllocationCount > 0
          ? `Cancelled ${result.cancelledAllocationCount} cross-warehouse allocation${result.cancelledAllocationCount === 1 ? '' : 's'} and released ${result.releasedFeet} LF.`
          : `${result.box.boxId} is back in stock in ${result.transfer.sourceWarehouse}.`;
      toast.push({
        title: 'Transfer cancelled',
        description: warnings.join(' ') || cancellationSummary,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to cancel transfer',
        description: error instanceof Error ? error.message : 'The transfer could not be cancelled.',
        variant: 'error'
      });
    }
  }

  async function submitUpdate(payload: UpdateBoxPayload) {
    try {
      const { result, warnings } = await updateMutation.mutateAsync(payload);
      setIsEditing(false);

      const didMoveToZeroed = result.box.status === 'ZEROED';
      const wasZeroedBeforeUpdate = box?.status === 'ZEROED';
      const didTransitionToZeroed = didMoveToZeroed && !wasZeroedBeforeUpdate;
      const successTitle = didTransitionToZeroed ? 'Moved to zeroed out inventory' : 'Box updated';
      const successDescription = didTransitionToZeroed
        ? `${result.box.boxId} was moved to zeroed out inventory.`
        : undefined;

      await pushUndoToast(result.logId, successTitle, result.box.boxId, warnings, successDescription);

      if (didTransitionToZeroed) {
        navigate('/');
      }
    } catch (error) {
      toast.push({
        title: 'Update failed',
        description:
          error instanceof APIError || error instanceof Error
            ? error.message
            : 'The update could not be completed.',
        variant: 'error'
      });
    }
  }

  async function runStandardUpdateFlow(payload: UpdateBoxPayload) {
    const addOrEditWarnings = getAddOrEditWarnings(payload, box, allocations);
    if (!confirmWarnings(addOrEditWarnings)) {
      return;
    }

    await submitUpdate({
      ...payload,
      auditNote:
        payload.auditNote?.trim() ||
        (payload.moveToZeroed ? 'Confirmed zeroed inventory edit save' : 'Inventory metadata update')
    });
  }

  async function handleEditSubmit(draft: BoxDraft) {
    if (!ensureSignedIn('save box changes', 'inventory')) {
      return;
    }

    try {
      if (draft.receivedDate && (allocationsQuery.isLoading || allocationsQuery.isError)) {
        toast.push({
          title: 'Allocation data unavailable',
          description: allocationsQuery.isLoading
            ? 'Wait for allocation data to finish loading, then try saving again.'
            : 'Refresh the box allocations and try saving again.',
          variant: 'error'
        });
        return;
      }

      const payload = parseUpdateBoxDraft(draft, box, allocations);
      if (shouldPromptZeroedInventoryReactivationOnEdit(box, payload)) {
        setPendingZeroedReactivationState({
          payload: buildZeroedInventoryReactivationPayloadForEdit(payload)
        });
        return;
      }

      const zeroedTrigger = getZeroedInventoryEditTrigger(box, payload);

      if (zeroedTrigger) {
        setPendingZeroedEditState({
          payload: buildZeroedInventoryPayloadForEdit(box, payload, zeroedTrigger),
          missingFields: getIncompleteBoxHistoryFieldsForZeroedEdit(box, payload),
          trigger: zeroedTrigger
        });
        return;
      }

      await runStandardUpdateFlow(payload);
    } catch (error) {
      toast.push({
        title: 'Validation failed',
        description:
          error instanceof Error ? error.message : 'Review the form values and try again.',
        variant: 'error'
      });
    }
  }

  async function handleStatusChange(status: SetBoxStatusPayload['status']) {
    if (!box) {
      return;
    }

    if (!ensureSignedIn('change box status', 'inventory')) {
      return;
    }

    if (status === 'CHECKED_OUT') {
      const checkoutMessage =
        checkoutJobOptions.length > 0
          ? "Select one of this box's active allocated jobs, or choose Enter New Job Number if this checkout is for something else."
          : 'Enter the job number for this checkout. It will be saved in the box history.';

      setConfirmState(
        createStatusConfirmState(box.boxId, status, checkoutMessage)
      );
      return;
    }

    setConfirmState(
      createStatusConfirmState(
        box.boxId,
        status,
        'Enter the latest roll weight in pounds to complete the check-in.'
      )
    );
  }

  function handleCancelConfirm() {
    setConfirmState(null);
  }

  async function handleConfirm(reason: string) {
    if (!confirmState) {
      return;
    }

    if (!box) {
      setConfirmState(null);
      return;
    }

    if (confirmState.type === 'checkout') {
      const warnings = getCheckoutWarnings(box);
      if (!confirmWarnings(warnings)) {
        return;
      }

      const payload = {
        ...confirmState.payload,
        auditNote: `Checked out for job ${reason}`
      };

      try {
        setConfirmState(null);
        const { result, warnings: responseWarnings } = await statusMutation.mutateAsync(payload);
        await pushUndoToast(result.logId, 'Box checked out', result.box.boxId, responseWarnings);
      } catch (error) {
        toast.push({
          title: 'Status change failed',
          description:
            error instanceof Error ? error.message : 'The status update could not be completed.',
          variant: 'error'
        });
      }

      return;
    }

    const parsedWeight = Number(reason);
    if (!Number.isFinite(parsedWeight) || parsedWeight < 0) {
      toast.push({
        title: 'Roll weight required',
        description: 'Enter a valid non-negative roll weight in pounds before checking the box in.',
        variant: 'error'
      });
      return;
    }

    const checkInWarnings = getCheckInWarnings(box, parsedWeight);
    if (!confirmWarnings(checkInWarnings)) {
      return;
    }

    const payload = {
      ...confirmState.payload,
      lastRollWeightLbs: parsedWeight,
      auditNote: `Checked in at ${parsedWeight} lbs`
    };

    try {
      const priorCheckoutJobNumber = box.lastCheckoutJob.trim();
      setConfirmState(null);

      const { result, warnings } = await statusMutation.mutateAsync(payload);
      const returnedBox = result.box;
      const didPersistWeight = returnedBox.lastRollWeightLbs === parsedWeight;
      const didPersistFeet =
        returnedBox.coreWeightLbs !== null && returnedBox.lfWeightLbsPerFt !== null
          ? returnedBox.feetAvailable <=
            deriveFeetAvailableFromRollWeight(
              parsedWeight,
              returnedBox.coreWeightLbs,
              returnedBox.lfWeightLbsPerFt,
              returnedBox.initialFeet
            )
          : true;

      if (!didPersistWeight || !didPersistFeet) {
        toast.push({
          title: 'Check-in did not apply the new roll weight',
          description:
            'The backend responded without saving the submitted weight. Refresh the app and try again. If it persists, redeploy the latest Supabase API function and frontend build.',
          variant: 'error'
        });
        return;
      }

      const didMoveToZeroed = result.box.status === 'ZEROED';
      await pushUndoToast(
        result.logId,
        didMoveToZeroed ? 'Moved to zeroed out inventory' : 'Box checked in',
        result.box.boxId,
        warnings,
        didMoveToZeroed ? `${result.box.boxId} was moved to zeroed out inventory.` : undefined
      );

      if (!priorCheckoutJobNumber && didMoveToZeroed) {
        navigate('/');
      }
    } catch (error) {
      toast.push({
        title: 'Status change failed',
        description:
          error instanceof Error ? error.message : 'The status update could not be completed.',
        variant: 'error'
      });
    }
  }

  useEffect(() => {
    if (searchParams.get('scanAction') !== 'checkin' || didHandleScanCheckIn.current || !box) {
      return;
    }

    didHandleScanCheckIn.current = true;

    if (box.status === 'CHECKED_OUT') {
      void handleStatusChange('IN_STOCK');
    }
  }, [box, searchParams]);

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
          onSubmit={handleEditSubmit}
          onCancel={() => {
            setPendingZeroedEditState(null);
            setPendingZeroedReactivationState(null);
            setIsEditing(false);
          }}
          onDelete={() => void handleDeleteBox()}
        />
      ) : null}

      <section className="panel detail-hero">
        <p className="eyebrow">Box Details</p>
        <div className="panel-title-row detail-title-row">
          <div>
            <h2>{box.boxId}</h2>
            <p className="warehouse-pill">
              {getWarehouseLabel(box.warehouse)} warehouse
            </p>
          </div>
          <div className="detail-actions">
            <span className={`badge badge-${box.status}`}>{formatBoxStatusLabel(box.status)}</span>
            {!isEditing ? (
              !pendingTransfer ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={openTransferDialog}
                  disabled={
                    isAddBoxPending ||
                    shouldBlockEditWhileAllocationsResolve ||
                    transferMutationsPending ||
                    box.status !== 'IN_STOCK' ||
                    !auth.isAuthenticated ||
                    !auth.clientIdConfigured ||
                    !canWriteInventory
                  }
                >
                  Transfer Box
                </Button>
              ) : null
            ) : null}
            {!isEditing ? (
              <Button
                type="button"
                onClick={() => setIsEditing(true)}
                disabled={
                  isAddBoxPending ||
                  deleteMutation.isPending ||
                  transferMutationsPending ||
                  shouldBlockEditWhileAllocationsResolve ||
                  box.status === 'TRANSFER' ||
                  !auth.isAuthenticated ||
                  !auth.clientIdConfigured ||
                  !canWriteInventory
                }
              >
                Edit
              </Button>
            ) : null}
          </div>
        </div>

        <div className="detail-highlight-grid stat-grid">
          <div className="key-value">
            <dt className="detail-label-pill detail-label-pill-green">On Hand Feet</dt>
            <dd>{currentFeetOnRoll === null ? '...' : currentFeetOnRoll}</dd>
          </div>
          <div className="key-value">
            <dt className="detail-label-pill detail-label-pill-green">Available Feet</dt>
            <dd>{box.feetAvailable}</dd>
          </div>
          <div className="key-value">
            <dt className="detail-label-pill detail-label-pill-red">Allocated Feet</dt>
            <dd>{allocationsQuery.isLoading ? '...' : displayedAllocatedFeet}</dd>
          </div>
          <div className="key-value">
            <dt>On-Hand Asset Cost</dt>
            <dd>{currentFeetOnRoll === null ? '...' : formatUsdAmount(onHandAssetCost)}</dd>
          </div>
        </div>

        <div className="detail-grid detail-grid-secondary">
          <DetailField label="Manufacturer" value={box.manufacturer} />
          <DetailField label="Film Name" value={box.filmName} />
          <DetailField
            label="Width"
            value={box.widthIn}
            labelClassName="detail-label-pill detail-label-pill-orange"
          />
          <DetailField label="Initial Feet" value={box.initialFeet} />
          <DetailField label="Current Feet" value={currentFeetOnRoll === null ? '...' : currentFeetOnRoll} />
          <DetailField label="Lot Run" value={box.lotRun} />
          <DetailField label="Order Date" value={formatDate(box.orderDate)} />
          <DetailField label="Received Date" value={formatDate(box.receivedDate)} />
          <DetailField label="Initial Weight" value={box.initialWeightLbs} />
          <DetailField label="Last Roll Weight" value={box.lastRollWeightLbs} />
          <DetailField label="Last Weighed Date" value={formatDate(box.lastWeighedDate)} />
          <DetailField label="Core Type" value={box.coreType} />
          <DetailField label="Core Weight" value={box.coreWeightLbs} />
          <DetailField label="LF Weight / Ft" value={box.lfWeightLbsPerFt} />
          <DetailField label="Price / LF" value={formatPricePerLf(box.pricePerLf)} />
          <DetailField label="Purchase Cost" value={formatUsdAmount(box.purchaseCost)} />
          <DetailField
            label="Last Checkout Job"
            value={
              box.status === 'CHECKED_OUT' && box.lastCheckoutJob ? (
                <button
                  type="button"
                  className="row-button"
                  onClick={() => navigate(`/allocations/${encodeURIComponent(box.lastCheckoutJob)}`)}
                >
                  {box.lastCheckoutJob}
                </button>
              ) : (
                box.lastCheckoutJob
              )
            }
          />
          <DetailField label="Last Checkout Date" value={formatDate(box.lastCheckoutDate)} />
          <DetailField label="Zeroed Date" value={formatDate(box.zeroedDate)} />
          <DetailField label="Zeroed Reason" value={box.zeroedReason} />
          <DetailField label="Zeroed By" value={box.zeroedBy} />
          <DetailField label="Notes" value={box.notes} />
        </div>

        {pendingTransfer ? (
          <div className="transfer-status-card">
            <div className="panel-title-row">
              <div className="transfer-status-copy">
                <p className="eyebrow">Pending Transfer</p>
                <h3>{pendingTransfer.sourceBoxId} is moving warehouses</h3>
                <p className="muted-text">
                  Receive this transfer in {pendingTransfer.destinationWarehouse} before the box can be checked out or staged on a cross-warehouse job.
                </p>
              </div>
              <div className="detail-actions transfer-status-actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setTransferActionState('receive')}
                  disabled={
                    transferMutationsPending ||
                    !auth.isAuthenticated ||
                    !auth.clientIdConfigured ||
                    !canWriteInventory
                  }
                >
                  Receive Box
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => setTransferActionState('cancel')}
                  disabled={
                    transferMutationsPending ||
                    !auth.isAuthenticated ||
                    !auth.clientIdConfigured ||
                    !canWriteInventory
                  }
                >
                  Cancel Transfer
                </Button>
              </div>
            </div>
            <div className="detail-grid detail-grid-secondary transfer-status-grid">
              <DetailField label="Current Warehouse" value={pendingTransfer.sourceWarehouse} />
              <DetailField label="Destination Warehouse" value={pendingTransfer.destinationWarehouse} />
              <DetailField label="Current Box ID" value={pendingTransfer.sourceBoxId} />
              <DetailField label="Received Box ID" value={pendingTransfer.destinationBoxId} />
              <DetailField label="Transfer ID" value={pendingTransfer.transferId} />
              <DetailField label="Started" value={formatDate(pendingTransfer.createdAt)} />
              <DetailField label="Started By" value={pendingTransfer.createdBy} />
              <DetailField label="Notes" value={pendingTransfer.notes} />
            </div>
          </div>
        ) : null}

        <div className={`qr-code-card ${isQrSectionOpen ? 'qr-code-card-open' : 'qr-code-card-closed'}`}>
          <button
            type="button"
            className="qr-code-toggle"
            onClick={() => setIsQrSectionOpen((current) => !current)}
            aria-expanded={isQrSectionOpen}
          >
            <span className="qr-code-toggle-label">QR Code</span>
            <span className="qr-code-toggle-symbol" aria-hidden="true">
              {isQrSectionOpen ? '-' : '+'}
            </span>
          </button>
          <div
            className={`qr-code-card-body ${isQrSectionOpen ? 'qr-code-card-body-open' : 'qr-code-card-body-closed'}`}
            aria-hidden={!isQrSectionOpen}
          >
            <div className="qr-code-preview">
              {qrCodeDataUrl ? (
                <img
                  src={qrCodeDataUrl}
                  alt={`QR code for box ${box.boxId}`}
                  className="qr-code-image"
                />
              ) : (
                <div className="qr-code-placeholder">
                  {qrCodeError ? 'QR unavailable' : 'Generating QR...'}
                </div>
              )}
            </div>
            <div className="qr-code-meta">
              <p className="muted-text">
                Copy the image for supported label software, download a PNG, or copy the raw BoxID
                text. The QR contains only the BoxID.
              </p>
              <div className="qr-code-actions">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleCopyQrImage()}
                  disabled={!qrCodeDataUrl || !isQrSectionOpen}
                >
                  Copy QR Image
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleDownloadQrImage}
                  disabled={!qrCodeDataUrl || !isQrSectionOpen}
                >
                  Download QR PNG
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void handleCopyQrCode()}
                  disabled={!isQrSectionOpen}
                >
                  Copy QR Code
                </Button>
              </div>
              <p className="qr-code-value">{box.boxId}</p>
              {qrCodeError ? <p className="error-text">{qrCodeError}</p> : null}
            </div>
          </div>
        </div>

        {!isEditing ? (
          <>
            {!auth.isAuthenticated ? (
              <p className="muted-text">Sign in with email/password before making changes.</p>
            ) : null}
            {auth.isAuthenticated && !canWriteInventory ? (
              <p className="muted-text">
                You can view this box, but your role does not allow inventory edits.
              </p>
            ) : null}
            {auth.isAuthenticated && canWriteInventory && shouldBlockEditWhileAllocationsResolve ? (
              <p className="muted-text">
                Wait for allocation data to finish loading before editing this box&apos;s current footage.
              </p>
            ) : null}
            {box.status === 'TRANSFER' ? (
              <p className="muted-text">
                Pending transfers must be received or cancelled before editing, allocating, checking in, or checking out this box.
              </p>
            ) : null}

            <div className="page-actions detail-status-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => void handleStatusChange('IN_STOCK')}
                disabled={
                  isAddBoxPending ||
                  statusMutation.isPending ||
                  box.status === 'ORDERED' ||
                  box.status === 'IN_STOCK' ||
                  box.status === 'TRANSFER' ||
                  box.status === 'ZEROED' ||
                  box.status === 'RETIRED' ||
                  !auth.isAuthenticated ||
                  !auth.clientIdConfigured ||
                  !canWriteInventory
                }
              >
                Check In
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setIsAllocateOpen(true)}
                disabled={
                  isAddBoxPending ||
                  statusMutation.isPending ||
                  (box.status !== 'IN_STOCK' && box.status !== 'CHECKED_OUT') ||
                  box.status === 'TRANSFER' ||
                  !auth.isAuthenticated ||
                  !auth.clientIdConfigured ||
                  box.feetAvailable <= 0 ||
                  !canWriteAllocations
                }
              >
                Allocate
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void handleStatusChange('CHECKED_OUT')}
                disabled={
                  isAddBoxPending ||
                  statusMutation.isPending ||
                  box.status === 'ORDERED' ||
                  box.status === 'CHECKED_OUT' ||
                  box.status === 'TRANSFER' ||
                  box.status === 'ZEROED' ||
                  box.status === 'RETIRED' ||
                  !auth.isAuthenticated ||
                  !auth.clientIdConfigured ||
                  !canWriteInventory
                }
              >
                Check Out
              </Button>
            </div>
          </>
        ) : null}
      </section>

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
      <DialogSurface
        open={isTransferDialogOpen}
        onClose={closeTransferDialog}
        titleId="transfer-box-dialog-title"
        descriptionId="transfer-box-dialog-description"
        className="transfer-box-dialog"
      >
        <div className="dialog-header">
          <h2 id="transfer-box-dialog-title">Transfer Box</h2>
          <button type="button" className="dialog-close" aria-label="Close dialog" onClick={closeTransferDialog}>
            x
          </button>
        </div>
        <p id="transfer-box-dialog-description" className="muted-text dialog-message">
          Start a warehouse transfer for this box. The box ID prefix will not change until the destination warehouse receives it.
        </p>
        <div className="form-grid">
          <Input
            label="Current Warehouse"
            value={`${box.warehouse} · ${getWarehouseLabel(box.warehouse)}`}
            readOnly
          />
          <Select
            label="Send To"
            options={transferDestinationOptions}
            value={transferDestination}
            onChange={(event) => setTransferDestination(event.target.value as Warehouse | '')}
            autoFocus
          />
        </div>
        {transferDestinationAnalysis.suggestedDestination ? (
          <p className="field-hint">
            Suggested destination: {transferDestinationAnalysis.suggestedDestination}
          </p>
        ) : null}
        {transferDestinationAnalysis.isResolvingAllocations ? (
          <p className="muted-text">Loading active allocation destinations for this box...</p>
        ) : null}
        {transferDestinationAnalysis.conflictMessage ? (
          <p className="error-text">{transferDestinationAnalysis.conflictMessage}</p>
        ) : null}
        {!transferDestinationAnalysis.conflictMessage && transferDestinationAnalysis.resolutionWarning ? (
          <p className="muted-text">{transferDestinationAnalysis.resolutionWarning}</p>
        ) : null}
        <TextArea
          label="Transfer Notes"
          rows={3}
          value={transferNotes}
          onChange={(event) => setTransferNotes(event.target.value)}
          placeholder="Optional notes for the receiving warehouse"
        />
        <div className="dialog-actions">
          <Button type="button" variant="ghost" fullWidth onClick={closeTransferDialog}>
            Cancel
          </Button>
          <Button
            type="button"
            fullWidth
            onClick={() => void handleStartTransfer()}
            loading={startTransferMutation.isPending}
            loadingLabel="Sending..."
            disabled={
              !transferDestination ||
              Boolean(transferDestinationAnalysis.conflictMessage) ||
              transferDestinationAnalysis.isResolvingAllocations ||
              transferMutationsPending
            }
          >
            Send
          </Button>
        </div>
      </DialogSurface>
      <ConfirmDialog
        open={Boolean(pendingZeroedEditState)}
        title="Move Box To Zeroed Inventory?"
        message={
          pendingZeroedEditState
            ? buildZeroedInventoryWarningMessage(
                pendingZeroedEditState.missingFields,
                pendingZeroedEditState.trigger
              )
            : ''
        }
        confirmLabel="Move To Zeroed"
        cancelLabel="Keep Active"
        onCancel={() => {
          setPendingZeroedEditState(null);
          setPendingZeroedReactivationState(null);
        }}
        onConfirm={() => {
          if (!pendingZeroedEditState) {
            return;
          }

          const payload = pendingZeroedEditState.payload;
          setPendingZeroedEditState(null);
          setPendingZeroedReactivationState(null);
          void runStandardUpdateFlow(payload);
        }}
      />
      <ConfirmDialog
        open={Boolean(pendingZeroedReactivationState)}
        title="Reactivate Zeroed Box?"
        message={ZEROED_BOX_REACTIVATION_PROMPT}
        confirmLabel="YES"
        cancelLabel="NO"
        onCancel={() => {
          setPendingZeroedEditState(null);
          setPendingZeroedReactivationState(null);
        }}
        onConfirm={() => {
          if (!pendingZeroedReactivationState) {
            return;
          }

          const payload = pendingZeroedReactivationState.payload;
          setPendingZeroedEditState(null);
          setPendingZeroedReactivationState(null);
          void runStandardUpdateFlow(payload);
        }}
      />
      <ConfirmDialog
        open={transferActionState === 'receive'}
        title="Receive Transfer?"
        message={
          pendingTransfer
            ? `Receive ${pendingTransfer.sourceBoxId} into ${pendingTransfer.destinationWarehouse}? The box ID will change to ${pendingTransfer.destinationBoxId}.`
            : ''
        }
        confirmLabel="Receive Box"
        cancelLabel="Cancel"
        onCancel={() => setTransferActionState(null)}
        onConfirm={() => void handleReceiveTransfer()}
      />
      <ConfirmDialog
        open={transferActionState === 'cancel'}
        title="Cancel Transfer?"
        message={
          pendingTransfer
            ? `Cancel the transfer from ${pendingTransfer.sourceWarehouse} to ${pendingTransfer.destinationWarehouse}? Any active allocations for jobs in ${pendingTransfer.destinationWarehouse} will be released back to this box.`
            : ''
        }
        confirmLabel="Cancel Transfer"
        cancelLabel="Keep Transfer"
        onCancel={() => setTransferActionState(null)}
        onConfirm={() => void handleCancelTransfer()}
      />
      <ConfirmDialog
        open={Boolean(confirmState)}
        title={
          confirmState?.type === 'checkout'
            ? 'Check Out Box'
            : 'Check In Box'
        }
        message={confirmState?.message || ''}
        confirmLabel={
          confirmState?.type === 'checkout'
            ? 'Check Out'
            : 'Check In'
        }
        cancelLabel="Cancel"
        requireReason
        reasonLabel={
          confirmState?.type === 'checkout'
            ? checkoutJobOptions.length > 0
              ? 'Allocated Job'
              : 'Job Number'
            : 'Roll Weight (lbs)'
        }
        reasonPlaceholder={
          confirmState?.type === 'checkout' ? 'Numbers only' : 'Required'
        }
        reasonField={
          confirmState?.type === 'checkout' || confirmState?.type === 'checkin'
            ? 'input'
            : 'textarea'
        }
        reasonInputType={
          confirmState?.type === 'checkin'
            ? 'number'
            : confirmState?.type === 'checkout'
              ? 'text'
              : 'text'
        }
        reasonInputStep={confirmState?.type === 'checkin' ? '0.01' : undefined}
        reasonInputMin={confirmState?.type === 'checkin' ? '0' : undefined}
        reasonInputMode={confirmState?.type === 'checkout' ? 'numeric' : undefined}
        reasonInputPattern={confirmState?.type === 'checkout' ? '[0-9]*' : undefined}
        reasonDigitsOnly={confirmState?.type === 'checkout'}
        reasonOptions={
          confirmState?.type === 'checkout' && checkoutJobOptions.length > 0
            ? checkoutJobOptions
            : undefined
        }
        reasonSelectLabel={confirmState?.type === 'checkout' ? 'Allocated Job' : undefined}
        reasonAllowCustomOption={
          confirmState?.type === 'checkout' && checkoutJobOptions.length > 0
        }
        reasonCustomOptionLabel="Enter New Job Number"
        customReasonLabel={confirmState?.type === 'checkout' ? 'New Job Number' : undefined}
        onCancel={handleCancelConfirm}
        onConfirm={(reason) => void handleConfirm(reason)}
      />
    </>
  );
}

function createFallbackBox(boxId: string): Box {
  return {
    boxId,
    warehouse: WAREHOUSE_CODES[0],
    manufacturer: '',
    filmName: '',
    widthIn: 36,
    initialFeet: 0,
    feetAvailable: 0,
    lotRun: '',
    status: 'ORDERED',
    orderDate: '',
    receivedDate: '',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    filmKey: '',
    coreType: '',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    pricePerLf: null,
    purchaseCost: null,
    notes: '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: ''
  };
}
