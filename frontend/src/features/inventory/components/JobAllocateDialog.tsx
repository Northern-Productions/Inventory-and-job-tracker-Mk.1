import { useEffect, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import { useToast } from '../../../components/Toast';
import { searchBoxes } from '../../../api/features/inventoryClient';
import { useAuth } from '../../auth/AuthContext';
import type { AllocationPreview, FilmOrderEntry, JobRequirementLine, Warehouse } from '../../../domain';
import {
  useAllocateBox,
  useAllocationPreview,
  useCreateFilmOrder
} from '../hooks/useInventoryQueries';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { findMatchingBoxesForRequirement } from '../utils/jobAllocationMatching';
import { prioritizeCandidateBoxes } from '../utils/jobAllocationSelection';
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
  dueDate: string;
  crewLeader: string;
  requirements: JobRequirementLine[];
  filmOrders: FilmOrderEntry[];
  onCancel: () => void;
}

export function JobAllocateDialog({
  open,
  jobNumber,
  warehouse,
  dueDate,
  crewLeader,
  requirements,
  filmOrders,
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
  const allocatableRequirements = useMemo(
    () => requirements.filter((entry) => entry.remainingFeet > 0),
    [requirements]
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
  const matchingBoxesQueries = useQueries({
    queries: searchableWarehouses.map((warehouseCode) => ({
      queryKey: [
        'inventory',
        'search',
        'job-allocate',
        warehouseCode,
        searchableManufacturer,
        searchableFilmName,
        'active'
      ] as const,
      queryFn: () =>
        searchBoxes({
          warehouse: warehouseCode,
          manufacturer: searchableManufacturer,
          q: searchableFilmName,
          showRetired: false
        }),
      enabled: shouldSearchMatchingBoxes
    }))
  });
  const searchableBoxes = useMemo(
    () => matchingBoxesQueries.flatMap((query) => query.data || []),
    [matchingBoxesQueries]
  );
  const matchingBoxes = useMemo(() => {
    if (!selectedRequirement) {
      return [];
    }

    return findMatchingBoxesForRequirement(searchableBoxes, selectedRequirement);
  }, [searchableBoxes, selectedRequirement]);
  const preferredLinkedBoxIds = useMemo(
    () => collectPreferredLinkedBoxIds(selectedRequirement, filmOrders),
    [filmOrders, selectedRequirement]
  );
  const prioritizedMatchingBoxes = useMemo(
    () => prioritizeCandidateBoxes(matchingBoxes, preferredLinkedBoxIds, warehouse),
    [matchingBoxes, preferredLinkedBoxIds, warehouse]
  );
  const requestedFeetValue = useMemo(() => {
    const parsed = Number(requestedFeet);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }

    return Math.floor(parsed);
  }, [requestedFeet]);
  const selectedSourceBoxId = selectedBoxIds[0] || '';
  const selectedSuggestionBoxIds = selectedBoxIds.slice(1);
  const selectedSourceBox = useMemo(
    () => prioritizedMatchingBoxes.find((box) => box.boxId === selectedSourceBoxId) || null,
    [prioritizedMatchingBoxes, selectedSourceBoxId]
  );
  const previewPayload = useMemo(
    () =>
      open && selectedRequirement && requestedFeetValue > 0 && selectedSourceBox
        ? {
            boxId: selectedSourceBox.boxId,
            jobNumber,
            jobDate: dueDate || '',
            crewLeader: crewLeader || '',
            requestedFeet: requestedFeetValue,
            requestedWidthIn: selectedRequirement.widthIn,
            requirementId: selectedRequirement.requirementId,
            crossWarehouse: true,
            jobWarehouse: warehouse
          }
        : null,
    [crewLeader, dueDate, jobNumber, open, requestedFeetValue, selectedRequirement, selectedSourceBox, warehouse]
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
  const isMatchingBoxesLoading = matchingBoxesQueries.some(
    (query) => query.isLoading || query.isFetching
  );
  const isAllocationPreviewLoading =
    Boolean(previewPayload) && !activePreview && !previewQuery.isError;
  const isOrderFilmMode =
    !isMatchingBoxesLoading &&
    Boolean(selectedRequirement) &&
    !prioritizedMatchingBoxes.length;
  const plannedSelection = useMemo(
    () =>
      activePreview
        ? buildSelectionSummary(activePreview, selectedPreviewSuggestionBoxIds)
        : {
            allocations: [],
            coveredFeet: 0,
            remainingFeet: requestedFeetValue
          },
    [activePreview, requestedFeetValue, selectedPreviewSuggestionBoxIds]
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

    const firstRemaining =
      allocatableRequirements.find(
        (entry) => entry.remainingFeet > 0 && !completedRequirementIds.includes(entry.requirementId)
      ) || null;
    if (!firstRemaining) {
      onCancel();
      return;
    }

    setSelectedRequirementId(firstRemaining.requirementId);
    setRequestedFeet(String(Math.max(firstRemaining.remainingFeet, 0)));
  }, [allocatableRequirements, completedRequirementIds, open, onCancel]);

  useEffect(() => {
    if (!selectedRequirement) {
      setRequestedFeet('');
      setSelectedBoxIds([]);
      return;
    }

    setRequestedFeet(String(Math.max(selectedRequirement.remainingFeet, 0)));
    setSelectedBoxIds([]);
    setError('');
  }, [selectedRequirement?.requirementId]);

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

  async function handleAllocate() {
    if (!selectedRequirement) {
      setError('Select a requirement line first.');
      return;
    }

    if (dueDate.trim() && !crewLeader.trim()) {
      setError('CrewLeader is required when JobDate is set.');
      return;
    }

    const sourceBox = selectedSourceBox;
    if (!sourceBox) {
      setError('Select at least one valid box to allocate.');
      return;
    }

    if (previewQuery.isError && !activePreview) {
      setError(previewQuery.error.message || 'Unable to load the live allocation plan.');
      return;
    }

    if (previewPayload && !activePreview) {
      setError('Loading the live allocation plan. Try again in a moment.');
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

    try {
      const { result, warnings } = await allocateMutation.mutateAsync({
        boxId: sourceBox.boxId,
        jobNumber,
        jobDate: dueDate || '',
        crewLeader: crewLeader || '',
        requestedFeet: requestedFeetValue,
        requestedWidthIn: selectedRequirement.widthIn,
        requirementId: selectedRequirement.requirementId,
        selectedSuggestionBoxIds: activePreview ? selectedPreviewSuggestionBoxIds : [],
        extraAllocations: [],
        crossWarehouse: true,
        jobWarehouse: warehouse
      });

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

      toast.push({
        title: 'Allocation saved',
        description: warnings.join(' ') || `${summary}.${filmOrderSuffix}`.trim(),
        variant: 'success'
      });
      advanceToNextRequirement(selectedRequirement.requirementId);
    } catch (submitError) {
      toast.push({
        title: 'Allocation failed',
        description: submitError instanceof Error ? submitError.message : 'The allocation could not be completed.',
        variant: 'error'
      });
    }
  }

  async function handleOrderFilm() {
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

    try {
      await createFilmOrderMutation.mutateAsync({
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
    }
  }

  const isSubmitting = allocateMutation.isPending || createFilmOrderMutation.isPending;
  const hasPreferredLinkedBoxes = preferredLinkedBoxIds.size > 0;

  return (
    <DialogSurface open={open} onClose={onCancel} className="dialog-job-allocate" titleId="job-allocate-dialog-title">
        <div className="dialog-header">
          <h2 id="job-allocate-dialog-title">Allocate Job Film</h2>
          <button type="button" className="dialog-close" aria-label="Close allocation dialog" onClick={onCancel}>
            x
          </button>
        </div>

        <RequirementFields
          allocatableRequirements={allocatableRequirements}
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
          isMatchingBoxesLoading={isMatchingBoxesLoading}
          isAllocationPreviewLoading={isAllocationPreviewLoading}
          prioritizedMatchingBoxesCount={prioritizedMatchingBoxes.length}
          selectedBoxCount={selectedBoxIds.length}
          hasPreferredLinkedBoxes={hasPreferredLinkedBoxes}
          dueDate={dueDate}
          crewLeader={crewLeader}
          previewError={previewQuery.isError && previewQuery.error instanceof Error ? previewQuery.error : null}
          activePreviewLoaded={Boolean(activePreview)}
          error={error}
        />

        {!isMatchingBoxesLoading && prioritizedMatchingBoxes.length ? (
          <AllocationPlanTable
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
          isAllocatePending={allocateMutation.isPending}
          isCreateFilmOrderPending={createFilmOrderMutation.isPending}
          canSubmit={isOrderFilmMode || selectedBoxIds.length > 0}
          onCancel={onCancel}
          onSubmit={isOrderFilmMode ? () => void handleOrderFilm() : () => void handleAllocate()}
        />
    </DialogSurface>
  );
}
