import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useToast } from '../../../../components/Toast';
import { type Box } from '../../../../domain';
import { safeDecodePathParam } from '../../../../lib/url';
import { useAuth } from '../../../auth/AuthContext';
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
} from '../../hooks/useInventoryQueries';
import { useActionAccess } from '../../hooks/useActionAccess';
import { useWarehouseRegistry } from '../../hooks/useWarehouseRegistry';
import {
  boxNeedsAllocationsToResolveCurrentFeet,
  createDraftFromBox,
  deriveCurrentFeetOnRollForBox,
  getDisplayedAllocatedFeetForBox
} from '../../utils/boxHelpers';
import {
  buildTransferDestinationAnalysis,
  createFallbackBox
} from './helpers';
import { useBoxDetailActions } from './useBoxDetailActions';
import { useBoxQrCode } from './useBoxQrCode';
import { useBoxTransferWorkflow } from './useBoxTransferWorkflow';

export function useBoxDetailsPageModel() {
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
  const isAddBoxPending = useIsAddBoxPending(boxId);
  const boxTransferQuery = useBoxTransfer(boxId, { enabled: !isAddBoxPending });
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
        label: `${entry.code} Â· ${entry.name}`,
        value: entry.code
      });
    }

    return options;
  }, [box?.warehouse, warehouseRegistry.entries]);
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
  const effectiveCurrentFeetOnRoll =
    currentFeetOnRoll === null && box?.physicalFeetAvailable !== undefined && box?.physicalFeetAvailable !== null
      ? box.physicalFeetAvailable
      : currentFeetOnRoll;
  const shouldBlockEditWhileAllocationsResolve = Boolean(
    box &&
      boxNeedsAllocationsToResolveCurrentFeet(box) &&
      (allocationsQuery.isLoading || allocationsQuery.isError)
  );
  const onHandAssetCost =
    box &&
    effectiveCurrentFeetOnRoll !== null &&
    typeof box.pricePerLf === 'number' &&
    Number.isFinite(box.pricePerLf)
      ? Math.max(effectiveCurrentFeetOnRoll, 0) * box.pricePerLf
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

  return {
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
    transferDestinationOptions,
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
    goBackToInventory: () => navigate('/'),
    openAllocationJob: (jobNumber: string) => navigate(`/allocations/${encodeURIComponent(jobNumber)}`)
  };
}
