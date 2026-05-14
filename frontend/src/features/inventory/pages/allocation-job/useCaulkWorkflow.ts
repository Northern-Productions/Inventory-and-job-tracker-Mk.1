import { useMemo, useState } from 'react';
import type {
  AddCaulkJobAllocationPayload,
  CancelCaulkTransferPayload,
  CaulkJobAllocationEntry,
  CaulkJobAllocationMutationResult,
  CaulkJobCheckoutEntry,
  CaulkJobCheckoutMutationResult,
  CaulkPendingTransferSummary,
  CaulkProductEntry,
  CaulkTransferMutationResult,
  CheckinCaulkJobAllocationPayload,
  CheckoutCaulkJobAllocationPayload,
  JobCaulkRequirementLine,
  ReceiveCaulkTransferPayload,
  RemoveCaulkJobAllocationPayload,
  RemoveCaulkJobAllocationResult,
  UpdateCaulkJobAllocationPayload,
  Warehouse,
  WarehouseEntry
} from '../../../../domain';
import type { useToast } from '../../../../components/Toast';
import { formatMutationWarningDescription } from '../../../../lib/mutationWarnings';
import {
  usePendingAddCaulkAllocationJobNumbers,
  usePendingCheckinCaulkCheckoutIds,
  usePendingCheckoutCaulkAllocationIds,
  usePendingRemoveCaulkAllocationIds,
  usePendingUpdateCaulkAllocationIds
} from '../../hooks/useInventoryQueries';
import { buildAddCaulkAllocationDefaults } from '../../utils/caulkAllocationPlanning';
import { buildCaulkProductLabel } from '../../utils/caulkProductLabels';
import { getPreferredCaulkProductId } from '../../utils/caulkProductPreferences';
import { getCaulkCheckinValidationError } from '../../utils/jobReturnedMaterials';
import type {
  CaulkAllocationEditorState,
  CaulkCheckinDraft,
  CaulkCheckoutDraft
} from './types';

type PushToast = ReturnType<typeof useToast>['push'];

type MutationFn<Payload, Result> = (payload: Payload) => Promise<Result>;

interface UseCaulkWorkflowArgs {
  canonicalJobId?: string;
  jobNumber?: string;
  warehouse?: Warehouse;
  isReadOnlyJob: boolean;
  canManageTransfers: boolean;
  caulkProducts: CaulkProductEntry[];
  caulkRequirements: JobCaulkRequirementLine[];
  warehouseEntries: WarehouseEntry[];
  previousHasOutstandingMaterials: boolean;
  pendingTransferByAllocationId: Record<string, CaulkPendingTransferSummary>;
  isCaulkTransferPending: (transferId: string) => boolean;
  ensureSignedIn: (actionLabel: string) => boolean;
  maybeOpenReturnCompletionPrompt: (previousHasOutstandingMaterials: boolean) => void;
  pushToast: PushToast;
  addCaulkAllocation: MutationFn<
    AddCaulkJobAllocationPayload,
    { result: CaulkJobAllocationMutationResult; warnings: string[] }
  >;
  addCaulkAllocationPending: boolean;
  updateCaulkAllocation: MutationFn<
    UpdateCaulkJobAllocationPayload,
    { result: CaulkJobAllocationMutationResult; warnings: string[] }
  >;
  updateCaulkAllocationPending: boolean;
  checkoutCaulkAllocation: MutationFn<
    CheckoutCaulkJobAllocationPayload,
    { result: CaulkJobCheckoutMutationResult; warnings: string[] }
  >;
  checkoutCaulkAllocationPending: boolean;
  checkinCaulkAllocation: MutationFn<
    CheckinCaulkJobAllocationPayload,
    { result: CaulkJobCheckoutMutationResult; warnings: string[] }
  >;
  checkinCaulkAllocationPending: boolean;
  removeCaulkAllocation: MutationFn<
    RemoveCaulkJobAllocationPayload,
    { result: RemoveCaulkJobAllocationResult; warnings: string[] }
  >;
  removeCaulkAllocationPending: boolean;
  receiveCaulkTransfer: MutationFn<
    ReceiveCaulkTransferPayload,
    { result: CaulkTransferMutationResult; warnings: string[] }
  >;
  receiveCaulkTransferPending: boolean;
  cancelCaulkTransfer: MutationFn<
    CancelCaulkTransferPayload,
    { result: CaulkTransferMutationResult; warnings: string[] }
  >;
  cancelCaulkTransferPending: boolean;
}

export function useCaulkWorkflow({
  canonicalJobId,
  jobNumber,
  warehouse,
  isReadOnlyJob,
  canManageTransfers,
  caulkProducts,
  caulkRequirements,
  warehouseEntries,
  previousHasOutstandingMaterials,
  pendingTransferByAllocationId,
  isCaulkTransferPending,
  ensureSignedIn,
  maybeOpenReturnCompletionPrompt,
  pushToast,
  addCaulkAllocation,
  addCaulkAllocationPending,
  updateCaulkAllocation,
  updateCaulkAllocationPending,
  checkoutCaulkAllocation,
  checkoutCaulkAllocationPending,
  checkinCaulkAllocation,
  checkinCaulkAllocationPending,
  removeCaulkAllocation,
  removeCaulkAllocationPending,
  receiveCaulkTransfer,
  receiveCaulkTransferPending,
  cancelCaulkTransfer,
  cancelCaulkTransferPending
}: UseCaulkWorkflowArgs) {
  const [caulkAllocationToRemove, setCaulkAllocationToRemove] =
    useState<CaulkJobAllocationEntry | null>(null);
  const [caulkAllocationEditor, setCaulkAllocationEditor] =
    useState<CaulkAllocationEditorState | null>(null);
  const [caulkAllocationEditorError, setCaulkAllocationEditorError] = useState('');
  const [caulkCheckoutDraft, setCaulkCheckoutDraft] = useState<CaulkCheckoutDraft | null>(null);
  const [caulkCheckoutError, setCaulkCheckoutError] = useState('');
  const [caulkCheckinDraft, setCaulkCheckinDraft] = useState<CaulkCheckinDraft | null>(null);
  const [caulkCheckinError, setCaulkCheckinError] = useState('');
  const pendingAddCaulkAllocationJobNumbers = usePendingAddCaulkAllocationJobNumbers();
  const pendingUpdateCaulkAllocationIds = usePendingUpdateCaulkAllocationIds();
  const pendingRemoveCaulkAllocationIds = usePendingRemoveCaulkAllocationIds();
  const pendingCheckoutCaulkAllocationIds = usePendingCheckoutCaulkAllocationIds();
  const pendingCheckinCaulkCheckoutIds = usePendingCheckinCaulkCheckoutIds();

  const caulkRequirementById = useMemo(
    () =>
      Object.fromEntries(
        caulkRequirements.map((entry) => [entry.requirementId, entry])
      ) as Record<string, JobCaulkRequirementLine>,
    [caulkRequirements]
  );

  const warehouseOptions = useMemo(() => {
    const options = warehouseEntries.map((entry) => entry.code);
    if (warehouse) {
      options.push(warehouse);
    }
    if (caulkAllocationEditor?.warehouse) {
      options.push(caulkAllocationEditor.warehouse);
    }
    return Array.from(new Set(options.filter(Boolean)));
  }, [warehouseEntries, warehouse, caulkAllocationEditor?.warehouse]);

  const pendingCaulkMutation =
    (Boolean(jobNumber) &&
      pendingAddCaulkAllocationJobNumbers.has(String(jobNumber || '').trim().toUpperCase())) ||
    pendingUpdateCaulkAllocationIds.size > 0 ||
    pendingRemoveCaulkAllocationIds.size > 0 ||
    pendingCheckoutCaulkAllocationIds.size > 0 ||
    pendingCheckinCaulkCheckoutIds.size > 0 ||
    addCaulkAllocationPending ||
    updateCaulkAllocationPending ||
    checkoutCaulkAllocationPending ||
    checkinCaulkAllocationPending ||
    removeCaulkAllocationPending ||
    receiveCaulkTransferPending ||
    cancelCaulkTransferPending;

  function isCaulkAllocationPending(caulkAllocationId: string) {
    const normalizedId = String(caulkAllocationId || '').trim().toUpperCase();
    if (!normalizedId) {
      return false;
    }

    return (
      pendingUpdateCaulkAllocationIds.has(normalizedId) ||
      pendingRemoveCaulkAllocationIds.has(normalizedId) ||
      pendingCheckoutCaulkAllocationIds.has(normalizedId)
    );
  }

  function isCaulkCheckoutPending(caulkCheckoutId: string, caulkAllocationId = '') {
    const normalizedCheckoutId = String(caulkCheckoutId || '').trim().toUpperCase();
    if (normalizedCheckoutId && pendingCheckinCaulkCheckoutIds.has(normalizedCheckoutId)) {
      return true;
    }

    return isCaulkAllocationPending(caulkAllocationId);
  }

  function openAddCaulkAllocationDialog() {
    if (!jobNumber) {
      return;
    }

    const defaultProductId = getPreferredCaulkProductId(caulkProducts) || caulkRequirements[0]?.productId || '';
    const defaultWarehouse = warehouse || warehouseOptions[0] || '';
    const defaultAllocation = buildAddCaulkAllocationDefaults({
      requirements: caulkRequirements,
      fallbackProductId: defaultProductId,
      defaultWarehouse
    });

    if (!defaultAllocation.productId) {
      pushToast({
        title: 'No caulk products available',
        description: 'Create a caulk product before adding allocations.',
        variant: 'error'
      });
      return;
    }

    setCaulkAllocationEditor({
      mode: 'add',
      caulkAllocationId: '',
      requirementId: defaultAllocation.requirementId,
      productId: defaultAllocation.productId,
      warehouse: defaultAllocation.warehouse,
      transferFromWarehouse: '',
      allocatedTubes: defaultAllocation.allocatedTubes,
      notes: '',
      lockProductWarehouse: false,
      minAllocatedTubes: 1
    });
    setCaulkAllocationEditorError('');
  }

  function openEditCaulkAllocationDialog(entry: CaulkJobAllocationEntry) {
    if (entry.pendingTransfer) {
      pushToast({
        title: 'Transfer still pending',
        description: `Receive or cancel transfer ${entry.pendingTransfer.transferId} before editing this allocation.`,
        variant: 'error'
      });
      return;
    }

    const hasCheckoutStarted = entry.checkedOutTubesTotal > 0;

    setCaulkAllocationEditor({
      mode: 'edit',
      caulkAllocationId: entry.caulkAllocationId,
      requirementId: entry.requirementId || '',
      productId: entry.productId,
      warehouse: entry.warehouse,
      transferFromWarehouse: '',
      allocatedTubes: String(entry.allocatedTubes),
      notes: entry.notes || '',
      lockProductWarehouse: hasCheckoutStarted,
      minAllocatedTubes: hasCheckoutStarted ? entry.allocatedTubes : 1
    });
    setCaulkAllocationEditorError('');
  }

  async function handleSubmitCaulkAllocationDialog() {
    if (!jobNumber || !caulkAllocationEditor) {
      return;
    }

    if (isReadOnlyJob) {
      setCaulkAllocationEditorError(`Job ${jobNumber} is closed and cannot be changed.`);
      return;
    }

    if (!ensureSignedIn('editing caulk allocations')) {
      return;
    }

    const selectedRequirement = caulkAllocationEditor.requirementId
      ? caulkRequirementById[caulkAllocationEditor.requirementId]
      : null;
    const selectedProductId = selectedRequirement?.productId || caulkAllocationEditor.productId;
    const parsedAllocatedTubes = Math.floor(Number(caulkAllocationEditor.allocatedTubes));

    if (!selectedProductId) {
      setCaulkAllocationEditorError('Select a caulk product first.');
      return;
    }

    if (!Number.isFinite(parsedAllocatedTubes) || parsedAllocatedTubes <= 0) {
      setCaulkAllocationEditorError('Allocated tubes must be greater than zero.');
      return;
    }

    if (
      caulkAllocationEditor.lockProductWarehouse &&
      parsedAllocatedTubes < caulkAllocationEditor.minAllocatedTubes
    ) {
      setCaulkAllocationEditorError(
        `Allocated tubes cannot drop below ${caulkAllocationEditor.minAllocatedTubes} after checkout starts.`
      );
      return;
    }

    try {
      const editorSnapshot = {
        ...caulkAllocationEditor
      };
      setCaulkAllocationEditor(null);
      setCaulkAllocationEditorError('');

      if (caulkAllocationEditor.mode === 'add') {
        const savePromise = addCaulkAllocation({
          jobId: canonicalJobId || undefined,
          jobNumber,
          requirementId: selectedRequirement?.requirementId || undefined,
          productId: selectedProductId,
          warehouse: caulkAllocationEditor.warehouse,
          transferFromWarehouse: caulkAllocationEditor.transferFromWarehouse || undefined,
          allocatedTubes: parsedAllocatedTubes,
          notes: caulkAllocationEditor.notes.trim() || undefined
        });

        void savePromise
          .then(({ warnings }) => {
            pushToast({
              title: `Added caulk allocation on job ${jobNumber}`,
              description: formatMutationWarningDescription(
                warnings,
                'Reserved tubes for this allocation row.',
                'add-caulk-allocation'
              ),
              variant: 'success'
            });
          })
          .catch((error) => {
            const message =
              error instanceof Error ? error.message : 'The caulk allocation request failed.';
            setCaulkAllocationEditor(editorSnapshot);
            setCaulkAllocationEditorError(message);
            pushToast({
              title: 'Unable to save caulk allocation',
              description: message,
              variant: 'error'
            });
          });
      } else {
        const payload: UpdateCaulkJobAllocationPayload = {
          caulkAllocationId: caulkAllocationEditor.caulkAllocationId,
          allocatedTubes: parsedAllocatedTubes,
          notes: caulkAllocationEditor.notes.trim() || undefined
        };

        if (!caulkAllocationEditor.lockProductWarehouse) {
          payload.productId = selectedProductId;
          payload.warehouse = caulkAllocationEditor.warehouse;
        }
        if (caulkAllocationEditor.transferFromWarehouse) {
          payload.transferFromWarehouse = caulkAllocationEditor.transferFromWarehouse;
        }

        const savePromise = updateCaulkAllocation(payload);
        void savePromise
          .then(({ warnings }) => {
            pushToast({
              title: `Updated caulk allocation ${caulkAllocationEditor.caulkAllocationId}`,
              description: formatMutationWarningDescription(
                warnings,
                'The caulk allocation row was updated.',
                'update-caulk-allocation'
              ),
              variant: 'success'
            });
          })
          .catch((error) => {
            const message =
              error instanceof Error ? error.message : 'The caulk allocation request failed.';
            setCaulkAllocationEditor(editorSnapshot);
            setCaulkAllocationEditorError(message);
            pushToast({
              title: 'Unable to save caulk allocation',
              description: message,
              variant: 'error'
            });
          });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The caulk allocation request failed.';
      setCaulkAllocationEditorError(message);
      pushToast({
        title: 'Unable to save caulk allocation',
        description: message,
        variant: 'error'
      });
    }
  }

  function openCaulkCheckoutDialog(entry: CaulkJobAllocationEntry) {
    if (isReadOnlyJob) {
      pushToast({
        title: 'Job is read-only',
        description: `Job ${jobNumber || ''} is closed and allocations cannot be checked out.`,
        variant: 'error'
      });
      return;
    }

    if (entry.status !== 'ACTIVE') {
      pushToast({
        title: 'Allocation is not active',
        description: `Caulk allocation ${entry.caulkAllocationId} cannot be checked out.`,
        variant: 'error'
      });
      return;
    }

    if (entry.openCheckoutCount > 0) {
      pushToast({
        title: 'Open checkout exists',
        description: 'Check in the open checkout cycle before starting another one.',
        variant: 'error'
      });
      return;
    }

    if (entry.pendingTransfer?.transferId) {
      pushToast({
        title: 'Transfer still pending',
        description: `Receive transfer ${entry.pendingTransfer.transferId} before checking out this allocation.`,
        variant: 'error'
      });
      return;
    }

    const shortageTubes = Math.max(
      0,
      entry.allocatedTubes - (entry.checkedOutTubesTotal + entry.reservedTubesRemaining)
    );
    if (shortageTubes > 0) {
      pushToast({
        title: 'Allocation still needs transfer',
        description: `${entry.warehouse} still needs ${shortageTubes} tube${shortageTubes === 1 ? '' : 's'} transferred in before checkout.`,
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('checking out caulk')) {
      return;
    }

    setCaulkCheckoutDraft({
      caulkAllocationId: entry.caulkAllocationId,
      productLabel: buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode),
      reservedTubesRemaining: entry.reservedTubesRemaining
    });
    setCaulkCheckoutError('');
  }

  async function handleSubmitCaulkCheckoutDialog() {
    if (!caulkCheckoutDraft) {
      return;
    }

    if (!ensureSignedIn('checking out caulk')) {
      return;
    }

    try {
      const parsedCheckoutTubes = Math.max(0, Math.floor(Number(caulkCheckoutDraft.reservedTubesRemaining)));
      if (parsedCheckoutTubes <= 0) {
        setCaulkCheckoutError('No reserved tubes are available to check out.');
        return;
      }

      const draftSnapshot = {
        ...caulkCheckoutDraft
      };
      setCaulkCheckoutDraft(null);
      setCaulkCheckoutError('');

      const checkoutPromise = checkoutCaulkAllocation({
        caulkAllocationId: caulkCheckoutDraft.caulkAllocationId,
        checkoutTubes: parsedCheckoutTubes
      });

      void checkoutPromise
        .then(({ warnings }) => {
          pushToast({
            title: `Checked out ${parsedCheckoutTubes} tube${parsedCheckoutTubes === 1 ? '' : 's'}`,
            description: formatMutationWarningDescription(
              warnings,
              `Started a checkout cycle for ${draftSnapshot.productLabel}.`,
              'checkout-caulk-allocation'
            ),
            variant: 'success'
          });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : 'The checkout request failed.';
          setCaulkCheckoutDraft(draftSnapshot);
          setCaulkCheckoutError(message);
          pushToast({
            title: 'Unable to check out caulk',
            description: message,
            variant: 'error'
          });
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The checkout request failed.';
      setCaulkCheckoutError(message);
      pushToast({
        title: 'Unable to check out caulk',
        description: message,
        variant: 'error'
      });
    }
  }

  function openCaulkCheckinDialog(entry: CaulkJobCheckoutEntry) {
    if (isReadOnlyJob) {
      pushToast({
        title: 'Job is read-only',
        description: 'Closed jobs cannot accept caulk check-ins.',
        variant: 'error'
      });
      return;
    }

    if (entry.status !== 'OPEN') {
      return;
    }

    if (!ensureSignedIn('checking in caulk')) {
      return;
    }

    setCaulkCheckinDraft({
      caulkCheckoutId: entry.caulkCheckoutId,
      caulkAllocationId: entry.caulkAllocationId,
      productLabel: buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode),
      checkoutTubes: entry.checkoutTubes,
      tubesPerCase: entry.tubesPerCase,
      unusedLooseTubes: '',
      unusedCases: '',
      notes: ''
    });
    setCaulkCheckinError('');
  }

  async function handleSubmitCaulkCheckinDialog() {
    if (!caulkCheckinDraft) {
      return;
    }

    const parsedUnusedLooseTubes = Math.floor(Number(caulkCheckinDraft.unusedLooseTubes));
    const parsedUnusedCases = Math.floor(Number(caulkCheckinDraft.unusedCases));
    const validationError = getCaulkCheckinValidationError({
      checkoutTubes: caulkCheckinDraft.checkoutTubes,
      tubesPerCase: caulkCheckinDraft.tubesPerCase,
      unusedLooseTubes: parsedUnusedLooseTubes,
      unusedCases: parsedUnusedCases
    });
    if (validationError) {
      setCaulkCheckinError(validationError);
      return;
    }

    if (!ensureSignedIn('checking in caulk')) {
      return;
    }

    try {
      const draftSnapshot = {
        ...caulkCheckinDraft
      };
      setCaulkCheckinDraft(null);
      setCaulkCheckinError('');

      const checkinPromise = checkinCaulkAllocation({
        caulkCheckoutId: caulkCheckinDraft.caulkCheckoutId,
        unusedLooseTubes: parsedUnusedLooseTubes,
        unusedCases: parsedUnusedCases,
        notes: caulkCheckinDraft.notes.trim() || undefined
      });

      void checkinPromise
        .then(({ warnings }) => {
          pushToast({
            title: `Checked in checkout ${draftSnapshot.caulkCheckoutId}`,
            description: formatMutationWarningDescription(
              warnings,
              'Closed the checkout cycle and recorded usage.',
              'checkin-caulk-allocation'
            ),
            variant: 'success'
          });
          maybeOpenReturnCompletionPrompt(previousHasOutstandingMaterials);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : 'The check-in request failed.';
          setCaulkCheckinDraft(draftSnapshot);
          setCaulkCheckinError(message);
          pushToast({
            title: 'Unable to check in caulk',
            description: message,
            variant: 'error'
          });
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The check-in request failed.';
      setCaulkCheckinError(message);
      pushToast({
        title: 'Unable to check in caulk',
        description: message,
        variant: 'error'
      });
    }
  }

  async function handleRemoveCaulkAllocation(entry: CaulkJobAllocationEntry, reason: string) {
    if (isReadOnlyJob) {
      pushToast({
        title: 'Job is read-only',
        description: `Job ${jobNumber || ''} is closed and allocations cannot be removed.`,
        variant: 'error'
      });
      return;
    }

    if (entry.openCheckoutCount > 0) {
      pushToast({
        title: 'Open checkout exists',
        description: 'Check in all open checkout cycles before removing this allocation row.',
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('removing caulk allocations')) {
      return;
    }

    try {
      const removePromise = removeCaulkAllocation({
        caulkAllocationId: entry.caulkAllocationId,
        reason:
          reason ||
          `Removed caulk allocation ${entry.caulkAllocationId} from job ${jobNumber || entry.caulkAllocationId}.`
      });

      void removePromise
        .then(({ result, warnings }) => {
          const baseDescription = `Released ${result.releasedReservedTubes} reserved tube${result.releasedReservedTubes === 1 ? '' : 's'}.`;
          const defaultDescription = result.autoPlanningSuppressed
            ? `${baseDescription} Auto planning is paused for this caulk requirement.`
            : baseDescription;
          pushToast({
            title: `Removed caulk allocation ${result.caulkAllocationId}`,
            description: formatMutationWarningDescription(
              warnings,
              defaultDescription,
              'remove-caulk-allocation'
            ),
            variant: 'success'
          });
        })
        .catch((error) => {
          pushToast({
            title: 'Unable to remove caulk allocation',
            description: error instanceof Error ? error.message : 'The remove request failed.',
            variant: 'error'
          });
          setCaulkAllocationToRemove(entry);
        });
    } catch (error) {
      pushToast({
        title: 'Unable to remove caulk allocation',
        description: error instanceof Error ? error.message : 'The remove request failed.',
        variant: 'error'
      });
    }
  }

  async function handleReceiveCaulkTransfer(entry: CaulkJobAllocationEntry) {
    const pendingTransfer = pendingTransferByAllocationId[entry.caulkAllocationId] || entry.pendingTransfer || null;
    if (!pendingTransfer?.transferId) {
      return;
    }

    if (!canManageTransfers) {
      pushToast({
        title: 'Inventory write access required',
        description: 'Receiving transferred caulk requires inventory write access.',
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('receiving transferred caulk')) {
      return;
    }

    try {
      const { warnings } = await receiveCaulkTransfer({ transferId: pendingTransfer.transferId });
      pushToast({
        title: `Received transfer ${pendingTransfer.transferId}`,
        description: formatMutationWarningDescription(
          warnings,
          'The transferred caulk is now available for this job.',
          'receive-job-caulk-transfer'
        ),
        variant: 'success'
      });
    } catch (error) {
      pushToast({
        title: 'Unable to receive caulk transfer',
        description: error instanceof Error ? error.message : 'The receive request failed.',
        variant: 'error'
      });
    }
  }

  async function handleCancelCaulkTransfer(entry: CaulkJobAllocationEntry) {
    const pendingTransfer = pendingTransferByAllocationId[entry.caulkAllocationId] || entry.pendingTransfer || null;
    if (!pendingTransfer?.transferId) {
      return;
    }

    if (!canManageTransfers) {
      pushToast({
        title: 'Inventory write access required',
        description: 'Cancelling transferred caulk requires inventory write access.',
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('cancelling transferred caulk')) {
      return;
    }

    try {
      const { warnings } = await cancelCaulkTransfer({ transferId: pendingTransfer.transferId });
      pushToast({
        title: `Cancelled transfer ${pendingTransfer.transferId}`,
        description: formatMutationWarningDescription(
          warnings,
          'The pending caulk transfer was cancelled.',
          'cancel-job-caulk-transfer'
        ),
        variant: 'success'
      });
    } catch (error) {
      pushToast({
        title: 'Unable to cancel caulk transfer',
        description: error instanceof Error ? error.message : 'The cancel request failed.',
        variant: 'error'
      });
    }
  }

  return {
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
    isCaulkAllocationPending,
    isCaulkCheckoutPending,
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
  };
}
