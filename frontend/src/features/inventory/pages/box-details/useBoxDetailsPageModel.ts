import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useToast } from '../../../../components/Toast';
import { type Box } from '../../../../domain';
import { safeDecodePathParam } from '../../../../lib/url';
import { useAuth } from '../../../auth/AuthContext';
import {
  useBoxAllocations,
  useBox,
  useBoxDealers,
  useBoxTransfer,
  useChangeFilmBoxOwner,
  useCancelBoxTransfer,
  useDeleteBox,
  useFilmCatalog,
  useFilmOrders,
  useIsAddBoxPending,
  useJobSummariesByNumbers,
  useOwnerCompanies,
  useReceiveOrderedBox,
  useReceiveBoxTransfer,
  useStartBoxTransfer,
  useSetBoxStatus,
  useUndoAudit,
  useUpsertBoxDealer,
  useUpdateBox
} from '../../hooks/useInventoryQueries';
import { useActionAccess } from '../../hooks/useActionAccess';
import { useWarehouseRegistry } from '../../hooks/useWarehouseRegistry';
import { formatWarehouseDisplayLabel } from '../../utils/warehouseOptions';
import {
  boxNeedsAllocationsToResolveCurrentFeet,
  createDraftFromBox,
  deriveCurrentFeetOnRollForBox,
  getDisplayedAllocatedFeetForBox
} from '../../utils/boxHelpers';
import { getNextFilmOrderLinkedBoxToReceive } from '../../utils/filmOrders';
import {
  buildCheckoutJobOptions,
  buildTransferDestinationAnalysis,
  createFallbackBox
} from './helpers';
import { useBoxDetailActions } from './useBoxDetailActions';
import { useBoxQrCode } from './useBoxQrCode';
import { useBoxTransferWorkflow } from './useBoxTransferWorkflow';

function normalizeGuidedReturnTarget(value: string) {
  return String(value || '').trim().toLowerCase();
}

function resolveGuidedReturnPath(returnTo: string) {
  return normalizeGuidedReturnTarget(returnTo) === 'film-orders' ? '/film-orders' : '/';
}

export function useBoxDetailsPageModel() {
  const params = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const auth = useAuth();
  const ensureActionAccess = useActionAccess();
  const canWriteInventory = auth.hasFeatureAccess('inventory', 'write');
  const boxId = safeDecodePathParam(params.boxId);
  const boxQuery = useBox(boxId);
  const isAddBoxPending = useIsAddBoxPending(boxId);
  const guidedFilmOrderId = String(searchParams.get('filmOrderId') || '').trim();
  const guidedReturnTo = String(searchParams.get('returnTo') || '').trim();
  const isGuidedOrderedReceive = searchParams.get('receiveOrdered') === '1' && Boolean(guidedFilmOrderId);
  const boxTransferQuery = useBoxTransfer(boxId, { enabled: !isAddBoxPending });
  const updateMutation = useUpdateBox();
  const changeFilmBoxOwnerMutation = useChangeFilmBoxOwner();
  const deleteMutation = useDeleteBox();
  const statusMutation = useSetBoxStatus();
  const receiveOrderedMutation = useReceiveOrderedBox();
  const startTransferMutation = useStartBoxTransfer();
  const receiveTransferMutation = useReceiveBoxTransfer();
  const cancelTransferMutation = useCancelBoxTransfer();
  const undoMutation = useUndoAudit();
  const boxDealersQuery = useBoxDealers({ enabled: auth.isAuthenticated });
  const ownerCompaniesQuery = useOwnerCompanies({
    enabled: auth.isAuthenticated,
    includeInactive: true
  });
  const filmCatalogQuery = useFilmCatalog();
  const filmOrdersQuery = useFilmOrders({
    enabled: auth.isAuthenticated && isGuidedOrderedReceive
  });
  const upsertBoxDealerMutation = useUpsertBoxDealer();
  const allocationsQuery = useBoxAllocations(boxId);
  const warehouseRegistry = useWarehouseRegistry();
  const [isEditing, setIsEditing] = useState(false);
  const [isAllocationsSectionCollapsed, setIsAllocationsSectionCollapsed] = useState(false);
  const [isHistorySectionCollapsed, setIsHistorySectionCollapsed] = useState(true);
  const didHandleScanNotice = useRef('');
  const didAutoOpenOrderedReceiveKey = useRef('');

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
        label: formatWarehouseDisplayLabel(entry),
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
    return buildCheckoutJobOptions(allocations);
  }, [allocations]);
  const initialDraft = useMemo(
    () =>
      box
        ? createDraftFromBox(box, allocationsForCurrentFeet)
        : createDraftFromBox(createFallbackBox(boxId)),
    [allocationsForCurrentFeet, box, boxId]
  );
  const guidedFilmOrder = useMemo(
    () =>
      isGuidedOrderedReceive
        ? (filmOrdersQuery.data || []).find((entry) => entry.filmOrderId === guidedFilmOrderId) || null
        : null,
    [filmOrdersQuery.data, guidedFilmOrderId, isGuidedOrderedReceive]
  );
  const guidedReceiveTargetBoxId = useMemo(() => {
    if (!guidedFilmOrder) {
      return '';
    }

    const excludeCurrentBoxIds =
      box?.boxId && (box.status !== 'ORDERED' || Boolean(box.receivedDate)) ? [box.boxId] : [];
    return (
      getNextFilmOrderLinkedBoxToReceive(guidedFilmOrder, {
        excludeBoxIds: excludeCurrentBoxIds
      })?.boxId || ''
    );
  }, [box?.boxId, box?.receivedDate, box?.status, guidedFilmOrder]);

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
    dealerEntries: boxDealersQuery.data || [],
    checkoutJobOptions,
    ensureSignedIn,
    navigate,
    pushToast: toast.push,
    onEditComplete: () => setIsEditing(false),
    updateBox: updateMutation.mutateAsync,
    changeFilmBoxOwner: changeFilmBoxOwnerMutation.mutateAsync,
    deleteBox: deleteMutation.mutateAsync,
    setBoxStatus: statusMutation.mutateAsync,
    receiveOrderedBox: receiveOrderedMutation.mutateAsync,
    undoAudit: undoMutation.mutateAsync,
    upsertDealer: upsertBoxDealerMutation.mutateAsync
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
    if (!isGuidedOrderedReceive || filmOrdersQuery.isLoading) {
      return;
    }

    if (!guidedFilmOrder || !guidedReceiveTargetBoxId) {
      navigate(resolveGuidedReturnPath(guidedReturnTo), { replace: true });
      return;
    }

    const currentBoxId = box?.boxId || boxId;
    if (!currentBoxId || currentBoxId === guidedReceiveTargetBoxId) {
      return;
    }

    const nextParams = new URLSearchParams({
      filmOrderId: guidedFilmOrderId,
      receiveOrdered: '1'
    });
    if (guidedReturnTo) {
      nextParams.set('returnTo', guidedReturnTo);
    }

    navigate(`/inventory/${encodeURIComponent(guidedReceiveTargetBoxId)}?${nextParams.toString()}`, {
      replace: true
    });
  }, [
    box?.boxId,
    boxId,
    filmOrdersQuery.isLoading,
    guidedFilmOrder,
    guidedFilmOrderId,
    guidedReceiveTargetBoxId,
    guidedReturnTo,
    isGuidedOrderedReceive,
    navigate
  ]);

  useEffect(() => {
    setIsAllocationsSectionCollapsed(false);
    setIsHistorySectionCollapsed(true);
  }, [boxId]);

  useEffect(() => {
    const scanNotice = searchParams.get('scanNotice');
    const supportedScanNotices = new Set([
      'checkout-job-unknown',
      'checkout-job-unresolved',
      'checkout-job-ambiguous'
    ]);
    if (!scanNotice || !supportedScanNotices.has(scanNotice) || !box) {
      return;
    }

    const noticeKey = `${box.boxId}:${scanNotice}`;
    if (didHandleScanNotice.current === noticeKey) {
      return;
    }

    didHandleScanNotice.current = noticeKey;
    const checkoutJob = String(box.lastCheckoutJob || '').trim();
    const description =
      scanNotice === 'checkout-job-ambiguous' && checkoutJob
        ? `Box ${box.boxId} is checked out to job ${checkoutJob}, but that job number matches multiple jobs. Open the correct job from Jobs to check it in.`
        : scanNotice === 'checkout-job-unresolved' && checkoutJob
          ? `Box ${box.boxId} is checked out to job ${checkoutJob}, but the app could not resolve one current job record for that job number. Open the related job or search Jobs to check it in.`
          : checkoutJob
            ? `Box ${box.boxId} is checked out to job ${checkoutJob}, but the scan did not include enough job context to open the check-in workflow automatically.`
            : `Box ${box.boxId} is checked out, but the scan did not include enough job context to open the check-in workflow automatically.`;
    toast.push({
      title: 'Open the job to check in this box',
      description,
      variant: 'warning'
    });
  }, [box, searchParams, toast]);

  useEffect(() => {
    if (
      !isGuidedOrderedReceive ||
      !box ||
      box.status !== 'ORDERED' ||
      Boolean(box.receivedDate) ||
      !auth.isAuthenticated ||
      !auth.clientIdConfigured ||
      !canWriteInventory ||
      guidedReceiveTargetBoxId !== box.boxId
    ) {
      return;
    }

    const autoOpenKey = `${guidedFilmOrderId}:${box.boxId}`;
    if (didAutoOpenOrderedReceiveKey.current === autoOpenKey) {
      return;
    }

    didAutoOpenOrderedReceiveKey.current = autoOpenKey;
    boxActions.openOrderedReceiveDialog();
  }, [
    auth.clientIdConfigured,
    auth.isAuthenticated,
    box,
    boxActions,
    canWriteInventory,
    guidedFilmOrderId,
    guidedReceiveTargetBoxId,
    isGuidedOrderedReceive
  ]);

  return {
    auth,
    boxQuery,
    box,
    ownerCompaniesQuery,
    pendingTransfer,
    isAddBoxPending,
    updateMutation,
    changeFilmBoxOwnerMutation,
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
    goBackToInventory: () => navigate('/')
  };
}
