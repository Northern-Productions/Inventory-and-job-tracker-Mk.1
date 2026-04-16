import { useEffect, useMemo, useState } from 'react';
import { DialogSurface } from '../../../components/DialogSurface';
import { useToast } from '../../../components/Toast';
import { useAuth } from '../../auth/AuthContext';
import type { FilmOrderEntry, JobRequirementLine, Warehouse } from '../../../domain';
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
  buildSelectionSummary,
  collectPreferredLinkedBoxIds,
  previewMatchesPayload
} from './job-allocate-dialog/helpers';

interface JobAllocateDialogProps {
  open: boolean;
  jobNumber: string;
  warehouse: Warehouse;
  installDate: string;
  crewLeader: string;
  requirements: JobRequirementLine[];
  filmOrders: FilmOrderEntry[];
  isExtraFilmMode?: boolean;
  onCancel: () => void;
}

export function JobAllocateDialog({
  open,
  jobNumber,
  warehouse,
  installDate,
  crewLeader,
  requirements,
  filmOrders,
  isExtraFilmMode = false,
  onCancel
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
  const [pendingBackgroundActionCount, setPendingBackgroundActionCount] = useState(0);
  const allocatableRequirements = useMemo(
    () =>
      isExtraFilmMode
        ? requirements.filter((entry) => entry.requiredFeet > 0)
        : requirements.filter((entry) => entry.remainingFeet > 0),
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
        : {
            allocations: [],
            coveredFeet: 0,
            remainingFeet: requestedFeetValue
          };
    },
    [
      activePreview,
      isExtraFilmMode,
      prioritizedMatchingBoxes,
      requestedFeetValue,
      selectedBoxIds,
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

  useEffect(() => {
    if (!open) {
      setSelectedRequirementId('');
      setRequestedFeet('');
      setSelectedBoxIds([]);
      setError('');
      setCompletedRequirementIds([]);
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
    const filmOrderSuffix = result.filmOrder
      ? ` Film Order ${result.filmOrder.filmOrderId} was created for ${result.remainingUncoveredFeet} LF.`
      : '';

    return warnings.join(' ') || `${summary}.${filmOrderSuffix}`.trim();
  }

  function submitAllocationInBackground(
    payload: Parameters<typeof allocateMutation.mutateAsync>[0],
    successTitle: string
  ) {
    setPendingBackgroundActionCount((current) => current + 1);
    const savePromise = allocateMutation.mutateAsync(payload);

    void savePromise
      .then(({ result, warnings }) => {
        toast.push({
          title: successTitle,
          description: formatAllocationSaveDescription(result, warnings),
          variant: 'success'
        });
      })
      .catch((submitError) => {
        toast.push({
          title: 'Allocation failed',
          description: submitError instanceof Error ? submitError.message : 'The allocation could not be completed.',
          variant: 'error'
        });
      })
      .finally(() => {
        setPendingBackgroundActionCount((current) => Math.max(0, current - 1));
      });
  }

  function submitFilmOrderInBackground(
    payload: Parameters<typeof createFilmOrderMutation.mutateAsync>[0],
    completedRequirementId: string
  ) {
    setPendingBackgroundActionCount((current) => current + 1);
    advanceToNextRequirement(completedRequirementId);

    const createPromise = createFilmOrderMutation.mutateAsync(payload);
    void createPromise
      .then(() => {
        toast.push({
          title: 'Film order created',
          description: `The requested film for job ${jobNumber} is now queued for ordering.`,
          variant: 'success'
        });
      })
      .catch((submitError) => {
        toast.push({
          title: 'Unable to create film order',
          description: submitError instanceof Error ? submitError.message : 'The create request failed.',
          variant: 'error'
        });
      })
      .finally(() => {
        setPendingBackgroundActionCount((current) => Math.max(0, current - 1));
      });
  }

  function handleAllocate() {
    if (!selectedRequirement) {
      setError('Select a requirement line first.');
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

    if (!isExtraFilmMode && previewQuery.isError && !activePreview) {
      setError(previewQuery.error.message || 'Unable to load the live allocation plan.');
      return;
    }

    if (!isExtraFilmMode && previewPayload && !activePreview) {
      setError('Loading the live allocation plan. Try again in a moment.');
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
    setError('');
    submitAllocationInBackground(payload, isExtraFilmMode ? 'Extra film allocated' : 'Allocation saved');

    if (isExtraFilmMode) {
      onCancel();
      return;
    }

    advanceToNextRequirement(completedRequirementId);
  }

  function handleOrderFilm() {
    if (!selectedRequirement) {
      setError('Select a requirement line first.');
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
    submitFilmOrderInBackground(
      {
        jobNumber,
        warehouse,
        manufacturer: selectedRequirement.manufacturer,
        filmName: selectedRequirement.filmName,
        widthIn: selectedRequirement.widthIn,
        requestedFeet: requestedFeetValue
      },
      selectedRequirement.requirementId
    );
  }

  const isSubmitting = false;
  const hasPreferredLinkedBoxes = preferredLinkedBoxIds.size > 0;
  const hasTransferCandidates = prioritizedMatchingBoxes.some((box) => box.status === 'TRANSFER');

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
          pendingBackgroundActionCount={pendingBackgroundActionCount}
          prioritizedMatchingBoxesCount={prioritizedMatchingBoxes.length}
          selectedBoxCount={selectedBoxIds.length}
          hasPreferredLinkedBoxes={hasPreferredLinkedBoxes}
          hasTransferCandidates={hasTransferCandidates}
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
          isAllocationPreviewLoading={isAllocationPreviewLoading}
          isAllocatePending={false}
          isCreateFilmOrderPending={false}
          canSubmit={isOrderFilmMode || selectedBoxIds.length > 0}
          allocateLabel={isExtraFilmMode ? 'Allocate Extra' : 'Allocate'}
          onCancel={onCancel}
          onSubmit={isOrderFilmMode ? () => void handleOrderFilm() : () => void handleAllocate()}
        />
    </DialogSurface>
  );
}
