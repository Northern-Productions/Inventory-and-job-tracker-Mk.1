import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import { Input } from '../../../components/Input';
import { useToast } from '../../../components/Toast';
import { searchBoxes } from '../../../api/features/inventoryClient';
import { useAuth } from '../../auth/AuthContext';
import { planCoverageAllocation } from '../../../domain/allocationCoverageContract.mjs';
import type { AllocationPreview, FilmOrderEntry, JobRequirementLine, Warehouse } from '../../../domain';
import {
  useAllocateBox,
  useAllocationPreview,
  useCreateFilmOrder
} from '../hooks/useInventoryQueries';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { findMatchingBoxesForRequirement } from '../utils/jobAllocationMatching';
import { prioritizeCandidateBoxes } from '../utils/jobAllocationSelection';
import { canJobPlanningFilmSatisfyRequirement } from '../utils/jobPlanningFilmIdentity';

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

function collectPreferredLinkedBoxIds(
  requirement: JobRequirementLine | null,
  filmOrders: FilmOrderEntry[]
) {
  if (!requirement) {
    return new Set<string>();
  }
  const preferred = new Set<string>();

  for (let index = 0; index < filmOrders.length; index += 1) {
    const order = filmOrders[index];
    if (order.status === 'CANCELLED') {
      continue;
    }

    if (
      !canJobPlanningFilmSatisfyRequirement(
        order.manufacturer,
        order.filmName,
        requirement.manufacturer,
        requirement.filmName
      )
    ) {
      continue;
    }

    if (order.widthIn < requirement.widthIn) {
      continue;
    }

    for (let linkIndex = 0; linkIndex < order.linkedBoxes.length; linkIndex += 1) {
      const boxId = String(order.linkedBoxes[linkIndex].boxId || '').trim();
      if (boxId) {
        preferred.add(boxId);
      }
    }
  }

  return preferred;
}

function formatPlannedFeet(allocatedFeet: number, coveredFeet: number) {
  if (coveredFeet > 0 && coveredFeet !== allocatedFeet) {
    return `${allocatedFeet} physical / ${coveredFeet} covered`;
  }

  return String(allocatedFeet);
}

function buildSelectionSummary(preview: AllocationPreview, selectedSuggestionBoxIds: string[]) {
  const selected = new Set(selectedSuggestionBoxIds);
  const allocations: Array<{ boxId: string; allocatedFeet: number; coveredFeet: number }> = [];
  let remaining = preview.requestedFeet;

  if (preview.sourceSuggestedFeet > 0) {
    const sourcePlan = planCoverageAllocation(
      remaining,
      preview.sourceSuggestedFeet,
      preview.sourceWidthIn,
      preview.requestedWidthIn
    );
    allocations.push({
      boxId: preview.sourceBoxId,
      allocatedFeet: sourcePlan.allocatedFeet,
      coveredFeet: sourcePlan.coveredFeet
    });
    remaining = sourcePlan.remainingCoveredFeet;
  }

  for (let index = 0; index < preview.suggestions.length; index += 1) {
    const suggestion = preview.suggestions[index];
    if (!selected.has(suggestion.boxId) || remaining <= 0) {
      continue;
    }

    const nextPlan = planCoverageAllocation(
      remaining,
      suggestion.availableFeet,
      suggestion.widthIn,
      preview.requestedWidthIn
    );
    allocations.push({
      boxId: suggestion.boxId,
      allocatedFeet: nextPlan.allocatedFeet,
      coveredFeet: nextPlan.coveredFeet
    });
    remaining = nextPlan.remainingCoveredFeet;
  }

  return {
    allocations,
    coveredFeet: preview.requestedFeet - remaining,
    remainingFeet: remaining
  };
}

function previewMatchesPayload(
  preview: AllocationPreview | null | undefined,
  payload:
    | {
        boxId: string;
        jobNumber: string;
        jobDate: string;
        crewLeader: string;
        requestedFeet: number;
        requestedWidthIn: number;
        requirementId: string;
        crossWarehouse: boolean;
        jobWarehouse: Warehouse;
      }
    | null
) {
  if (!preview || !payload) {
    return false;
  }

  return (
    preview.sourceBoxId === payload.boxId &&
    preview.jobNumber === payload.jobNumber &&
    String(preview.jobDate || '') === String(payload.jobDate || '') &&
    String(preview.crewLeader || '') === String(payload.crewLeader || '') &&
    preview.requestedFeet === payload.requestedFeet &&
    preview.requestedWidthIn === payload.requestedWidthIn
  );
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
  const autoSelectionKeyRef = useRef('');
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
    () => prioritizeCandidateBoxes(matchingBoxes, preferredLinkedBoxIds),
    [matchingBoxes, preferredLinkedBoxIds]
  );
  const requestedFeetValue = useMemo(() => {
    const parsed = Number(requestedFeet);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }

    return Math.floor(parsed);
  }, [requestedFeet]);
  const selectedSourceBox = useMemo(
    () =>
      prioritizedMatchingBoxes.find((box) => selectedBoxIds.includes(box.boxId)) ||
      prioritizedMatchingBoxes[0] ||
      null,
    [prioritizedMatchingBoxes, selectedBoxIds]
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
        ? selectedBoxIds.filter(
            (boxId) => boxId !== activePreview.sourceBoxId && previewSuggestionBoxIdSet.has(boxId)
          )
        : [],
    [activePreview, previewSuggestionBoxIdSet, selectedBoxIds]
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
      autoSelectionKeyRef.current = '';
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
    autoSelectionKeyRef.current = '';
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
    autoSelectionKeyRef.current = '';
    setError('');
  }

  useEffect(() => {
    if (!open || !selectedRequirement || requestedFeetValue <= 0 || !selectedSourceBox) {
      return;
    }

    const nextKey = activePreview
      ? `${selectedRequirement.requirementId}|${requestedFeetValue}|${activePreview.sourceBoxId}|${activePreview.suggestions
          .map(
            (suggestion) =>
              `${suggestion.boxId}:${suggestion.availableFeet}:${suggestion.suggestedFeet}:${suggestion.suggestedCoveredFeet}`
          )
          .join('|')}`
      : `${selectedRequirement.requirementId}|${requestedFeetValue}|${selectedSourceBox.boxId}`;
    if (autoSelectionKeyRef.current === nextKey) {
      return;
    }

    autoSelectionKeyRef.current = nextKey;
    if (activePreview) {
      setSelectedBoxIds([
        activePreview.sourceBoxId,
        ...activePreview.suggestions
          .filter((suggestion) => suggestion.suggestedCoveredFeet > 0)
          .map((suggestion) => suggestion.boxId)
      ]);
      return;
    }

    setSelectedBoxIds([selectedSourceBox.boxId]);
  }, [activePreview, open, requestedFeetValue, selectedRequirement, selectedSourceBox]);

  if (!open) {
    return null;
  }

  function toggleBox(boxId: string) {
    const isSelectableSuggestion =
      activePreview &&
      boxId !== activePreview.sourceBoxId &&
      previewSuggestionBoxIdSet.has(boxId);

    if (!isSelectableSuggestion) {
      autoSelectionKeyRef.current = '';
      setSelectedBoxIds([boxId]);
      setError('');
      return;
    }

    setSelectedBoxIds((current) =>
      current.includes(boxId) ? current.filter((value) => value !== boxId) : [...current, boxId]
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

    if (!selectedBoxIds.length) {
      setError('Select at least one box to allocate.');
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

        <div className="form-grid">
          <label className="field">
            <span className="field-label">Requirement</span>
            <select
              className="field-input"
              value={selectedRequirementId}
              onChange={(event) => setSelectedRequirementId(event.target.value)}
            >
              {allocatableRequirements.map((entry) => (
                <option key={entry.requirementId} value={entry.requirementId}>
                  {entry.manufacturer} {entry.filmName} {entry.widthIn}" ({entry.remainingFeet} LF remaining)
                </option>
              ))}
            </select>
          </label>
          <Input
            label="Requested LF"
            value={requestedFeet}
            inputMode="numeric"
            pattern="[0-9]*"
            onChange={(event) => {
              setRequestedFeet(event.target.value.replace(/[^0-9]/g, ''));
              setSelectedBoxIds([]);
              autoSelectionKeyRef.current = '';
              setError('');
            }}
          />
        </div>

        {isMatchingBoxesLoading ? <p className="muted-text">Loading compatible boxes...</p> : null}
        {!isMatchingBoxesLoading && isAllocationPreviewLoading ? (
          <p className="muted-text">Loading the live allocation plan...</p>
        ) : null}
        {!isMatchingBoxesLoading && selectedRequirement && !prioritizedMatchingBoxes.length ? (
          <p className="muted-text">
            No compatible boxes were found for this requirement (matching film family, width at or above
            requested). Create a film-order alert instead.
          </p>
        ) : null}
        {dueDate.trim() && !crewLeader.trim() ? (
          <p className="error-text">CrewLeader is required when JobDate is set.</p>
        ) : null}
        {!isMatchingBoxesLoading && hasPreferredLinkedBoxes && prioritizedMatchingBoxes.length ? (
          <p className="muted-text">
            Boxes linked to this job's film orders are prioritized and auto-selected first.
          </p>
        ) : null}
        {!isMatchingBoxesLoading && previewQuery.isError && !activePreview ? (
          <p className="error-text">
            {previewQuery.error instanceof Error
              ? previewQuery.error.message
              : 'Unable to load the live allocation plan.'}
          </p>
        ) : null}

        {error ? <p className="error-text">{error}</p> : null}

        {!isMatchingBoxesLoading && prioritizedMatchingBoxes.length ? (
          <div className="allocation-preview">
            <div className="stat-grid allocation-stat-grid">
              <div className="key-value">
                <dt>Requested</dt>
                <dd>{requestedFeetValue}</dd>
              </div>
              <div className="key-value">
                <dt>Covered</dt>
                <dd>{plannedSelection.coveredFeet}</dd>
              </div>
              <div className="key-value">
                <dt>Still Short</dt>
                <dd>{plannedSelection.remainingFeet}</dd>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Use</th>
                    <th>Box</th>
                    <th>Manufacturer</th>
                    <th>Film Name</th>
                    <th>Width</th>
                    <th>Avail LF</th>
                    <th>Planned LF</th>
                  </tr>
                </thead>
                <tbody>
                  {prioritizedMatchingBoxes.map((box) => (
                    <tr key={box.boxId}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedBoxIds.includes(box.boxId)}
                          onChange={() => toggleBox(box.boxId)}
                        />
                      </td>
                      <td>{box.boxId}</td>
                      <td>{box.manufacturer}</td>
                      <td>{box.filmName}</td>
                      <td>{box.widthIn}</td>
                      <td>{box.feetAvailable}</td>
                      <td>
                        {plannedFeetByBox.has(box.boxId)
                          ? formatPlannedFeet(
                              plannedFeetByBox.get(box.boxId)?.allocatedFeet || 0,
                              plannedFeetByBox.get(box.boxId)?.coveredFeet || 0
                            )
                          : '0'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        <div className="dialog-actions dialog-actions-sticky-footer">
          <Button type="button" variant="ghost" fullWidth onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            fullWidth
            onClick={isOrderFilmMode ? () => void handleOrderFilm() : () => void handleAllocate()}
            disabled={isMatchingBoxesLoading || isAllocationPreviewLoading || isSubmitting}
          >
            {isOrderFilmMode
              ? createFilmOrderMutation.isPending
                ? 'Ordering...'
                : 'Order Film'
              : allocateMutation.isPending
                ? 'Saving...'
                : 'Allocate'}
          </Button>
        </div>
    </DialogSurface>
  );
}
