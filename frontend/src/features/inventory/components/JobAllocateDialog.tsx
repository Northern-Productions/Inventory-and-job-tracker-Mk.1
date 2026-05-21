import { useEffect, useMemo, useState } from 'react';
import { DialogSurface } from '../../../components/DialogSurface';
import { useToast } from '../../../components/Toast';
import { useAuth } from '../../auth/AuthContext';
import type { FilmOrderEntry, JobRequirementLine, Warehouse } from '../../../domain';
import { formatMutationWarningDescription } from '../../../lib/mutationWarnings';
import {
  useAllocateBox,
  useAllocationPreview,
  useCreateFilmOrder,
  useSearchBoxesWithOptions
} from '../hooks/useInventoryQueries';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { findMatchingBoxesForRequirement } from '../utils/jobAllocationMatching';
import { buildFullBoxExtraAllocations, prioritizeCandidateBoxes } from '../utils/jobAllocationSelection';
import { ActionBar } from './job-allocate-dialog/ActionBar';
import { AllocationPlanTable } from './job-allocate-dialog/AllocationPlanTable';
import { RequirementFields } from './job-allocate-dialog/RequirementFields';
import { StatusMessages } from './job-allocate-dialog/StatusMessages';
import {
  buildLocalSourceSelectionSummary,
  buildSelectionSummary,
  collectPreferredLinkedBoxIds,
  previewMatchesPayload
} from './job-allocate-dialog/helpers';

interface JobAllocateDialogProps {
  open: boolean;
  jobId?: string;
  jobNumber: string;
  warehouse: Warehouse;
  installDate: string;
  crewLeader: string;
  requirements: JobRequirementLine[];
  filmOrders: FilmOrderEntry[];
  isExtraFilmMode?: boolean;
  onCancel: () => void;
  onRequirementAllocationApplied?: (previousSnapshot: {
    requirements: JobRequirementLine[];
    filmOrders: FilmOrderEntry[];
  }) => void | Promise<void>;
}

function cloneFilmOrderPromptSnapshot(
  requirements: JobRequirementLine[],
  filmOrders: FilmOrderEntry[]
) {
  return {
    requirements: requirements.map((entry) => ({ ...entry })),
    filmOrders: filmOrders.map((entry) => ({
      ...entry,
      linkedBoxes: Array.isArray(entry.linkedBoxes)
        ? entry.linkedBoxes.map((linkedBox) => ({ ...linkedBox }))
        : []
    }))
  };
}

export function JobAllocateDialog({
  open,
  jobId,
  jobNumber,
  warehouse,
  installDate,
  crewLeader,
  requirements,
  filmOrders,
  isExtraFilmMode = false,
  onCancel,
  onRequirementAllocationApplied
}: JobAllocateDialogProps) {
  const toast = useToast();
  const auth = useAuth();
  const allocateMutation = useAllocateBox();
  const createFilmOrderMutation = useCreateFilmOrder();
  const [selectedRequirementId, setSelectedRequirementId] = useState('');
  const [requestedFeet, setRequestedFeet] = useState('');
  const [selectedBoxIds, setSelectedBoxIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [completedRequirementIds, setCompletedRequirementIds] = useState<string[]>([]);
  const [submitAction, setSubmitAction] = useState<'allocate' | 'order' | null>(null);
  const allocatableRequirements = useMemo(
    () =>
      isExtraFilmMode
        ? requirements.filter((entry) => entry.status !== 'COMPLETE' && entry.requiredFeet > 0)
        : requirements.filter((entry) => entry.status !== 'COMPLETE' && entry.remainingFeet > 0),
    [isExtraFilmMode, requirements]
  );
  const selectedRequirement = useMemo(
    () => allocatableRequirements.find((entry) => entry.requirementId === selectedRequirementId) || null,
    [allocatableRequirements, selectedRequirementId]
  );
  const warehouseRegistry = useWarehouseRegistry();
  const searchableWarehouses = useMemo(
    () => {
      const codes = warehouseRegistry.entries.map((entry) => entry.code);
      if (!warehouse || !codes.includes(warehouse)) {
        return codes;
      }

      return [warehouse, ...codes.filter((code) => code !== warehouse)];
    },
    [warehouse, warehouseRegistry.entries]
  );
  const searchableFilmName = selectedRequirement ? selectedRequirement.filmName.trim() : '';
  const searchableManufacturer = selectedRequirement ? selectedRequirement.manufacturer.trim() : '';
  const shouldSearchMatchingBoxes = open && Boolean(selectedRequirement);
  const matchingBoxesQuery = useSearchBoxesWithOptions(
    {
      warehouses: searchableWarehouses,
      manufacturer: searchableManufacturer,
      q: searchableFilmName,
      showRetired: false
    },
    {
      enabled: shouldSearchMatchingBoxes
    }
  );
  const searchableBoxes = matchingBoxesQuery.data || [];
  const matchingBoxes = useMemo(() => {
    if (!selectedRequirement) {
      return [];
    }

    return findMatchingBoxesForRequirement(searchableBoxes, selectedRequirement, warehouse);
  }, [searchableBoxes, selectedRequirement, warehouse]);
  const preferredLinkedBoxIds = useMemo(
    () => collectPreferredLinkedBoxIds(selectedRequirement, filmOrders),
    [filmOrders, selectedRequirement]
  );
  const prioritizedMatchingBoxes = useMemo(
    () => prioritizeCandidateBoxes(matchingBoxes, preferredLinkedBoxIds, warehouse),
    [matchingBoxes, preferredLinkedBoxIds, warehouse]
  );
  const requestedFeetValue = useMemo(() => {
    if (isExtraFilmMode) {
      return 0;
    }

    const parsed = Number(requestedFeet);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }

    return Math.floor(parsed);
  }, [isExtraFilmMode, requestedFeet]);
  const selectedSourceBoxId = selectedBoxIds[0] || '';
  const selectedSuggestionBoxIds = selectedBoxIds.slice(1);
  const selectedSourceBox = useMemo(
    () => prioritizedMatchingBoxes.find((box) => box.boxId === selectedSourceBoxId) || null,
    [prioritizedMatchingBoxes, selectedSourceBoxId]
  );
  const previewPayload = useMemo(
    () =>
      open && !isExtraFilmMode && selectedRequirement && requestedFeetValue > 0 && selectedSourceBox
        ? {
            ...(jobId ? { jobId } : {}),
            boxId: selectedSourceBox.boxId,
            jobNumber,
            installDate: installDate || '',
            crewLeader: crewLeader || '',
            requestedFeet: requestedFeetValue,
            requestedWidthIn: selectedRequirement.widthIn,
            requirementId: selectedRequirement.requirementId,
            crossWarehouse: true,
            jobWarehouse: warehouse
          }
        : null,
    [
      crewLeader,
      installDate,
      isExtraFilmMode,
      jobId,
      jobNumber,
      open,
      requestedFeetValue,
      selectedRequirement,
      selectedSourceBox,
      warehouse
    ]
  );
  const previewQuery = useAllocationPreview(previewPayload);
  const preview = previewQuery.data;
  const activePreview = useMemo(
    () => (previewMatchesPayload(preview, previewPayload) ? preview : null),
    [preview, previewPayload]
  );
  const previewSuggestionBoxIdSet = useMemo(
    () => new Set((activePreview?.suggestions || []).map((entry) => entry.boxId)),
    [activePreview]
  );
  const selectedPreviewSuggestionBoxIds = useMemo(
    () =>
      activePreview
        ? selectedSuggestionBoxIds.filter((boxId) => previewSuggestionBoxIdSet.has(boxId))
        : [],
    [activePreview, previewSuggestionBoxIdSet, selectedSuggestionBoxIds]
  );
  const isMatchingBoxesLoading =
    matchingBoxesQuery.isLoading || matchingBoxesQuery.isFetching;
  const isAllocationPreviewLoading =
    Boolean(previewPayload) && !activePreview && !previewQuery.isError;
  const isOrderFilmMode =
    !isExtraFilmMode &&
    !isMatchingBoxesLoading &&
    Boolean(selectedRequirement) &&
    !prioritizedMatchingBoxes.length;
  const plannedSelection = useMemo(
    () => {
      if (isExtraFilmMode) {
        const extraAllocationResult = buildFullBoxExtraAllocations(prioritizedMatchingBoxes, selectedBoxIds);
        const allocations = extraAllocationResult.error ? [] : extraAllocationResult.extraAllocations;
        return {
          allocations,
          coveredFeet: allocations.reduce((sum, entry) => sum + entry.allocatedFeet, 0),
          remainingFeet: 0
        };
      }

      return activePreview
        ? buildSelectionSummary(activePreview, selectedPreviewSuggestionBoxIds)
        : buildLocalSourceSelectionSummary(
            selectedSourceBox,
            requestedFeetValue,
            selectedRequirement?.widthIn || 0
          );
    },
    [
      activePreview,
      isExtraFilmMode,
      prioritizedMatchingBoxes,
      requestedFeetValue,
      selectedRequirement?.widthIn,
      selectedBoxIds,
      selectedSourceBox,
      selectedPreviewSuggestionBoxIds
    ]
  );
  const plannedFeetByBox = useMemo(() => {
    const mapped = new Map<string, { allocatedFeet: number; coveredFeet: number }>();
    for (let index = 0; index < plannedSelection.allocations.length; index += 1) {
      const allocation = plannedSelection.allocations[index];
      mapped.set(allocation.boxId, {
        allocatedFeet: allocation.allocatedFeet,
        coveredFeet: allocation.coveredFeet
      });
    }
    return mapped;
  }, [plannedSelection.allocations]);

  /**
   * PURPOSE:
   * Keeps allocation dialog draft state aligned with the selected job requirement
   * and clears stale drafts when the dialog closes.
   *
   * AFFECTS:
   * AllocationJobPage, Allocate Film / Allocate Extra dialogs, live allocation
   * preview queries, and stale film-order prompts after allocations apply.
   *
   * WHEN CHANGING THIS, ALSO CHECK:
   * useAllocationJobPageModel, useJobFilmWorkflow, JobWorkflowDialogs, and
   * allocation/remove-box failure handling on the job detail page.
   *
   * COMMON FAILURE MODES:
   * Fresh array resets can cause render loops, stale selected boxes can submit
   * the wrong preview, and repeated failed requests must remain visible.
   */
  useEffect(() => {
    if (!open) {
      setSelectedRequirementId((current) => (current ? '' : current));
      setRequestedFeet((current) => (current ? '' : current));
      setSelectedBoxIds((current) => (current.length ? [] : current));
      setError((current) => (current ? '' : current));
      setCompletedRequirementIds((current) => (current.length ? [] : current));
      setSubmitAction((current) => (current === null ? current : null));
      return;
    }

    const firstSelectable =
      allocatableRequirements.find(
        (entry) =>
          (isExtraFilmMode || entry.remainingFeet > 0) &&
          !completedRequirementIds.includes(entry.requirementId)
      ) || null;
    if (!firstSelectable) {
      onCancel();
      return;
    }

    setSelectedRequirementId(firstSelectable.requirementId);
    setRequestedFeet(isExtraFilmMode ? '0' : String(Math.max(firstSelectable.remainingFeet, 0)));
  }, [allocatableRequirements, completedRequirementIds, isExtraFilmMode, open, onCancel]);

  useEffect(() => {
    if (!selectedRequirement) {
      setRequestedFeet('');
      setSelectedBoxIds([]);
      return;
    }

    setRequestedFeet(isExtraFilmMode ? '0' : String(Math.max(selectedRequirement.remainingFeet, 0)));
    setSelectedBoxIds([]);
    setError('');
  }, [isExtraFilmMode, selectedRequirement?.requirementId]);

  function advanceToNextRequirement(completedRequirementId: string) {
    const nextCompleted = Array.from(new Set([...completedRequirementIds, completedRequirementId]));
    setCompletedRequirementIds(nextCompleted);

    const nextRequirement =
      allocatableRequirements.find(
        (entry) => entry.remainingFeet > 0 && !nextCompleted.includes(entry.requirementId)
      ) || null;

    if (!nextRequirement) {
      onCancel();
      return;
    }

    setSelectedRequirementId(nextRequirement.requirementId);
    setRequestedFeet(String(Math.max(nextRequirement.remainingFeet, 0)));
    setSelectedBoxIds([]);
    setError('');
  }

  if (!open) {
    return null;
  }

  function toggleBox(boxId: string) {
    const normalizedBoxId = String(boxId || '').trim();
    if (!normalizedBoxId) {
      return;
    }

    setSelectedBoxIds((current) =>
      current.includes(normalizedBoxId)
        ? current.filter((value) => value !== normalizedBoxId)
        : [...current, normalizedBoxId]
    );
    setError('');
  }

  function formatAllocationSaveDescription(
    result: Awaited<ReturnType<typeof allocateMutation.mutateAsync>>['result'],
    warnings: string[]
  ) {
    const summary =
      result.allocations.length > 0
        ? result.allocations
            .map((entry) =>
              entry.coveredFeet !== entry.allocatedFeet
                ? `${entry.boxId}: ${entry.allocatedFeet} LF physical / ${entry.coveredFeet} LF covered`
                : `${entry.boxId}: ${entry.allocatedFeet} LF`
            )
            .join(', ')
        : 'No matching boxes covered this request.';
    const remainingSuffix =
      result.remainingUncoveredFeet > 0
        ? ` ${result.remainingUncoveredFeet} LF remains unallocated. Create a film order separately if needed.`
        : '';

    return formatMutationWarningDescription(
      warnings,
      `${summary}.${remainingSuffix}`.trim(),
      'job-allocate-film'
    );
  }

  function getAllocationSuccessTitle(
    _result: Awaited<ReturnType<typeof allocateMutation.mutateAsync>>['result']
  ) {
    return isExtraFilmMode ? 'Extra film allocated' : 'Allocation saved';
  }

  async function submitAllocation(
    payload: Parameters<typeof allocateMutation.mutateAsync>[0]
  ) {
    const { result, warnings } = await allocateMutation.mutateAsync(payload);
    toast.push({
      title: getAllocationSuccessTitle(result),
      description: formatAllocationSaveDescription(result, warnings),
      variant: 'success'
    });
    return result;
  }

  async function submitFilmOrder(
    payload: Parameters<typeof createFilmOrderMutation.mutateAsync>[0]
  ) {
    await createFilmOrderMutation.mutateAsync(payload);
    toast.push({
      title: 'Film order created',
      description: `The requested film for job ${jobNumber} is now queued for ordering.`,
      variant: 'success'
    });
  }

  async function handleAllocate() {
    if (!selectedRequirement) {
      setError('Select a requirement line first.');
      return;
    }

    if (submitAction) {
      return;
    }

    if (installDate.trim() && !crewLeader.trim()) {
      setError('Crew Leader is required when Install Date is set.');
      return;
    }

    const sourceBox = selectedSourceBox;
    if (!sourceBox) {
      setError('Select at least one valid box to allocate.');
      return;
    }

    if (!isExtraFilmMode && requestedFeetValue <= 0) {
      setError('Requested LF must be greater than zero.');
      return;
    }

    if (!isExtraFilmMode && requestedFeetValue > selectedRequirement.remainingFeet) {
      setError('Requested LF cannot exceed the selected requirement remaining LF.');
      return;
    }

    const extraAllocations = isExtraFilmMode
      ? buildFullBoxExtraAllocations(prioritizedMatchingBoxes, selectedBoxIds)
      : { extraAllocations: [], error: '' };
    if (extraAllocations.error) {
      setError(extraAllocations.error);
      return;
    }

    if (isExtraFilmMode && !extraAllocations.extraAllocations.length) {
      setError('Select at least one box to allocate as extra film.');
      return;
    }

    const payload = {
      ...(jobId ? { jobId } : {}),
      boxId: sourceBox.boxId,
      jobNumber,
      installDate: installDate || '',
      crewLeader: crewLeader || '',
      requestedFeet: isExtraFilmMode ? 0 : requestedFeetValue,
      requestedWidthIn: selectedRequirement.widthIn,
      requirementId: selectedRequirement.requirementId,
      selectedSuggestionBoxIds: isExtraFilmMode || !activePreview ? [] : selectedPreviewSuggestionBoxIds,
      extraAllocations: extraAllocations.extraAllocations.map(({ boxId, allocatedFeet }) => ({
        boxId,
        allocatedFeet
      })),
      crossWarehouse: true,
      jobWarehouse: warehouse
    };

    const completedRequirementId = selectedRequirement.requirementId;
    const previousFilmOrderCoverageSnapshot = cloneFilmOrderPromptSnapshot(requirements, filmOrders);
    setError('');
    setSubmitAction('allocate');
    try {
      const result = await submitAllocation(payload);
      if (!isExtraFilmMode) {
        await onRequirementAllocationApplied?.(previousFilmOrderCoverageSnapshot);
      }
      const coveredRequirementFeet = result.allocations.reduce(
        (sum, entry) => sum + Number(entry.coveredFeet ?? entry.allocatedFeet ?? 0),
        0
      );
      const remainingRequirementFeet = Math.max(selectedRequirement.remainingFeet - coveredRequirementFeet, 0);

      if (isExtraFilmMode) {
        onCancel();
        return;
      }

      if (remainingRequirementFeet > 0) {
        setRequestedFeet(String(remainingRequirementFeet));
        setSelectedBoxIds([]);
        setError('');
        return;
      }

      advanceToNextRequirement(completedRequirementId);
    } catch (submitError) {
      toast.push({
        title: 'Allocation failed',
        description: submitError instanceof Error ? submitError.message : 'The allocation could not be completed.',
        variant: 'error'
      });
    } finally {
      setSubmitAction(null);
    }
  }

  async function handleOrderFilm() {
    if (!selectedRequirement) {
      setError('Select a requirement line first.');
      return;
    }

    if (submitAction) {
      return;
    }

    if (!auth.clientIdConfigured) {
      toast.push({
        title: 'Sign-in is not configured',
        description: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before creating film orders.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with email/password before creating a film order.',
        variant: 'error'
      });
      return;
    }

    if (requestedFeetValue <= 0) {
      setError('Requested LF must be greater than zero.');
      return;
    }

    if (requestedFeetValue > selectedRequirement.remainingFeet) {
      setError('Requested LF cannot exceed the selected requirement remaining LF.');
      return;
    }

    setError('');
    setSubmitAction('order');
    try {
      await submitFilmOrder({
        ...(jobId ? { jobId, requirementId: selectedRequirement.requirementId } : {}),
        jobNumber,
        warehouse,
        manufacturer: selectedRequirement.manufacturer,
        filmName: selectedRequirement.filmName,
        widthIn: selectedRequirement.widthIn,
        requestedFeet: requestedFeetValue
      });
      advanceToNextRequirement(selectedRequirement.requirementId);
    } catch (submitError) {
      toast.push({
        title: 'Unable to create film order',
        description: submitError instanceof Error ? submitError.message : 'The create request failed.',
        variant: 'error'
      });
    } finally {
      setSubmitAction(null);
    }
  }

  const isSubmitting = submitAction !== null;
  const hasPreferredLinkedBoxes = preferredLinkedBoxIds.size > 0;
  const hasTransferCandidates = prioritizedMatchingBoxes.some((box) => box.status === 'TRANSFER');
  const canSubmitAllocation = isExtraFilmMode
    ? selectedBoxIds.length > 0
    : selectedRequirement
      ? selectedBoxIds.length > 0 &&
        requestedFeetValue > 0 &&
        requestedFeetValue <= selectedRequirement.remainingFeet
      : false;
  const showsRemainingUncoveredNotice =
    !isExtraFilmMode &&
    selectedBoxIds.length > 0 &&
    plannedSelection.remainingFeet > 0 &&
    Boolean(activePreview);

  return (
    <DialogSurface open={open} onClose={onCancel} className="dialog-job-allocate" titleId="job-allocate-dialog-title">
        <div className="dialog-header">
          <h2 id="job-allocate-dialog-title">
            {isExtraFilmMode ? 'Allocate Extra Job Film' : 'Allocate Job Film'}
          </h2>
          <button type="button" className="dialog-close" aria-label="Close allocation dialog" onClick={onCancel}>
            x
          </button>
        </div>

        <RequirementFields
          allocatableRequirements={allocatableRequirements}
          isExtraFilmMode={isExtraFilmMode}
          selectedRequirementId={selectedRequirementId}
          requestedFeet={requestedFeet}
          onRequirementChange={setSelectedRequirementId}
          onRequestedFeetChange={(nextRequestedFeet) => {
            setRequestedFeet(nextRequestedFeet.replace(/[^0-9]/g, ''));
            setSelectedBoxIds([]);
            setError('');
          }}
        />

        <StatusMessages
          selectedRequirement={selectedRequirement}
          isExtraFilmMode={isExtraFilmMode}
          isMatchingBoxesLoading={isMatchingBoxesLoading}
          isAllocationPreviewLoading={isAllocationPreviewLoading}
          prioritizedMatchingBoxesCount={prioritizedMatchingBoxes.length}
          selectedBoxCount={selectedBoxIds.length}
          hasPreferredLinkedBoxes={hasPreferredLinkedBoxes}
          hasTransferCandidates={hasTransferCandidates}
          showsRemainingUncoveredNotice={showsRemainingUncoveredNotice}
          remainingUncoveredFeet={plannedSelection.remainingFeet}
          installDate={installDate}
          crewLeader={crewLeader}
          previewError={previewQuery.isError && previewQuery.error instanceof Error ? previewQuery.error : null}
          activePreviewLoaded={Boolean(activePreview)}
          error={error}
        />

        {!isMatchingBoxesLoading && prioritizedMatchingBoxes.length ? (
          <AllocationPlanTable
            isExtraFilmMode={isExtraFilmMode}
            boxes={prioritizedMatchingBoxes}
            requestedFeetValue={requestedFeetValue}
            coveredFeet={plannedSelection.coveredFeet}
            remainingFeet={plannedSelection.remainingFeet}
            selectedBoxIds={selectedBoxIds}
            plannedFeetByBox={plannedFeetByBox}
            onToggleBox={toggleBox}
          />
        ) : null}

        <ActionBar
          isSubmitting={isSubmitting}
          isOrderFilmMode={isOrderFilmMode}
          isMatchingBoxesLoading={isMatchingBoxesLoading}
          isAllocatePending={submitAction === 'allocate'}
          isCreateFilmOrderPending={submitAction === 'order'}
          canSubmit={isOrderFilmMode || canSubmitAllocation}
          allocateLabel={isExtraFilmMode ? 'Allocate Extra' : 'Allocate'}
          onCancel={onCancel}
          onSubmit={isOrderFilmMode ? () => void handleOrderFilm() : () => void handleAllocate()}
        />
    </DialogSurface>
  );
}
