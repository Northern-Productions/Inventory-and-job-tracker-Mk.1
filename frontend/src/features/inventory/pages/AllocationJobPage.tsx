import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { listCaulkProducts, listCaulkStock } from '../../../api/features/caulkClient';
import { Button } from '../../../components/Button';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { DeleteConfirmDialog } from '../../../components/DeleteConfirmDialog';
import { DialogSurface } from '../../../components/DialogSurface';
import { Input } from '../../../components/Input';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { useToast } from '../../../components/Toast';
import type {
  AllocationJobDetailEntry,
  CaulkJobAllocationEntry,
  CaulkJobCheckoutEntry,
  FilmOrderEntry,
  JobCaulkRequirementLine,
  JobDetail,
  UpdateJobPayload,
  Warehouse
} from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate, formatDateTime } from '../../../lib/date';
import { safeDecodePathParam } from '../../../lib/url';
import { useAuth } from '../../auth/AuthContext';
import { JobAllocateDialog } from '../components/JobAllocateDialog';
import { JobEditorDialog, type JobEditorSubmitPayload } from '../components/JobEditorDialog';
import { LaborOnlyJobConfirmDialog } from '../components/LaborOnlyJobConfirmDialog';
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
  useBox,
  useJob,
  useRemoveCaulkJobAllocation,
  useReopenJob,
  useRemoveJobBoxAllocations,
  useSetBoxStatus,
  useSetJobStagedForPickup,
  useUpdateCaulkJobAllocation,
  useUpdateJob
} from '../hooks/useInventoryQueries';
import { confirmWarnings, getCheckInWarnings } from '../utils/boxWarnings';
import {
  buildAddCaulkAllocationDefaults,
  buildCaulkAllocationValuesForRequirement,
  formatCaulkTubeBreakdown,
  sortCaulkStockEntriesForAllocation
} from '../utils/caulkAllocationPlanning';
import {
  deriveCaulkCheckinTotals,
  getDeleteJobBlockingMessage,
  getCaulkCheckinValidationError,
  shouldPromptForCompletedJobAfterReturns,
  summarizeReturnedMaterials
} from '../utils/jobReturnedMaterials';
import { getPreferredCaulkProductId } from '../utils/caulkProductPreferences';
import {
  canMarkJobStagedForPickupWithAutoCheckout,
  getJobStagingBlockingMessageWithOptions,
  isLaborOnlyJob
} from '../utils/jobStaging';
import { shouldPromptForLaborOnlyConfirmation } from '../utils/laborOnlyJobs';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { buildCaulkProductLabel } from '../utils/caulkProductLabels';
import { useActionAccess } from '../hooks/useActionAccess';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';

interface CaulkAllocationEditorState {
  mode: 'add' | 'edit';
  caulkAllocationId: string;
  requirementId: string;
  productId: string;
  warehouse: Warehouse;
  allocatedTubes: string;
  notes: string;
  lockProductWarehouse: boolean;
  minAllocatedTubes: number;
}

interface CaulkCheckoutDraft {
  caulkAllocationId: string;
  productLabel: string;
  reservedTubesRemaining: number;
}

interface CaulkCheckinDraft {
  caulkCheckoutId: string;
  caulkAllocationId: string;
  productLabel: string;
  checkoutTubes: number;
  tubesPerCase: number;
  unusedLooseTubes: string;
  unusedCases: string;
  notes: string;
}

function renderDate(value: string) {
  return value ? formatDate(value) : '--';
}

function renderDateTime(value: string) {
  return value ? formatDateTime(value) : '--';
}

function formatBadgeLabel(value: string) {
  return value.replace(/_/g, ' ');
}

function formatAllocationFeet(allocatedFeet: number, coveredFeet: number, allocationKind: string) {
  if (allocationKind === 'EXTRA') {
    return 'EXTRA';
  }

  if (coveredFeet > 0 && coveredFeet !== allocatedFeet) {
    return `${allocatedFeet} physical / ${coveredFeet} covered`;
  }

  return String(allocatedFeet);
}

function formatFilmOrderStatusLabel(value: string) {
  if (value === 'FILM_ON_THE_WAY') {
    return 'FILM ORDERED';
  }

  return formatBadgeLabel(value);
}

function formatUsageQuantity(quantity: number, unit: 'LF' | 'TUBES') {
  return `${quantity} ${unit}`;
}

function buildAddBoxTarget(order: FilmOrderEntry) {
  const params = new URLSearchParams({
    filmOrderId: order.filmOrderId,
    jobNumber: order.jobNumber,
    warehouse: order.warehouse,
    manufacturer: order.manufacturer,
    filmName: order.filmName,
    width: String(order.widthIn),
    remainingToOrderFeet: String(Math.max(order.remainingToOrderFeet, 0)),
    notes: `Ordered for job ${order.jobNumber} via ${order.filmOrderId}`
  });

  return `/inventory/add?${params.toString()}`;
}

export default function AllocationJobPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
  const removeJobBoxAllocationsMutation = useRemoveJobBoxAllocations();
  const setBoxStatusMutation = useSetBoxStatus();
  const setJobStagedForPickupMutation = useSetJobStagedForPickup();
  const filmCatalogQuery = useFilmCatalog();
  const caulkProductsQuery = useQuery({
    queryKey: ['caulk', 'products'],
    queryFn: () => listCaulkProducts()
  });
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [pendingLaborOnlyUpdate, setPendingLaborOnlyUpdate] = useState<JobEditorSubmitPayload | null>(null);
  const [isAllocateOpen, setIsAllocateOpen] = useState(false);
  const [isCompleteConfirmOpen, setIsCompleteConfirmOpen] = useState(false);
  const [isReturnCompletePromptOpen, setIsReturnCompletePromptOpen] = useState(false);
  const [isDeleteJobConfirmOpen, setIsDeleteJobConfirmOpen] = useState(false);
  const [isReopenConfirmOpen, setIsReopenConfirmOpen] = useState(false);
  const [filmOrderToDelete, setFilmOrderToDelete] = useState<FilmOrderEntry | null>(null);
  const [allocationToRemove, setAllocationToRemove] = useState<AllocationJobDetailEntry | null>(null);
  const [filmCheckinEntry, setFilmCheckinEntry] = useState<AllocationJobDetailEntry | null>(null);
  const [caulkAllocationToRemove, setCaulkAllocationToRemove] = useState<CaulkJobAllocationEntry | null>(
    null
  );
  const [caulkAllocationEditor, setCaulkAllocationEditor] =
    useState<CaulkAllocationEditorState | null>(null);
  const [caulkAllocationEditorError, setCaulkAllocationEditorError] = useState('');
  const [caulkCheckoutDraft, setCaulkCheckoutDraft] = useState<CaulkCheckoutDraft | null>(null);
  const [caulkCheckoutError, setCaulkCheckoutError] = useState('');
  const [caulkCheckinDraft, setCaulkCheckinDraft] = useState<CaulkCheckinDraft | null>(null);
  const [caulkCheckinError, setCaulkCheckinError] = useState('');

  const detail = jobQuery.data;
  const summary = detail?.summary;
  const filmCheckinBoxQuery = useBox(filmCheckinEntry?.boxId || '');
  const requirements = detail?.requirements || [];
  const allocations = detail?.allocations || [];
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
    () => allocations.filter((entry) => entry.status === 'ACTIVE' || entry.checkedOutOnThisJob),
    [allocations]
  );
  const filmOrders = detail?.filmOrders || [];
  const canAllocate = useMemo(
    () => !isReadOnlyJob && requirements.length > 0,
    [isReadOnlyJob, requirements.length]
  );
  const canAddCaulkAllocation = useMemo(
    () => !isReadOnlyJob && (caulkRequirements.length > 0 || caulkProducts.length > 0),
    [isReadOnlyJob, caulkRequirements.length, caulkProducts.length]
  );
  const caulkRequirementById = useMemo(
    () =>
      Object.fromEntries(
        caulkRequirements.map((entry) => [entry.requirementId, entry])
      ) as Record<string, JobCaulkRequirementLine>,
    [caulkRequirements]
  );
  const caulkProductLabelById = useMemo(
    () =>
      Object.fromEntries(
        caulkProducts.map((entry) => [
          entry.productId,
          buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)
        ])
      ) as Record<string, string>,
    [caulkProducts]
  );
  const selectedCaulkRequirement = useMemo(() => {
    if (!caulkAllocationEditor?.requirementId) {
      return null;
    }

    return caulkRequirementById[caulkAllocationEditor.requirementId] || null;
  }, [caulkAllocationEditor?.requirementId, caulkRequirementById]);
  const selectedCaulkAllocationRow = useMemo(() => {
    if (!caulkAllocationEditor || caulkAllocationEditor.mode !== 'edit') {
      return null;
    }

    return (
      caulkAllocations.find((entry) => entry.caulkAllocationId === caulkAllocationEditor.caulkAllocationId) ||
      null
    );
  }, [caulkAllocationEditor, caulkAllocations]);
  const selectedCaulkProduct = useMemo(() => {
    if (!caulkAllocationEditor?.productId) {
      return null;
    }

    return caulkProducts.find((entry) => entry.productId === caulkAllocationEditor.productId) || null;
  }, [caulkAllocationEditor?.productId, caulkProducts]);
  const selectedCaulkAllocationProductId = selectedCaulkRequirement?.productId || caulkAllocationEditor?.productId || '';
  const selectedCaulkAllocationProductLabel =
    (selectedCaulkAllocationProductId && caulkProductLabelById[selectedCaulkAllocationProductId]) ||
    (selectedCaulkRequirement
      ? buildCaulkProductLabel(
          selectedCaulkRequirement.manufacturer,
          selectedCaulkRequirement.productName,
          selectedCaulkRequirement.productCode
        )
      : selectedCaulkAllocationRow
        ? buildCaulkProductLabel(
            selectedCaulkAllocationRow.manufacturer,
            selectedCaulkAllocationRow.productName,
            selectedCaulkAllocationRow.productCode
          )
        : '');
  const openCaulkCheckoutByAllocationId = useMemo(
    () =>
      Object.fromEntries(
        caulkCheckouts
          .filter((entry) => entry.status === 'OPEN')
          .map((entry) => [entry.caulkAllocationId, entry])
      ) as Record<string, CaulkJobCheckoutEntry>,
    [caulkCheckouts]
  );
  const caulkAllocationStockQuery = useQuery({
    queryKey: ['caulk', 'stock', 'allocation-dialog', selectedCaulkAllocationProductId],
    queryFn: () =>
      listCaulkStock({
        warehouse: 'ALL',
        productId: selectedCaulkAllocationProductId
      }),
    enabled: Boolean(caulkAllocationEditor && selectedCaulkAllocationProductId)
  });
  const caulkAllocationStockRows = useMemo(() => {
    const rows = caulkAllocationStockQuery.data || [];
    if (!selectedCaulkAllocationProductId) {
      return [];
    }

    return sortCaulkStockEntriesForAllocation(
      rows.filter((entry) => entry.productId === selectedCaulkAllocationProductId),
      caulkAllocationEditor?.warehouse || ''
    );
  }, [
    caulkAllocationEditor?.warehouse,
    caulkAllocationStockQuery.data,
    selectedCaulkAllocationProductId
  ]);
  const filmCheckinDialogMessage = filmCheckinEntry
    ? [
        `Enter the latest roll weight in pounds to complete the check-in for box ${filmCheckinEntry.boxId}.`,
        filmCheckinBoxQuery.isLoading ? 'Loading the latest box details for warning checks.' : ''
      ]
        .filter(Boolean)
        .join(' ')
    : '';
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
        (entry) => entry.status === 'ACTIVE' && entry.boxStatus === 'IN_STOCK' && !entry.checkedOutOnThisJob
      ) ||
      visibleCaulkAllocations.some(
        (entry) =>
          entry.status === 'ACTIVE' &&
          entry.reservedTubesRemaining > 0 &&
          !openCaulkCheckoutByAllocationId[entry.caulkAllocationId]
      ),
    [openCaulkCheckoutByAllocationId, visibleAllocations, visibleCaulkAllocations]
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
  const warehouseOptions = useMemo(() => {
    const options = warehouseRegistry.entries.map((entry) => entry.code);
    if (summary?.warehouse) {
      options.push(summary.warehouse);
    }
    if (caulkAllocationEditor?.warehouse) {
      options.push(caulkAllocationEditor.warehouse);
    }
    return Array.from(new Set(options.filter(Boolean)));
  }, [warehouseRegistry.entries, summary?.warehouse, caulkAllocationEditor?.warehouse]);
  const pendingCaulkMutation =
    addCaulkAllocationMutation.isPending ||
    updateCaulkAllocationMutation.isPending ||
    checkoutCaulkAllocationMutation.isPending ||
    checkinCaulkAllocationMutation.isPending ||
    removeCaulkAllocationMutation.isPending;
  const returnedMaterialsSummary = useMemo(
    () => summarizeReturnedMaterials(detail),
    [detail]
  );
  const hasOutstandingReturnedMaterials = returnedMaterialsSummary.hasOutstandingMaterials;
  const completionBlockedMessage = hasOutstandingReturnedMaterials
    ? `Return ${returnedMaterialsSummary.checkedOutFilmCount} checked-out box${returnedMaterialsSummary.checkedOutFilmCount === 1 ? '' : 'es'} and ${returnedMaterialsSummary.openCaulkCheckoutCount} open caulk checkout${returnedMaterialsSummary.openCaulkCheckoutCount === 1 ? '' : 's'} before completing this job.`
    : '';
  const caulkCheckinTotals = caulkCheckinDraft
    ? deriveCaulkCheckinTotals({
        checkoutTubes: caulkCheckinDraft.checkoutTubes,
        tubesPerCase: caulkCheckinDraft.tubesPerCase,
        unusedLooseTubes: Math.max(0, Math.floor(Number(caulkCheckinDraft.unusedLooseTubes || '0'))),
        unusedCases: Math.max(0, Math.floor(Number(caulkCheckinDraft.unusedCases || '0')))
      })
    : null;

  function ensureSignedIn(actionLabel: string) {
    return ensureActionAccess({
      actionLabel
    });
  }

  function buildUpdateJobPayload(
    submitPayload: JobEditorSubmitPayload,
    isLaborOnly: boolean
  ): UpdateJobPayload {
    return {
      jobNumber: summary?.jobNumber || submitPayload.jobNumber,
      warehouse: submitPayload.warehouse,
      sections: submitPayload.sections,
      dueDate: submitPayload.dueDate,
      crewLeader: submitPayload.crewLeader,
      requirements: submitPayload.requirements,
      caulkRequirements: submitPayload.caulkRequirements,
      isLaborOnly
    };
  }

  async function submitUpdateJob(submitPayload: JobEditorSubmitPayload, isLaborOnly: boolean) {
    if (isReadOnlyJob) {
      toast.push({
        title: 'Job is read-only',
        description: `Job ${submitPayload.jobNumber} is closed and cannot be edited.`,
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('editing jobs')) {
      return;
    }

    const payload = buildUpdateJobPayload(submitPayload, isLaborOnly);

    try {
      setPendingLaborOnlyUpdate(null);
      const { warnings } = await updateJobMutation.mutateAsync(payload);
      setIsEditOpen(false);
      toast.push({
        title: `Saved job ${payload.jobNumber}`,
        description: warnings.join(' ') || `Job ${payload.jobNumber} was updated.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to update job',
        description: error instanceof Error ? error.message : 'The update failed.',
        variant: 'error'
      });
    }
  }

  async function handleCompleteJob(reason: string) {
    if (!summary) {
      return;
    }

    if (!ensureSignedIn('completing jobs')) {
      return;
    }

    try {
      const { warnings } = await completeJobMutation.mutateAsync({
        jobNumber: summary.jobNumber,
        reason: reason || `Marked job ${summary.jobNumber} as completed.`
      });
      toast.push({
        title: `Completed job ${summary.jobNumber}`,
        description: warnings.join(' ') || `Job ${summary.jobNumber} was completed.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to complete job',
        description: error instanceof Error ? error.message : 'The completion request failed.',
        variant: 'error'
      });
    }
  }

  async function handleDeleteJob() {
    if (!summary) {
      return;
    }

    if (!ensureSignedIn('deleting jobs')) {
      return;
    }

    if (!auth.isOwner && !auth.isAdmin) {
      toast.push({
        title: 'Admin or owner access required',
        description: 'Only admins and owners can delete jobs.',
        variant: 'error'
      });
      return;
    }

    const deleteBlockedMessage = getDeleteJobBlockingMessage(detail);
    if (deleteBlockedMessage) {
      toast.push({
        title: 'Unable to delete job',
        description: deleteBlockedMessage,
        variant: 'error'
      });
      return;
    }

    try {
      const deletePromise = deleteJobMutation.mutateAsync({
        jobNumber: summary.jobNumber
      });
      navigate('/allocations', { replace: true });
      await deletePromise;
    } catch (error) {
      navigate(`/allocations/${encodeURIComponent(summary.jobNumber)}`, { replace: true });
      toast.push({
        title: 'Unable to delete job',
        description: error instanceof Error ? error.message : 'The delete request failed.',
        variant: 'error'
      });
    }
  }

  function maybeOpenReturnCompletionPrompt(previousHasOutstandingMaterials: boolean) {
    if (!summary || !detail) {
      return;
    }

    const currentDetail = queryClient.getQueryData<JobDetail>(inventoryKeys.job(summary.jobNumber)) || detail;
    const currentSummary = currentDetail.summary;
    const currentReturnedMaterials = summarizeReturnedMaterials(currentDetail);

    if (
      shouldPromptForCompletedJobAfterReturns({
        previousHasOutstandingMaterials,
        currentHasOutstandingMaterials: currentReturnedMaterials.hasOutstandingMaterials,
        isLaborOnly: Boolean(currentSummary.isLaborOnly),
        lifecycleStatus: currentSummary.lifecycleStatus
      })
    ) {
      setIsReturnCompletePromptOpen(true);
    }
  }

  async function handleCheckoutAllMaterials() {
    if (!summary) {
      return;
    }

    if (isReadOnlyJob) {
      toast.push({
        title: 'Job is read-only',
        description: `Job ${summary.jobNumber} is closed and materials cannot be checked out.`,
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('checking out materials')) {
      return;
    }

    try {
      const { warnings } = await checkoutAllJobMaterialsMutation.mutateAsync({
        jobNumber: summary.jobNumber
      });
      toast.push({
        title: 'Checked out all materials',
        description:
          warnings.join(' ') || `All eligible film and caulk allocations for job ${summary.jobNumber} were checked out.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to check out all materials',
        description: error instanceof Error ? error.message : 'The checkout-all request failed.',
        variant: 'error'
      });
    }
  }

  async function handleUpdateJob(submitPayload: JobEditorSubmitPayload) {
    if (shouldPromptForLaborOnlyConfirmation(submitPayload, Boolean(summary?.isLaborOnly))) {
      setPendingLaborOnlyUpdate(submitPayload);
      return;
    }

    await submitUpdateJob(submitPayload, Boolean(summary?.isLaborOnly));
  }

  async function handleReopenJob(reason: string) {
    if (!summary) {
      return;
    }

    if (!ensureSignedIn('reopening jobs')) {
      return;
    }

    if (!auth.isOwner) {
      toast.push({
        title: 'Owner access required',
        description: 'Only owners can reopen completed or cancelled jobs.',
        variant: 'error'
      });
      return;
    }

    try {
      const { warnings } = await reopenJobMutation.mutateAsync({
        jobNumber: summary.jobNumber,
        reason
      });
      toast.push({
        title: `Reopened job ${summary.jobNumber}`,
        description: warnings.join(' ') || `Job ${summary.jobNumber} is active again.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to reopen job',
        description: error instanceof Error ? error.message : 'The reopen request failed.',
        variant: 'error'
      });
    }
  }

  async function handleDeleteFilmOrder(order: FilmOrderEntry, reason: string) {
    if (isReadOnlyJob) {
      toast.push({
        title: 'Job is read-only',
        description: `Job ${order.jobNumber} is closed and film orders cannot be changed.`,
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('deleting film orders')) {
      return;
    }

    try {
      const { warnings } = await deleteFilmOrderMutation.mutateAsync({
        filmOrderId: order.filmOrderId,
        jobNumber: order.jobNumber,
        reason: reason || `Deleted from Job ${order.jobNumber}`
      });
      toast.push({
        title: `Deleted ${order.filmOrderId}`,
        description: warnings.join(' ') || 'The film order was removed.',
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to delete film order',
        description: error instanceof Error ? error.message : 'The delete request failed.',
        variant: 'error'
      });
    }
  }

  async function handleRemoveAllocation(entry: AllocationJobDetailEntry, reason: string) {
    if (isReadOnlyJob) {
      toast.push({
        title: 'Job is read-only',
        description: `Job ${entry.jobNumber} is closed and allocations cannot be removed.`,
        variant: 'error'
      });
      return;
    }

    if (entry.checkedOutOnThisJob) {
      toast.push({
        title: 'Cannot remove checked-out allocation',
        description: `Box ${entry.boxId} is currently checked out on job ${entry.jobNumber}. Check it in first.`,
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('removing allocations')) {
      return;
    }

    try {
      const { result, warnings } = await removeJobBoxAllocationsMutation.mutateAsync({
        jobNumber: summary?.jobNumber || entry.jobNumber,
        allocationId: entry.allocationId,
        reason:
          reason ||
          `Removed allocation ${entry.allocationId} for box ${entry.boxId} from job ${summary?.jobNumber || entry.jobNumber}.`
      });
      toast.push({
        title: `Removed allocation ${result.allocationId}`,
        description:
          warnings.join(' ') ||
          `Removed ${result.removedAllocationCount} allocation${result.removedAllocationCount === 1 ? '' : 's'} for box ${result.boxId}.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to remove allocation',
        description: error instanceof Error ? error.message : 'The remove request failed.',
        variant: 'error'
      });
    }
  }

  async function handleCheckoutAllocation(entry: AllocationJobDetailEntry) {
    if (isReadOnlyJob) {
      toast.push({
        title: 'Job is read-only',
        description: `Job ${entry.jobNumber} is closed and allocations cannot be checked out.`,
        variant: 'error'
      });
      return;
    }

    if (entry.checkedOutOnThisJob) {
      return;
    }

    if (entry.boxStatus !== 'IN_STOCK') {
      const detailText =
        entry.boxStatus === 'CHECKED_OUT'
          ? `Box ${entry.boxId} is already checked out on another job.`
          : `Box ${entry.boxId} is ${entry.boxStatus || 'not in stock'} and cannot be checked out from this view.`;
      toast.push({
        title: 'Box is not actionable',
        description: detailText,
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('checking out boxes')) {
      return;
    }

    const targetJobNumber = summary?.jobNumber || entry.jobNumber;
    try {
      const { warnings } = await setBoxStatusMutation.mutateAsync({
        boxId: entry.boxId,
        status: 'CHECKED_OUT',
        auditNote: `Checked out for job ${targetJobNumber}`
      });

      toast.push({
        title: `Checked out ${entry.boxId}`,
        description: warnings.join(' ') || `Box ${entry.boxId} was checked out for job ${targetJobNumber}.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to check out box',
        description: error instanceof Error ? error.message : 'The checkout request failed.',
        variant: 'error'
      });
    }
  }

  async function handleSetStagedPickup(nextIsStaged: boolean) {
    if (!summary) {
      return;
    }

    if (isReadOnlyJob) {
      toast.push({
        title: 'Job is read-only',
        description: `Job ${summary.jobNumber} is closed and staged pickup cannot be changed.`,
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('updating staged pickup')) {
      return;
    }

    if (nextIsStaged && stagingBlockingMessage) {
      toast.push({
        title: 'Unable to update staged pickup',
        description: stagingBlockingMessage,
        variant: 'error'
      });
      return;
    }

    try {
      const { warnings } = await setJobStagedForPickupMutation.mutateAsync({
        jobNumber: summary.jobNumber,
        isStagedForPickup: nextIsStaged,
        ...(nextIsStaged ? { autoCheckoutRemaining: true } : {})
      });
      toast.push({
        title: nextIsStaged ? 'Marked staged for pickup' : 'Cleared staged pickup',
        description:
          warnings.join(' ') ||
          (nextIsStaged
            ? `Installers can now see that job ${summary.jobNumber} is staged for pickup.`
            : `Job ${summary.jobNumber} is no longer marked staged for pickup.`),
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to update staged pickup',
        description: error instanceof Error ? error.message : 'The staged pickup update failed.',
        variant: 'error'
      });
    }
  }

  function openFilmCheckinDialog(entry: AllocationJobDetailEntry) {
    if (isReadOnlyJob) {
      toast.push({
        title: 'Job is read-only',
        description: `Job ${entry.jobNumber} is closed and allocations cannot be checked in.`,
        variant: 'error'
      });
      return;
    }

    if (!entry.checkedOutOnThisJob || entry.boxStatus !== 'CHECKED_OUT') {
      toast.push({
        title: 'Box is not actionable',
        description: `Box ${entry.boxId} is not currently checked out on job ${entry.jobNumber}.`,
        variant: 'error'
      });
      return;
    }

    setFilmCheckinEntry(entry);
  }

  async function handleFilmCheckinConfirm(reason: string) {
    if (!filmCheckinEntry) {
      return;
    }

    if (!ensureSignedIn('checking in boxes')) {
      return;
    }

    const hadOutstandingMaterials = returnedMaterialsSummary.hasOutstandingMaterials;
    const box = filmCheckinBoxQuery.data;
    if (!box) {
      toast.push({
        title: 'Box details are still loading',
        description: `The latest box record for ${filmCheckinEntry.boxId} is not ready yet. Try again in a moment.`,
        variant: 'error'
      });
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

    try {
      const entry = filmCheckinEntry;
      const { warnings } = await setBoxStatusMutation.mutateAsync({
        boxId: entry.boxId,
        status: 'IN_STOCK',
        lastRollWeightLbs: parsedWeight,
        auditNote: `Checked in at ${parsedWeight} lbs`
      });

      setFilmCheckinEntry(null);
      toast.push({
        title: `Checked in ${entry.boxId}`,
        description:
          warnings.join(' ') ||
          `Box ${entry.boxId} was checked in from job ${summary?.jobNumber || entry.jobNumber}.`,
        variant: 'success'
      });
      maybeOpenReturnCompletionPrompt(hadOutstandingMaterials);
    } catch (error) {
      toast.push({
        title: 'Unable to check in box',
        description: error instanceof Error ? error.message : 'The check-in request failed.',
        variant: 'error'
      });
    }
  }

  function openAddCaulkAllocationDialog() {
    if (!summary) {
      return;
    }

    const defaultProductId = getPreferredCaulkProductId(caulkProducts) || caulkRequirements[0]?.productId || '';
    const defaultWarehouse = summary.warehouse || warehouseOptions[0] || '';
    const defaultAllocation = buildAddCaulkAllocationDefaults({
      requirements: caulkRequirements,
      fallbackProductId: defaultProductId,
      defaultWarehouse
    });

    if (!defaultAllocation.productId) {
      toast.push({
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
      allocatedTubes: defaultAllocation.allocatedTubes,
      notes: '',
      lockProductWarehouse: false,
      minAllocatedTubes: 1
    });
    setCaulkAllocationEditorError('');
  }

  function openEditCaulkAllocationDialog(entry: CaulkJobAllocationEntry) {
    const hasCheckoutStarted = entry.checkedOutTubesTotal > 0;

    setCaulkAllocationEditor({
      mode: 'edit',
      caulkAllocationId: entry.caulkAllocationId,
      requirementId: entry.requirementId || '',
      productId: entry.productId,
      warehouse: entry.warehouse,
      allocatedTubes: String(entry.allocatedTubes),
      notes: entry.notes || '',
      lockProductWarehouse: hasCheckoutStarted,
      minAllocatedTubes: hasCheckoutStarted ? entry.allocatedTubes : 1
    });
    setCaulkAllocationEditorError('');
  }

  async function handleSubmitCaulkAllocationDialog() {
    if (!summary || !caulkAllocationEditor) {
      return;
    }

    if (isReadOnlyJob) {
      setCaulkAllocationEditorError(`Job ${summary.jobNumber} is closed and cannot be changed.`);
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
      if (caulkAllocationEditor.mode === 'add') {
        const { warnings } = await addCaulkAllocationMutation.mutateAsync({
          jobNumber: summary.jobNumber,
          requirementId: selectedRequirement?.requirementId || undefined,
          productId: selectedProductId,
          warehouse: caulkAllocationEditor.warehouse,
          allocatedTubes: parsedAllocatedTubes,
          notes: caulkAllocationEditor.notes.trim() || undefined
        });
        toast.push({
          title: `Added caulk allocation on job ${summary.jobNumber}`,
          description: warnings.join(' ') || 'Reserved tubes for this allocation row.',
          variant: 'success'
        });
      } else {
        const payload: {
          caulkAllocationId: string;
          allocatedTubes: number;
          productId?: string;
          warehouse?: Warehouse;
          notes?: string;
        } = {
          caulkAllocationId: caulkAllocationEditor.caulkAllocationId,
          allocatedTubes: parsedAllocatedTubes,
          notes: caulkAllocationEditor.notes.trim() || undefined
        };

        if (!caulkAllocationEditor.lockProductWarehouse) {
          payload.productId = selectedProductId;
          payload.warehouse = caulkAllocationEditor.warehouse;
        }

        const { warnings } = await updateCaulkAllocationMutation.mutateAsync(payload);
        toast.push({
          title: `Updated caulk allocation ${caulkAllocationEditor.caulkAllocationId}`,
          description: warnings.join(' ') || 'The caulk allocation row was updated.',
          variant: 'success'
        });
      }

      setCaulkAllocationEditor(null);
      setCaulkAllocationEditorError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The caulk allocation request failed.';
      setCaulkAllocationEditorError(message);
      toast.push({
        title: 'Unable to save caulk allocation',
        description: message,
        variant: 'error'
      });
    }
  }

  function openCaulkCheckoutDialog(entry: CaulkJobAllocationEntry) {
    if (isReadOnlyJob) {
      toast.push({
        title: 'Job is read-only',
        description: `Job ${summary?.jobNumber || ''} is closed and allocations cannot be checked out.`,
        variant: 'error'
      });
      return;
    }

    if (entry.status !== 'ACTIVE') {
      toast.push({
        title: 'Allocation is not active',
        description: `Caulk allocation ${entry.caulkAllocationId} cannot be checked out.`,
        variant: 'error'
      });
      return;
    }

    if (entry.openCheckoutCount > 0) {
      toast.push({
        title: 'Open checkout exists',
        description: 'Check in the open checkout cycle before starting another one.',
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

      const { warnings } = await checkoutCaulkAllocationMutation.mutateAsync({
        caulkAllocationId: caulkCheckoutDraft.caulkAllocationId,
        checkoutTubes: parsedCheckoutTubes
      });
      toast.push({
        title: `Checked out ${parsedCheckoutTubes} tube${parsedCheckoutTubes === 1 ? '' : 's'}`,
        description: warnings.join(' ') || `Started a checkout cycle for ${caulkCheckoutDraft.productLabel}.`,
        variant: 'success'
      });
      setCaulkCheckoutDraft(null);
      setCaulkCheckoutError('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The checkout request failed.';
      setCaulkCheckoutError(message);
      toast.push({
        title: 'Unable to check out caulk',
        description: message,
        variant: 'error'
      });
    }
  }

  function openCaulkCheckinDialog(entry: CaulkJobCheckoutEntry) {
    if (isReadOnlyJob) {
      toast.push({
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

    const hadOutstandingMaterials = returnedMaterialsSummary.hasOutstandingMaterials;
    try {
      const { warnings } = await checkinCaulkAllocationMutation.mutateAsync({
        caulkCheckoutId: caulkCheckinDraft.caulkCheckoutId,
        unusedLooseTubes: parsedUnusedLooseTubes,
        unusedCases: parsedUnusedCases,
        notes: caulkCheckinDraft.notes.trim() || undefined
      });
      toast.push({
        title: `Checked in checkout ${caulkCheckinDraft.caulkCheckoutId}`,
        description: warnings.join(' ') || 'Closed the checkout cycle and recorded usage.',
        variant: 'success'
      });
      setCaulkCheckinDraft(null);
      setCaulkCheckinError('');
      maybeOpenReturnCompletionPrompt(hadOutstandingMaterials);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The check-in request failed.';
      setCaulkCheckinError(message);
      toast.push({
        title: 'Unable to check in caulk',
        description: message,
        variant: 'error'
      });
    }
  }

  async function handleRemoveCaulkAllocation(entry: CaulkJobAllocationEntry, reason: string) {
    if (isReadOnlyJob) {
      toast.push({
        title: 'Job is read-only',
        description: `Job ${summary?.jobNumber || ''} is closed and allocations cannot be removed.`,
        variant: 'error'
      });
      return;
    }

    if (entry.openCheckoutCount > 0) {
      toast.push({
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
      const { result, warnings } = await removeCaulkAllocationMutation.mutateAsync({
        caulkAllocationId: entry.caulkAllocationId,
        reason:
          reason ||
          `Removed caulk allocation ${entry.caulkAllocationId} from job ${summary?.jobNumber || entry.caulkAllocationId}.`
      });
      toast.push({
        title: `Removed caulk allocation ${result.caulkAllocationId}`,
        description:
          warnings.join(' ') ||
          `Released ${result.releasedReservedTubes} reserved tube${result.releasedReservedTubes === 1 ? '' : 's'}.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to remove caulk allocation',
        description: error instanceof Error ? error.message : 'The remove request failed.',
        variant: 'error'
      });
    }
  }

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
      <section className="panel job-detail-hero">
        <div className="page-hero-topline">
          <span className="eyebrow">Job Overview</span>
          {isReadOnlyJob ? <span className="muted-text">Read-only workflow</span> : null}
        </div>
        <div className="panel-title-row">
          <div>
            <h2>JOB ID {summary.jobNumber}</h2>
            <p className="muted-text">Job detail</p>
          </div>
          <div className="detail-actions">
            {summary.isLaborOnly ? (
              <span className="detail-header-pill detail-header-pill-labor-only">LABOR ONLY</span>
            ) : null}
            <span className={`badge badge-${summary.status}`}>{formatBadgeLabel(summary.status)}</span>
            {isReadOnlyJob ? <span className="muted-text">Read-only</span> : null}
            {!isReadOnlyJob ? (
              <Button type="button" onClick={() => setIsEditOpen(true)}>
                Edit
              </Button>
            ) : null}
            {isReadOnlyJob && auth.isOwner ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setIsReopenConfirmOpen(true)}
                disabled={reopenJobMutation.isPending}
              >
                Reopen Job
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => navigate('/allocations')}>
              Back
            </Button>
          </div>
        </div>
        <div className="stat-grid allocation-stat-grid">
          <div className="key-value">
            <dt>Install Date</dt>
            <dd>{renderDate(summary.dueDate)}</dd>
          </div>
          <div className="key-value">
            <dt>Warehouse</dt>
            <dd>{summary.warehouse}</dd>
          </div>
          <div className="key-value">
            <dt>Sections</dt>
            <dd>{summary.sections ?? '--'}</dd>
          </div>
          <div className="key-value">
            <dt>Crew Leader</dt>
            <dd>{summary.crewLeader || '--'}</dd>
          </div>
          <div className="key-value">
            <dt>Required LF</dt>
            <dd>{summary.requiredFeet}</dd>
          </div>
          <div className="key-value">
            <dt>Allocated LF</dt>
            <dd>{summary.allocatedFeet}</dd>
          </div>
          <div className="key-value">
            <dt>Remaining LF</dt>
            <dd>{summary.remainingFeet}</dd>
          </div>
          <div className="key-value">
            <dt>Required Tubes</dt>
            <dd>{totalRequiredCaulkTubes}</dd>
          </div>
          <div className="key-value">
            <dt>Allocated Tubes</dt>
            <dd>{totalAllocatedCaulkTubes}</dd>
          </div>
          <div className="key-value">
            <dt>Remaining Tubes</dt>
            <dd>{totalRemainingCaulkTubes}</dd>
          </div>
        </div>
        <div className="panel-title-row job-detail-staged-panel">
          <div className="key-value">
            <dt
              className={`detail-label-pill ${summary.isStagedForPickup ? 'detail-label-pill-green' : 'detail-label-pill-orange'}`.trim()}
            >
              Installer Pickup
            </dt>
            <dd>{summary.isStagedForPickup ? 'Staged for pickup' : isLaborOnlyDisplayJob ? 'Labor only' : 'Waiting on warehouse staging'}</dd>
            <p className="muted-text job-detail-staged-description">
              {summary.isStagedForPickup
                ? 'Installers can pick up material for this job.'
                : isLaborOnlyDisplayJob
                  ? 'Labor-only jobs do not require staging or checkout. They are tracked by crew leader and install date only.'
                  : stagingBlockingMessage ||
                    'Mark this once the film and caulk are ready. Staging will check out all allocated material first.'}
            </p>
          </div>
          <div className="detail-actions job-detail-staged-actions">
            {isLaborOnlyDisplayJob ? (
              <span className="muted-text">Labor only workflow</span>
            ) : canEditStagedPickup ? (
              <div className="detail-actions job-detail-staged-actions-inner">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void handleCheckoutAllMaterials()}
                  disabled={
                    !hasCheckoutableMaterials ||
                    checkoutAllJobMaterialsMutation.isPending ||
                    setJobStagedForPickupMutation.isPending
                    || setBoxStatusMutation.isPending
                    || checkoutCaulkAllocationMutation.isPending
                  }
                >
                  Checkout All
                </Button>
                <Button
                  type="button"
                  variant={summary.isStagedForPickup ? 'secondary' : 'primary'}
                  onClick={() => void handleSetStagedPickup(!summary.isStagedForPickup)}
                  disabled={
                    checkoutAllJobMaterialsMutation.isPending ||
                    setJobStagedForPickupMutation.isPending ||
                    setBoxStatusMutation.isPending ||
                    checkoutCaulkAllocationMutation.isPending ||
                    (!summary.isStagedForPickup && !canMarkStagedPickup)
                  }
                  loading={setJobStagedForPickupMutation.isPending}
                  loadingLabel={summary.isStagedForPickup ? 'Saving...' : 'Saving...'}
                >
                  {summary.isStagedForPickup ? 'Clear Staged Pickup' : 'Mark Staged for Pickup'}
                </Button>
              </div>
            ) : (
              <span className="muted-text">
                {isReadOnlyJob
                  ? 'Closed jobs keep the saved pickup state for history.'
                  : 'Jobs write access is required to update staged pickup.'}
              </span>
            )}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Film Requirements</h2>
        </div>
        {!requirements.length ? (
          <div className="empty-state">No film requirements added yet.</div>
        ) : isPhoneLayout ? (
          <div className="mobile-record-list">
            {requirements.map((entry) => (
              <MobileRecordCard key={entry.requirementId}>
                <MobileRecordHeader
                  title={`${entry.manufacturer} ${entry.filmName}`}
                  subtitle={`Width ${entry.widthIn}"`}
                />
                <MobileFieldList>
                  <MobileField label="Required LF" value={entry.requiredFeet} />
                  <MobileField label="Allocated LF" value={entry.allocatedFeet} />
                  <MobileField label="Remaining LF" value={entry.remainingFeet} />
                </MobileFieldList>
              </MobileRecordCard>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Manufacturer</th>
                  <th>Film</th>
                  <th>Width</th>
                  <th>Required LF</th>
                  <th>Allocated LF</th>
                  <th>Remaining LF</th>
                </tr>
              </thead>
              <tbody>
                {requirements.map((entry) => (
                  <tr key={entry.requirementId}>
                    <td>{entry.manufacturer}</td>
                    <td>{entry.filmName}</td>
                    <td>{entry.widthIn}</td>
                    <td>{entry.requiredFeet}</td>
                    <td>{entry.allocatedFeet}</td>
                    <td>{entry.remainingFeet}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Caulk Requirements</h2>
        </div>
        {!caulkRequirements.length ? (
          <div className="empty-state">No caulk requirements added yet.</div>
        ) : isPhoneLayout ? (
          <div className="mobile-record-list">
            {caulkRequirements.map((entry) => (
              <MobileRecordCard key={entry.requirementId}>
                <MobileRecordHeader
                  title={buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)}
                  subtitle={`Tubes/Case ${entry.tubesPerCase}`}
                />
                <MobileFieldList>
                  <MobileField label="Required Tubes" value={entry.requiredTubes} />
                  <MobileField
                    label="Required Breakdown"
                    value={formatCaulkTubeBreakdown(entry.requiredTubes, entry.tubesPerCase)}
                  />
                  <MobileField label="Allocated Tubes" value={entry.allocatedTubes} />
                  <MobileField label="Remaining Tubes" value={entry.remainingTubes} />
                  <MobileField
                    label="Remaining Breakdown"
                    value={formatCaulkTubeBreakdown(entry.remainingTubes, entry.tubesPerCase)}
                  />
                </MobileFieldList>
              </MobileRecordCard>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Manufacturer</th>
                  <th>Product</th>
                  <th>Code</th>
                  <th>Tubes/Case</th>
                  <th>Required Tubes</th>
                  <th>Required Breakdown</th>
                  <th>Allocated Tubes</th>
                  <th>Remaining Tubes</th>
                  <th>Remaining Breakdown</th>
                </tr>
              </thead>
              <tbody>
                {caulkRequirements.map((entry) => (
                  <tr key={entry.requirementId}>
                    <td>{entry.manufacturer}</td>
                    <td>{entry.productName}</td>
                    <td>{entry.productCode || '--'}</td>
                    <td>{entry.tubesPerCase}</td>
                    <td>{entry.requiredTubes}</td>
                    <td>{formatCaulkTubeBreakdown(entry.requiredTubes, entry.tubesPerCase)}</td>
                    <td>{entry.allocatedTubes}</td>
                    <td>{entry.remainingTubes}</td>
                    <td>{formatCaulkTubeBreakdown(entry.remainingTubes, entry.tubesPerCase)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Allocated Boxes</h2>
          <div className="detail-actions allocation-header-actions">
            {!isReadOnlyJob ? (
              <Button
                type="button"
                onClick={() => setIsAllocateOpen(true)}
                disabled={!canAllocate || !auth.isAuthenticated || !auth.clientIdConfigured}
              >
                Allocate Film
              </Button>
            ) : null}
          </div>
        </div>
        {!visibleAllocations.length ? (
          <div className="empty-state">No allocations are tied to this job yet.</div>
        ) : isPhoneLayout ? (
          <div className="mobile-record-list">
            {visibleAllocations.map((entry) => (
              <MobileRecordCard key={entry.allocationId}>
                <MobileRecordHeader
                  title={entry.boxId}
                  subtitle={`${entry.manufacturer} ${entry.filmName}`}
                  onTitleClick={() => navigate(`/inventory/${encodeURIComponent(entry.boxId)}`)}
                />
                <MobileFieldList>
                  <MobileField label="Width" value={entry.widthIn || '--'} />
                  <MobileField
                    label="Allocated LF"
                    value={formatAllocationFeet(entry.allocatedFeet, entry.coveredFeet, entry.allocationKind)}
                  />
                  <MobileField label="Created" value={renderDateTime(entry.createdAt)} />
                  <MobileField label="Resolved" value={renderDateTime(entry.resolvedAt)} />
                </MobileFieldList>
                <div className="film-order-actions">
                  {isReadOnlyJob ? (
                    <span className="muted-text">Read-only</span>
                  ) : (
                    <>
                      {entry.checkedOutOnThisJob && entry.boxStatus === 'CHECKED_OUT' ? (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => openFilmCheckinDialog(entry)}
                          disabled={setBoxStatusMutation.isPending}
                        >
                          Check In
                        </Button>
                      ) : entry.boxStatus === 'IN_STOCK' ? (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => void handleCheckoutAllocation(entry)}
                          disabled={setBoxStatusMutation.isPending}
                        >
                          Check Out
                        </Button>
                      ) : (
                        <span className="muted-text">Not in stock</span>
                      )}
                      {!entry.checkedOutOnThisJob ? (
                        <Button
                          type="button"
                          variant="danger"
                          onClick={() => setAllocationToRemove(entry)}
                          disabled={removeJobBoxAllocationsMutation.isPending || setBoxStatusMutation.isPending}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              </MobileRecordCard>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Box</th>
                  <th>Film</th>
                  <th>Width</th>
                  <th>LF</th>
                  <th>Created</th>
                  <th>Resolved</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleAllocations.map((entry) => (
                  <tr key={entry.allocationId}>
                    <td>
                      <button
                        type="button"
                        className="row-button"
                        onClick={() => navigate(`/inventory/${encodeURIComponent(entry.boxId)}`)}
                      >
                        {entry.boxId}
                      </button>
                    </td>
                    <td>
                      {entry.manufacturer} {entry.filmName}
                    </td>
                    <td>{entry.widthIn || '--'}</td>
                    <td>{formatAllocationFeet(entry.allocatedFeet, entry.coveredFeet, entry.allocationKind)}</td>
                    <td>{renderDateTime(entry.createdAt)}</td>
                    <td>{renderDateTime(entry.resolvedAt)}</td>
                    <td>
                      {isReadOnlyJob ? (
                        <span className="muted-text">Read-only</span>
                      ) : (
                        <div className="film-order-actions">
                          {entry.checkedOutOnThisJob && entry.boxStatus === 'CHECKED_OUT' ? (
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => openFilmCheckinDialog(entry)}
                              disabled={setBoxStatusMutation.isPending}
                            >
                              Check In
                            </Button>
                          ) : entry.boxStatus === 'IN_STOCK' ? (
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => void handleCheckoutAllocation(entry)}
                              disabled={setBoxStatusMutation.isPending}
                            >
                              Check Out
                            </Button>
                          ) : (
                            <span className="muted-text">Not in stock</span>
                          )}
                          {!entry.checkedOutOnThisJob ? (
                            <Button
                              type="button"
                              variant="danger"
                              onClick={() => setAllocationToRemove(entry)}
                              disabled={removeJobBoxAllocationsMutation.isPending || setBoxStatusMutation.isPending}
                            >
                              Remove
                            </Button>
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Caulk Allocations</h2>
          <div className="detail-actions allocation-header-actions">
            {!isReadOnlyJob ? (
              <Button
                type="button"
                onClick={openAddCaulkAllocationDialog}
                disabled={
                  !canAddCaulkAllocation ||
                  !auth.isAuthenticated ||
                  !auth.clientIdConfigured ||
                  pendingCaulkMutation
                }
              >
                Allocate Caulk
              </Button>
            ) : null}
          </div>
        </div>
        {caulkProductsQuery.isError ? (
          <p className="error-text">
            {caulkProductsQuery.error instanceof Error
              ? caulkProductsQuery.error.message
              : 'Caulk products could not be loaded.'}
          </p>
        ) : null}
        {!visibleCaulkAllocations.length ? (
          <div className="empty-state">No caulk allocations are tied to this job yet.</div>
        ) : isPhoneLayout ? (
          <div className="mobile-record-list">
            {visibleCaulkAllocations.map((entry) => {
              const hasCheckoutStarted = entry.checkedOutTubesTotal > 0;
              const openCheckoutEntry = openCaulkCheckoutByAllocationId[entry.caulkAllocationId];
              const hasOpenCheckout = Boolean(openCheckoutEntry);
              return (
                <MobileRecordCard key={entry.caulkAllocationId}>
                  <MobileRecordHeader
                    title={buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)}
                    subtitle={`Warehouse ${entry.warehouse}`}
                    badge={<span className={`badge badge-${entry.status}`}>{formatBadgeLabel(entry.status)}</span>}
                  />
                  <MobileFieldList>
                    <MobileField label="Allocated Tubes" value={entry.allocatedTubes} />
                    <MobileField
                      label="Allocated Breakdown"
                      value={formatCaulkTubeBreakdown(entry.allocatedTubes, entry.tubesPerCase)}
                    />
                    <MobileField label="Reserved Tubes" value={entry.reservedTubesRemaining} />
                    <MobileField label="Checked Out" value={entry.checkedOutTubesTotal} />
                    <MobileField label="Returned Unused" value={entry.returnedUnusedTubesTotal} />
                    <MobileField label="Used Tubes" value={entry.usedTubesTotal} />
                    <MobileField label="Overage Tubes" value={entry.overageTubesTotal} />
                  </MobileFieldList>
                  <div className="film-order-actions">
                    {isReadOnlyJob ? (
                      <span className="muted-text">Read-only</span>
                    ) : entry.status !== 'ACTIVE' ? (
                      <span className="muted-text">Cancelled</span>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => openEditCaulkAllocationDialog(entry)}
                          disabled={pendingCaulkMutation || hasOpenCheckout}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() =>
                            hasOpenCheckout && openCheckoutEntry
                              ? openCaulkCheckinDialog(openCheckoutEntry)
                              : openCaulkCheckoutDialog(entry)
                          }
                          disabled={pendingCaulkMutation}
                        >
                          {hasOpenCheckout ? 'Check In' : 'Check Out'}
                        </Button>
                        <Button
                          type="button"
                          variant="danger"
                          onClick={() => setCaulkAllocationToRemove(entry)}
                          disabled={pendingCaulkMutation || hasOpenCheckout}
                        >
                          Remove
                        </Button>
                      </>
                    )}
                  </div>
                  {hasCheckoutStarted ? (
                    <p className="muted-text">
                      Locked after checkout starts: product/warehouse cannot change and allocated tubes can only increase.
                    </p>
                  ) : null}
                  {hasOpenCheckout ? (
                    <p className="muted-text">Check in open checkout cycles before another checkout.</p>
                  ) : null}
                </MobileRecordCard>
              );
            })}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Warehouse</th>
                  <th>Allocated</th>
                  <th>Allocated Breakdown</th>
                  <th>Reserved</th>
                  <th>Checked Out</th>
                  <th>Returned</th>
                  <th>Used</th>
                  <th>Overage</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleCaulkAllocations.map((entry) => {
                  const hasCheckoutStarted = entry.checkedOutTubesTotal > 0;
                  const openCheckoutEntry = openCaulkCheckoutByAllocationId[entry.caulkAllocationId];
                  const hasOpenCheckout = Boolean(openCheckoutEntry);
                  return (
                    <tr key={entry.caulkAllocationId}>
                      <td>{buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)}</td>
                      <td>{entry.warehouse}</td>
                      <td>{entry.allocatedTubes}</td>
                      <td>{formatCaulkTubeBreakdown(entry.allocatedTubes, entry.tubesPerCase)}</td>
                      <td>{entry.reservedTubesRemaining}</td>
                      <td>{entry.checkedOutTubesTotal}</td>
                      <td>{entry.returnedUnusedTubesTotal}</td>
                      <td>{entry.usedTubesTotal}</td>
                      <td>{entry.overageTubesTotal}</td>
                      <td>
                        <span className={`badge badge-${entry.status}`}>{formatBadgeLabel(entry.status)}</span>
                      </td>
                      <td>
                        {isReadOnlyJob ? (
                          <span className="muted-text">Read-only</span>
                        ) : entry.status !== 'ACTIVE' ? (
                          <span className="muted-text">Cancelled</span>
                        ) : (
                          <div className="film-order-actions">
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => openEditCaulkAllocationDialog(entry)}
                              disabled={pendingCaulkMutation || hasOpenCheckout}
                            >
                              Edit
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() =>
                                hasOpenCheckout && openCheckoutEntry
                                  ? openCaulkCheckinDialog(openCheckoutEntry)
                                  : openCaulkCheckoutDialog(entry)
                              }
                              disabled={pendingCaulkMutation}
                            >
                              {hasOpenCheckout ? 'Check In' : 'Check Out'}
                            </Button>
                            <Button
                              type="button"
                              variant="danger"
                              onClick={() => setCaulkAllocationToRemove(entry)}
                              disabled={pendingCaulkMutation || hasOpenCheckout}
                            >
                              Remove
                            </Button>
                            {hasCheckoutStarted ? (
                              <span className="muted-text">Locked after checkout</span>
                            ) : null}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel panel-subtle">
        <div className="panel-title-row">
          <h2>Caulk Checkout Cycles</h2>
        </div>
        {!caulkCheckouts.length ? (
          <div className="empty-state">No caulk checkout cycles have been recorded for this job yet.</div>
        ) : isPhoneLayout ? (
          <div className="mobile-record-list">
            {caulkCheckouts.map((entry) => (
              <MobileRecordCard key={entry.caulkCheckoutId}>
                <MobileRecordHeader
                  title={entry.caulkCheckoutId}
                  subtitle={buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)}
                  badge={<span className={`badge badge-${entry.status}`}>{formatBadgeLabel(entry.status)}</span>}
                />
                <MobileFieldList>
                  <MobileField label="Warehouse" value={entry.warehouse} />
                  <MobileField label="Checked Out Tubes" value={entry.checkoutTubes} />
                  <MobileField label="Overage Tubes" value={entry.overageTubes} />
                  <MobileField label="Unused Tubes" value={entry.unusedTubes} />
                  <MobileField label="Used Tubes" value={entry.usedTubes} />
                  <MobileField label="Checked Out At" value={renderDateTime(entry.checkedOutAt)} />
                  <MobileField label="Checked In At" value={renderDateTime(entry.checkedInAt)} />
                </MobileFieldList>
                <div className="film-order-actions">
                  {isReadOnlyJob ? (
                    <span className="muted-text">Read-only</span>
                  ) : entry.status === 'OPEN' ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => openCaulkCheckinDialog(entry)}
                      disabled={pendingCaulkMutation}
                    >
                      Check In
                    </Button>
                  ) : (
                    <span className="muted-text">Closed</span>
                  )}
                </div>
              </MobileRecordCard>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Checkout ID</th>
                  <th>Product</th>
                  <th>Warehouse</th>
                  <th>Checked Out</th>
                  <th>Overage</th>
                  <th>Unused</th>
                  <th>Used</th>
                  <th>Checked Out At</th>
                  <th>Checked In At</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {caulkCheckouts.map((entry) => (
                  <tr key={entry.caulkCheckoutId}>
                    <td>{entry.caulkCheckoutId}</td>
                    <td>{buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)}</td>
                    <td>{entry.warehouse}</td>
                    <td>{entry.checkoutTubes}</td>
                    <td>{entry.overageTubes}</td>
                    <td>{entry.unusedTubes}</td>
                    <td>{entry.usedTubes}</td>
                    <td>{renderDateTime(entry.checkedOutAt)}</td>
                    <td>{renderDateTime(entry.checkedInAt)}</td>
                    <td>
                      <span className={`badge badge-${entry.status}`}>{formatBadgeLabel(entry.status)}</span>
                    </td>
                    <td>
                      {isReadOnlyJob ? (
                        <span className="muted-text">Read-only</span>
                      ) : entry.status === 'OPEN' ? (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => openCaulkCheckinDialog(entry)}
                          disabled={pendingCaulkMutation}
                        >
                          Check In
                        </Button>
                      ) : (
                        <span className="muted-text">Closed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel panel-subtle">
        <div className="panel-title-row">
          <h2>Job Usage History</h2>
        </div>
        {!usageTimeline.length ? (
          <div className="empty-state">No usage has been recorded for this job yet.</div>
        ) : isPhoneLayout ? (
          <div className="mobile-record-list">
            {usageTimeline.map((entry, index) => (
              <MobileRecordCard key={`${entry.usageType}-${entry.referenceId}-${entry.occurredAt}-${index}`}>
                <MobileRecordHeader
                  title={`${entry.usageType} ${entry.itemName}`}
                  subtitle={entry.itemCode ? `${entry.manufacturer} (${entry.itemCode})` : entry.manufacturer}
                  onTitleClick={
                    entry.usageType === 'FILM'
                      ? () => navigate(`/inventory/${encodeURIComponent(entry.referenceId)}`)
                      : undefined
                  }
                />
                <MobileFieldList>
                  <MobileField label="Warehouse" value={entry.warehouse} />
                  <MobileField label="Checked Out" value={formatUsageQuantity(entry.checkedOutQuantity, entry.unit)} />
                  <MobileField label="Returned" value={formatUsageQuantity(entry.returnedQuantity, entry.unit)} />
                  <MobileField label="Used" value={formatUsageQuantity(entry.usedQuantity, entry.unit)} />
                  <MobileField label="By" value={entry.actor || '--'} />
                  <MobileField label="When" value={renderDateTime(entry.occurredAt)} />
                </MobileFieldList>
              </MobileRecordCard>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Item</th>
                  <th>Warehouse</th>
                  <th>Checked Out</th>
                  <th>Returned</th>
                  <th>Used</th>
                  <th>By</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {usageTimeline.map((entry, index) => (
                  <tr key={`${entry.usageType}-${entry.referenceId}-${entry.occurredAt}-${index}`}>
                    <td>{renderDateTime(entry.occurredAt)}</td>
                    <td>{entry.usageType}</td>
                    <td>
                      {entry.manufacturer} {entry.itemName}
                      {entry.itemCode ? ` (${entry.itemCode})` : ''}
                    </td>
                    <td>{entry.warehouse}</td>
                    <td>{formatUsageQuantity(entry.checkedOutQuantity, entry.unit)}</td>
                    <td>{formatUsageQuantity(entry.returnedQuantity, entry.unit)}</td>
                    <td>{formatUsageQuantity(entry.usedQuantity, entry.unit)}</td>
                    <td>{entry.actor || '--'}</td>
                    <td>
                      {entry.usageType === 'FILM' ? (
                        <button
                          type="button"
                          className="row-button"
                          onClick={() => navigate(`/inventory/${encodeURIComponent(entry.referenceId)}`)}
                        >
                          {entry.referenceId}
                        </button>
                      ) : (
                        entry.referenceId
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel panel-subtle">
        <div className="panel-title-row">
          <h2>Related Film Orders</h2>
        </div>
        {!filmOrders.length ? (
          <div className="empty-state">No film orders were created for this job.</div>
        ) : isPhoneLayout ? (
          <div className="mobile-record-list">
            {filmOrders.map((order) => (
              <MobileRecordCard key={order.filmOrderId}>
                <MobileRecordHeader
                  title={order.filmOrderId}
                  subtitle={`${order.manufacturer} ${order.filmName}`}
                  badge={
                    <span className={`badge badge-${order.status}`}>
                      {formatFilmOrderStatusLabel(order.status)}
                    </span>
                  }
                />
                <MobileFieldList>
                  <MobileField label="Width" value={order.widthIn} />
                  <MobileField label="Requested LF" value={order.requestedFeet} />
                  <MobileField label="Covered LF" value={order.coveredFeet} />
                  <MobileField label="On The Way LF" value={order.orderedFeet} />
                  <MobileField label="Still Short LF" value={order.remainingToOrderFeet} />
                </MobileFieldList>
                <div className="film-order-actions">
                  {isReadOnlyJob ? (
                    <span className="muted-text">Read-only</span>
                  ) : (
                    <>
                      {order.status === 'FULFILLED' ? null : (
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => navigate(buildAddBoxTarget(order))}
                          disabled={order.status !== 'FILM_ORDER'}
                        >
                          Order Film
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="danger"
                        onClick={() => setFilmOrderToDelete(order)}
                        disabled={pendingDeleteFilmOrderIds.has(order.filmOrderId.trim().toUpperCase())}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </MobileRecordCard>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Film</th>
                  <th>Width</th>
                  <th>Requested</th>
                  <th>Covered</th>
                  <th>On The Way</th>
                  <th>Still Short</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filmOrders.map((order) => (
                  <tr key={order.filmOrderId}>
                    <td>
                      <span className={`badge badge-${order.status}`}>
                        {formatFilmOrderStatusLabel(order.status)}
                      </span>
                    </td>
                    <td>
                      {order.manufacturer} {order.filmName}
                    </td>
                    <td>{order.widthIn}</td>
                    <td>{order.requestedFeet}</td>
                    <td>{order.coveredFeet}</td>
                    <td>{order.orderedFeet}</td>
                    <td>{order.remainingToOrderFeet}</td>
                    <td>
                      <div className="film-order-actions">
                        {isReadOnlyJob ? (
                          <span className="muted-text">Read-only</span>
                        ) : (
                          <>
                            {order.status === 'FULFILLED' ? null : (
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() => navigate(buildAddBoxTarget(order))}
                                disabled={order.status !== 'FILM_ORDER'}
                              >
                                Order Film
                              </Button>
                            )}
                            <Button
                              type="button"
                              variant="danger"
                              onClick={() => setFilmOrderToDelete(order)}
                              disabled={pendingDeleteFilmOrderIds.has(order.filmOrderId.trim().toUpperCase())}
                            >
                              Delete
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!isReadOnlyJob || canDeleteJob ? (
        <section className="panel panel-subtle">
          <div
            className={`page-actions allocation-complete-footer ${
              !isReadOnlyJob && canDeleteJob ? 'allocation-complete-footer-with-delete' : ''
            }`.trim()}
          >
            {canDeleteJob ? (
              <Button
                type="button"
                variant="danger"
                className="job-delete-button"
                onClick={() => setIsDeleteJobConfirmOpen(true)}
                disabled={deleteJobMutation.isPending || completeJobMutation.isPending || pendingCaulkMutation}
              >
                Delete
              </Button>
            ) : null}
            {!isReadOnlyJob ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setIsCompleteConfirmOpen(true)}
                disabled={
                  deleteJobMutation.isPending ||
                  completeJobMutation.isPending ||
                  pendingCaulkMutation ||
                  hasOutstandingReturnedMaterials ||
                  !auth.isAuthenticated ||
                  !auth.clientIdConfigured
                }
              >
                Job Completed
              </Button>
            ) : null}
          </div>
          {!isReadOnlyJob && completionBlockedMessage ? (
            <p className="muted-text allocation-complete-helper">{completionBlockedMessage}</p>
          ) : null}
        </section>
      ) : null}

      <DeleteConfirmDialog
        open={isDeleteJobConfirmOpen}
        title="Delete Job"
        message={
          summary
            ? `Delete job ${summary.jobNumber}? This action cannot be undone. Unchecked-out film allocations and reserved caulk will be returned to stock, old job-linked allocations and usage history will be removed, film orders will be deleted, and any checked-out material must be accounted for first.`
            : ''
        }
        cancelLabel="Keep Job"
        pending={deleteJobMutation.isPending}
        onCancel={() => setIsDeleteJobConfirmOpen(false)}
        onConfirm={() => {
          setIsDeleteJobConfirmOpen(false);
          void handleDeleteJob();
        }}
      />

      <ConfirmDialog
        open={Boolean(filmOrderToDelete)}
        title="Delete Film Order"
        message={
          filmOrderToDelete
            ? `Delete film order ${filmOrderToDelete.filmOrderId}? Any active allocations tied to this film order will be released back to inventory.`
            : ''
        }
        confirmLabel="Delete"
        cancelLabel="Keep Film Order"
        onCancel={() => setFilmOrderToDelete(null)}
        onConfirm={(reason) => {
          if (!filmOrderToDelete) {
            return;
          }

          const order = filmOrderToDelete;
          setFilmOrderToDelete(null);
          void handleDeleteFilmOrder(order, reason);
        }}
      />

      <ConfirmDialog
        open={Boolean(allocationToRemove)}
        title="Remove Box Allocation"
        message={
          allocationToRemove
            ? `Remove this allocation row for box ${allocationToRemove.boxId} on job ${summary.jobNumber}?`
            : ''
        }
        confirmLabel="Remove"
        cancelLabel="Keep Allocation"
        onCancel={() => setAllocationToRemove(null)}
        onConfirm={(reason) => {
          if (!allocationToRemove) {
            return;
          }

          const entry = allocationToRemove;
          setAllocationToRemove(null);
          void handleRemoveAllocation(entry, reason);
        }}
      />

      <ConfirmDialog
        open={Boolean(filmCheckinEntry)}
        title={filmCheckinEntry ? `Check In ${filmCheckinEntry.boxId}` : 'Check In Box'}
        message={filmCheckinDialogMessage}
        confirmLabel="Check In"
        cancelLabel="Keep Checked Out"
        requireReason
        reasonLabel="Last Roll Weight (lbs)"
        reasonPlaceholder="Required"
        reasonField="input"
        reasonInputType="number"
        reasonInputStep="0.01"
        reasonInputMin="0"
        onCancel={() => setFilmCheckinEntry(null)}
        onConfirm={(reason) => void handleFilmCheckinConfirm(reason)}
      />

      <ConfirmDialog
        open={Boolean(caulkAllocationToRemove)}
        title="Remove Caulk Allocation"
        message={
          caulkAllocationToRemove
            ? `Remove caulk allocation ${caulkAllocationToRemove.caulkAllocationId} for ${buildCaulkProductLabel(caulkAllocationToRemove.manufacturer, caulkAllocationToRemove.productName, caulkAllocationToRemove.productCode)}?`
            : ''
        }
        confirmLabel="Remove"
        cancelLabel="Keep Allocation"
        onCancel={() => setCaulkAllocationToRemove(null)}
        onConfirm={(reason) => {
          if (!caulkAllocationToRemove) {
            return;
          }

          const entry = caulkAllocationToRemove;
          setCaulkAllocationToRemove(null);
          void handleRemoveCaulkAllocation(entry, reason);
        }}
      />

      <ConfirmDialog
        open={isCompleteConfirmOpen}
        title="Mark Job Completed"
        message={
          summary
            ? `Mark job ${summary.jobNumber} completed? This cancels active film allocations, active caulk allocations, and open film orders.`
            : ''
        }
        confirmLabel="Complete Job"
        cancelLabel="Keep Open"
        onCancel={() => setIsCompleteConfirmOpen(false)}
        onConfirm={(reason) => {
          setIsCompleteConfirmOpen(false);
          void handleCompleteJob(reason);
        }}
      />

      <ConfirmDialog
        open={isReturnCompletePromptOpen}
        title="Complete Job?"
        message={summary ? `All materials for job ${summary.jobNumber} have been returned. Would you like to mark this job COMPLETE?` : ''}
        confirmLabel="YES"
        cancelLabel="NO"
        onCancel={() => setIsReturnCompletePromptOpen(false)}
        onConfirm={() => {
          setIsReturnCompletePromptOpen(false);
          void handleCompleteJob('Marked completed after all job materials were returned.');
        }}
      />

      <ConfirmDialog
        open={isReopenConfirmOpen}
        title="Reopen Job"
        message={
          summary
            ? `Reopen job ${summary.jobNumber}? Cancelled allocations, cancelled caulk allocations, and cancelled film orders stay cancelled.`
            : ''
        }
        confirmLabel="Reopen Job"
        cancelLabel="Keep Closed"
        onCancel={() => setIsReopenConfirmOpen(false)}
        onConfirm={(reason) => {
          setIsReopenConfirmOpen(false);
          void handleReopenJob(reason);
        }}
      />

      {caulkAllocationEditor ? (
        <DialogSurface
          open={Boolean(caulkAllocationEditor)}
          onClose={() => {
            setCaulkAllocationEditor(null);
            setCaulkAllocationEditorError('');
          }}
          className="dialog-caulk-allocation"
          backdropClassName="dialog-backdrop-centered"
          titleId="caulk-allocation-dialog-title"
        >
            <div className="dialog-header">
              <h2 id="caulk-allocation-dialog-title">
                {caulkAllocationEditor.mode === 'add' ? 'Add Caulk Allocation' : 'Edit Caulk Allocation'}
              </h2>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close caulk allocation dialog"
                onClick={() => {
                  setCaulkAllocationEditor(null);
                  setCaulkAllocationEditorError('');
                }}
              >
                X
              </button>
            </div>
            <div className="form-grid">
              {caulkAllocationEditor.mode === 'add' ? (
                <label className="field">
                  <span className="field-label">Job Requirement</span>
                  <select
                    className="field-input"
                    value={caulkAllocationEditor.requirementId}
                    onChange={(event) => {
                      const nextRequirementId = event.target.value;
                      const requirement = nextRequirementId
                        ? caulkRequirementById[nextRequirementId]
                        : null;
                      const nextValues = requirement
                        ? buildCaulkAllocationValuesForRequirement(requirement)
                        : null;
                      setCaulkAllocationEditor((current) =>
                        current
                          ? {
                              ...current,
                              requirementId: nextRequirementId,
                              productId: nextValues?.productId || current.productId,
                              allocatedTubes: nextValues?.allocatedTubes || current.allocatedTubes
                            }
                          : current
                      );
                      setCaulkAllocationEditorError('');
                    }}
                  >
                    <option value="">Ad-hoc allocation (no requirement link)</option>
                    {caulkRequirements.map((entry) => (
                      <option key={entry.requirementId} value={entry.requirementId}>
                        {buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)} | Required{' '}
                        {entry.requiredTubes} | Remaining {entry.remainingTubes}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <label className="field">
                <span className="field-label">Caulk Product</span>
                <select
                  className="field-input"
                  value={caulkAllocationEditor.productId}
                  onChange={(event) => {
                    const nextProductId = event.target.value;
                    setCaulkAllocationEditor((current) =>
                      current ? { ...current, productId: nextProductId } : current
                    );
                    setCaulkAllocationEditorError('');
                  }}
                  disabled={
                    caulkAllocationEditor.lockProductWarehouse ||
                    (caulkAllocationEditor.mode === 'add' && Boolean(caulkAllocationEditor.requirementId))
                  }
                >
                  {caulkProducts.map((entry) => (
                    <option key={entry.productId} value={entry.productId}>
                      {buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)}
                    </option>
                  ))}
                  {caulkAllocationEditor.productId && !caulkProductLabelById[caulkAllocationEditor.productId] ? (
                    <option value={caulkAllocationEditor.productId}>{caulkAllocationEditor.productId}</option>
                  ) : null}
                </select>
              </label>

              <label className="field">
                <span className="field-label">Warehouse</span>
                <select
                  className="field-input"
                  value={caulkAllocationEditor.warehouse}
                  onChange={(event) => {
                    const nextWarehouse = event.target.value;
                    setCaulkAllocationEditor((current) =>
                      current ? { ...current, warehouse: nextWarehouse } : current
                    );
                    setCaulkAllocationEditorError('');
                  }}
                  disabled={caulkAllocationEditor.lockProductWarehouse}
                >
                  {warehouseOptions.map((warehouseCode) => (
                    <option key={warehouseCode} value={warehouseCode}>
                      {warehouseCode}
                    </option>
                  ))}
                </select>
              </label>

              <Input
                label="Allocated Tubes"
                value={caulkAllocationEditor.allocatedTubes}
                inputMode="numeric"
                pattern="[0-9]*"
                onChange={(event) => {
                  const value = event.target.value.replace(/[^0-9]/g, '');
                  setCaulkAllocationEditor((current) =>
                    current ? { ...current, allocatedTubes: value } : current
                  );
                  setCaulkAllocationEditorError('');
                }}
                hint={
                  caulkAllocationEditor.lockProductWarehouse
                    ? `Minimum ${caulkAllocationEditor.minAllocatedTubes} after checkout starts.`
                    : undefined
                }
              />
              {selectedCaulkAllocationProductId ? (
                <section className="caulk-allocation-stock-section" aria-label="Available Caulk Stock">
                  <div className="caulk-allocation-stock-header">
                    <div>
                      <h3>Available Stock</h3>
                      {selectedCaulkAllocationProductLabel ? (
                        <p className="muted-text">{selectedCaulkAllocationProductLabel}</p>
                      ) : null}
                    </div>
                  </div>
                  {caulkAllocationStockQuery.isLoading || caulkAllocationStockQuery.isFetching ? (
                    <p className="muted-text">Loading available stock...</p>
                  ) : caulkAllocationStockQuery.isError ? (
                    <p className="error-text">
                      {caulkAllocationStockQuery.error instanceof Error
                        ? caulkAllocationStockQuery.error.message
                        : 'Available stock failed to load.'}
                    </p>
                  ) : !caulkAllocationStockRows.length ? (
                    <p className="muted-text">No available stock was found for this caulk product.</p>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Warehouse</th>
                            <th>Available Tubes</th>
                            <th>Full Cases</th>
                            <th>Loose Tubes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {caulkAllocationStockRows.map((entry) => {
                            const isSelectedWarehouse = entry.warehouse === caulkAllocationEditor.warehouse;

                            return (
                              <tr
                                key={`${entry.warehouse}:${entry.productId}`}
                                className={isSelectedWarehouse ? 'caulk-stock-row-selected' : undefined}
                              >
                                <td>{entry.warehouse}</td>
                                <td>{entry.tubesOnHand}</td>
                                <td>{entry.casesOnHand}</td>
                                <td>{entry.looseTubes}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              ) : null}

              <label className="field caulk-allocation-notes-field">
                <span className="field-label">Notes</span>
                <textarea
                  className="field-input field-textarea caulk-allocation-notes-input"
                  value={caulkAllocationEditor.notes}
                  rows={3}
                  onChange={(event) => {
                    const value = event.target.value;
                    setCaulkAllocationEditor((current) => (current ? { ...current, notes: value } : current));
                    setCaulkAllocationEditorError('');
                  }}
                />
              </label>
            </div>

            {caulkAllocationEditor.lockProductWarehouse ? (
              <p className="muted-text">
                Guardrail active: once checkout starts, product and warehouse are locked and allocated tubes can only increase.
              </p>
            ) : null}
            {caulkAllocationEditorError ? <p className="error-text">{caulkAllocationEditorError}</p> : null}
            <div className="dialog-actions dialog-actions-sticky-footer">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setCaulkAllocationEditor(null);
                  setCaulkAllocationEditorError('');
                }}
                disabled={pendingCaulkMutation}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => void handleSubmitCaulkAllocationDialog()}
                disabled={pendingCaulkMutation}
              >
                {pendingCaulkMutation
                  ? 'Saving...'
                  : caulkAllocationEditor.mode === 'add'
                    ? 'Add Allocation'
                    : 'Save Allocation'}
              </Button>
            </div>
        </DialogSurface>
      ) : null}

      {caulkCheckoutDraft ? (
        <DialogSurface
          open={Boolean(caulkCheckoutDraft)}
          onClose={() => {
            setCaulkCheckoutDraft(null);
            setCaulkCheckoutError('');
          }}
          className="dialog-caulk-checkout"
          backdropClassName="dialog-backdrop-centered"
          titleId="caulk-checkout-dialog-title"
        >
          <div className="dialog-header">
            <h2 id="caulk-checkout-dialog-title">Check Out Caulk</h2>
            <button
              type="button"
              className="dialog-close"
              aria-label="Close caulk checkout dialog"
              onClick={() => {
                setCaulkCheckoutDraft(null);
                setCaulkCheckoutError('');
              }}
            >
              X
            </button>
          </div>
          <p className="muted-text">
            {caulkCheckoutDraft.productLabel} | Allocated amount: {caulkCheckoutDraft.reservedTubesRemaining} tubes
          </p>
          {caulkCheckoutError ? <p className="error-text">{caulkCheckoutError}</p> : null}
          <div className="dialog-actions dialog-actions-sticky-footer">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setCaulkCheckoutDraft(null);
                setCaulkCheckoutError('');
              }}
              disabled={checkoutCaulkAllocationMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => void handleSubmitCaulkCheckoutDialog()}
              disabled={checkoutCaulkAllocationMutation.isPending}
            >
              {checkoutCaulkAllocationMutation.isPending ? 'Checking Out...' : 'Check Out'}
            </Button>
          </div>
        </DialogSurface>
      ) : null}

      {caulkCheckinDraft ? (
        <DialogSurface
          open={Boolean(caulkCheckinDraft)}
          onClose={() => {
            setCaulkCheckinDraft(null);
            setCaulkCheckinError('');
          }}
          className="dialog-caulk-checkin"
          backdropClassName="dialog-backdrop-centered"
          titleId="caulk-checkin-dialog-title"
        >
          <div className="dialog-header">
            <h2 id="caulk-checkin-dialog-title">Check In Caulk</h2>
            <button
              type="button"
              className="dialog-close"
              aria-label="Close caulk checkin dialog"
              onClick={() => {
                setCaulkCheckinDraft(null);
                setCaulkCheckinError('');
              }}
            >
              X
            </button>
          </div>
          <p className="muted-text">
            {caulkCheckinDraft.productLabel} | Checked out: {caulkCheckinDraft.checkoutTubes} tubes | {caulkCheckinDraft.tubesPerCase} tubes per case
          </p>
          <div className="form-grid">
            <Input
              label="Unused Loose Tubes"
              value={caulkCheckinDraft.unusedLooseTubes}
              placeholder="0"
              inputMode="numeric"
              pattern="[0-9]*"
              onChange={(event) => {
                const value = event.target.value.replace(/[^0-9]/g, '');
                setCaulkCheckinDraft((current) => (current ? { ...current, unusedLooseTubes: value } : current));
                setCaulkCheckinError('');
              }}
              hint={`Must be between 0 and ${Math.max(caulkCheckinDraft.tubesPerCase - 1, 0)}.`}
            />
            <Input
              label="Unused Full Cases"
              value={caulkCheckinDraft.unusedCases}
              placeholder="0"
              inputMode="numeric"
              pattern="[0-9]*"
              onChange={(event) => {
                const value = event.target.value.replace(/[^0-9]/g, '');
                setCaulkCheckinDraft((current) => (current ? { ...current, unusedCases: value } : current));
                setCaulkCheckinError('');
              }}
              hint="Enter unopened full cases only."
            />
            <Input
              label="Notes"
              value={caulkCheckinDraft.notes}
              onChange={(event) => {
                const value = event.target.value;
                setCaulkCheckinDraft((current) => (current ? { ...current, notes: value } : current));
                setCaulkCheckinError('');
              }}
            />
          </div>
          {caulkCheckinTotals ? (
            <p className="muted-text">
              Returning {caulkCheckinTotals.totalReturnedTubes} tubes total; {caulkCheckinTotals.usedTubes} tube{caulkCheckinTotals.usedTubes === 1 ? '' : 's'} will be marked used.
            </p>
          ) : null}
          {caulkCheckinError ? <p className="error-text">{caulkCheckinError}</p> : null}
          <div className="dialog-actions dialog-actions-sticky-footer">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setCaulkCheckinDraft(null);
                setCaulkCheckinError('');
              }}
              disabled={checkinCaulkAllocationMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => void handleSubmitCaulkCheckinDialog()}
              disabled={checkinCaulkAllocationMutation.isPending}
            >
              {checkinCaulkAllocationMutation.isPending ? 'Checking In...' : 'Check In'}
            </Button>
          </div>
        </DialogSurface>
      ) : null}

      <JobEditorDialog
        open={isEditOpen}
        mode="edit"
        title={`Edit Job ${summary.jobNumber}`}
        submitLabel="Save Job"
        submitting={updateJobMutation.isPending}
        initialJobNumber={summary.jobNumber}
        initialWarehouse={summary.warehouse}
        initialSections={summary.sections}
        initialDueDate={summary.dueDate}
        initialCrewLeader={summary.crewLeader}
        initialRequirements={requirements}
        initialCaulkRequirements={caulkRequirements.map((entry) => ({
          requirementId: entry.requirementId,
          productId: entry.productId,
          requiredTubes: entry.requiredTubes
        }))}
        filmCatalogEntries={filmCatalogQuery.data}
        filmCatalogLoading={filmCatalogQuery.isLoading}
        filmCatalogError={filmCatalogQuery.error}
        caulkProductEntries={caulkProducts}
        caulkProductLoading={caulkProductsQuery.isLoading}
        caulkProductError={caulkProductsQuery.error}
        onCancel={() => setIsEditOpen(false)}
        onSubmit={(payload) => void handleUpdateJob(payload)}
      />
      <LaborOnlyJobConfirmDialog
        open={Boolean(pendingLaborOnlyUpdate)}
        jobNumber={pendingLaborOnlyUpdate?.jobNumber || summary.jobNumber}
        pending={updateJobMutation.isPending}
        onCancel={() => setPendingLaborOnlyUpdate(null)}
        onConfirmLaborOnly={() => {
          if (!pendingLaborOnlyUpdate) {
            return;
          }

          void submitUpdateJob(pendingLaborOnlyUpdate, true);
        }}
      />

      <JobAllocateDialog
        open={isAllocateOpen}
        jobNumber={summary.jobNumber}
        warehouse={summary.warehouse}
        dueDate={summary.dueDate}
        crewLeader={summary.crewLeader}
        requirements={requirements}
        filmOrders={filmOrders}
        onCancel={() => setIsAllocateOpen(false)}
      />
    </>
  );
}
