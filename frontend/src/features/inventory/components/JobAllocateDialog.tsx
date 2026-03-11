import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Input';
import { useToast } from '../../../components/Toast';
import { useAuth } from '../../auth/AuthContext';
import type { FilmOrderEntry, JobRequirementLine, Warehouse } from '../../../domain';
import {
  useAllocateBox,
  useCreateFilmOrder,
  useSearchBoxesWithOptions
} from '../hooks/useInventoryQueries';
import { findMatchingBoxesForRequirement } from '../utils/jobAllocationMatching';
import {
  autoSelectCandidateBoxIds,
  planSelectedCandidateAllocation,
  prioritizeCandidateBoxes
} from '../utils/jobAllocationSelection';

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

function normalizeLookup(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function collectPreferredLinkedBoxIds(
  requirement: JobRequirementLine | null,
  filmOrders: FilmOrderEntry[]
) {
  if (!requirement) {
    return new Set<string>();
  }

  const targetManufacturer = normalizeLookup(requirement.manufacturer);
  const targetFilmName = normalizeLookup(requirement.filmName);
  const preferred = new Set<string>();

  for (let index = 0; index < filmOrders.length; index += 1) {
    const order = filmOrders[index];
    if (order.status === 'CANCELLED') {
      continue;
    }

    if (normalizeLookup(order.manufacturer) !== targetManufacturer) {
      continue;
    }

    if (normalizeLookup(order.filmName) !== targetFilmName) {
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
  const autoSelectionKeyRef = useRef('');
  const selectedRequirement = useMemo(
    () => requirements.find((entry) => entry.requirementId === selectedRequirementId) || null,
    [requirements, selectedRequirementId]
  );
  const searchableFilmName = selectedRequirement ? selectedRequirement.filmName.trim() : '';
  const shouldSearchMatchingBoxes = open && Boolean(selectedRequirement);
  const ilBoxesQuery = useSearchBoxesWithOptions(
    {
      warehouse: 'IL',
      film: searchableFilmName,
      showRetired: false
    },
    { enabled: shouldSearchMatchingBoxes }
  );
  const msBoxesQuery = useSearchBoxesWithOptions(
    {
      warehouse: 'MS',
      film: searchableFilmName,
      showRetired: false
    },
    { enabled: shouldSearchMatchingBoxes }
  );
  const matchingBoxes = useMemo(() => {
    if (!selectedRequirement) {
      return [];
    }

    return findMatchingBoxesForRequirement((ilBoxesQuery.data || []).concat(msBoxesQuery.data || []), selectedRequirement);
  }, [ilBoxesQuery.data, msBoxesQuery.data, selectedRequirement]);
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
  const isMatchingBoxesLoading = ilBoxesQuery.isLoading || msBoxesQuery.isLoading;
  const isOrderFilmMode =
    !isMatchingBoxesLoading &&
    Boolean(selectedRequirement) &&
    !prioritizedMatchingBoxes.length;
  const plannedSelection = useMemo(
    () => planSelectedCandidateAllocation(prioritizedMatchingBoxes, requestedFeetValue, selectedBoxIds),
    [prioritizedMatchingBoxes, requestedFeetValue, selectedBoxIds]
  );
  const plannedFeetByBox = useMemo(() => {
    const mapped = new Map<string, number>();
    for (let index = 0; index < plannedSelection.allocations.length; index += 1) {
      const allocation = plannedSelection.allocations[index];
      mapped.set(allocation.boxId, allocation.allocatedFeet);
    }
    return mapped;
  }, [plannedSelection.allocations]);

  useEffect(() => {
    if (!open) {
      setSelectedRequirementId('');
      setRequestedFeet('');
      setSelectedBoxIds([]);
      setError('');
      autoSelectionKeyRef.current = '';
      return;
    }

    const firstRemaining = requirements.find((entry) => entry.remainingFeet > 0) || requirements[0];
    if (!firstRemaining) {
      return;
    }

    setSelectedRequirementId(firstRemaining.requirementId);
    setRequestedFeet(firstRemaining.remainingFeet > 0 ? String(firstRemaining.remainingFeet) : '');
  }, [open, requirements]);

  useEffect(() => {
    if (!selectedRequirement) {
      setRequestedFeet('');
      setSelectedBoxIds([]);
      return;
    }

    setRequestedFeet(selectedRequirement.remainingFeet > 0 ? String(selectedRequirement.remainingFeet) : '');
    setSelectedBoxIds([]);
    autoSelectionKeyRef.current = '';
    setError('');
  }, [selectedRequirement?.requirementId]);

  useEffect(() => {
    if (!open || !selectedRequirement || requestedFeetValue <= 0 || !prioritizedMatchingBoxes.length) {
      return;
    }

    const preferredKey = Array.from(preferredLinkedBoxIds).sort().join(',');
    const candidateKey = prioritizedMatchingBoxes.map((box) => `${box.boxId}:${box.feetAvailable}`).join('|');
    const nextKey = `${selectedRequirement.requirementId}|${requestedFeetValue}|${preferredKey}|${candidateKey}`;
    if (autoSelectionKeyRef.current === nextKey) {
      return;
    }

    autoSelectionKeyRef.current = nextKey;
    setSelectedBoxIds(
      autoSelectCandidateBoxIds(prioritizedMatchingBoxes, requestedFeetValue, preferredLinkedBoxIds)
    );
  }, [open, preferredLinkedBoxIds, prioritizedMatchingBoxes, requestedFeetValue, selectedRequirement]);

  if (!open) {
    return null;
  }

  function toggleBox(boxId: string) {
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

    if (requestedFeetValue <= 0) {
      setError('Requested LF must be greater than zero.');
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

    const orderedSelectedBoxes = prioritizedMatchingBoxes.filter((box) => selectedBoxIds.includes(box.boxId));
    const sourceBox = orderedSelectedBoxes[0];
    if (!sourceBox) {
      setError('Select at least one valid box to allocate.');
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
        selectedSuggestionBoxIds: orderedSelectedBoxes.slice(1).map((entry) => entry.boxId),
        crossWarehouse: true,
        jobWarehouse: warehouse
      });

      onCancel();

      const summary =
        result.allocations.length > 0
          ? result.allocations.map((entry) => `${entry.boxId}: ${entry.allocatedFeet} LF`).join(', ')
          : 'No matching boxes covered this request.';
      const filmOrderSuffix = result.filmOrder
        ? ` Film Order ${result.filmOrder.filmOrderId} was created for ${result.remainingUncoveredFeet} LF.`
        : '';

      toast.push({
        title: 'Allocation saved',
        description: warnings.join(' ') || `${summary}.${filmOrderSuffix}`.trim(),
        variant: 'success'
      });
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

    try {
      const { result, warnings } = await createFilmOrderMutation.mutateAsync({
        jobNumber,
        warehouse,
        manufacturer: selectedRequirement.manufacturer,
        filmName: selectedRequirement.filmName,
        widthIn: selectedRequirement.widthIn,
        requestedFeet: requestedFeetValue
      });

      onCancel();

      toast.push({
        title: `Film Order ${result.filmOrderId} created`,
        description:
          warnings.join(' ') ||
          `${result.manufacturer} ${result.filmName} ${result.widthIn}" needs ${result.requestedFeet} LF for job ${result.jobNumber}.`,
        variant: 'success'
      });
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
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="job-allocate-dialog-title">
        <div className="dialog-header">
          <h2 id="job-allocate-dialog-title">Allocate Job Film</h2>
          <button type="button" className="dialog-close" aria-label="Close allocation dialog" onClick={onCancel}>
            X
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
              {requirements.map((entry) => (
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

        {isMatchingBoxesLoading ? <p className="muted-text">Loading matching boxes...</p> : null}
        {!isMatchingBoxesLoading && selectedRequirement && !prioritizedMatchingBoxes.length ? (
          <p className="muted-text">
            No matching boxes were found for this requirement (same film, width at or above requested). Create
            a film-order alert instead.
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
                    <th>Warehouse</th>
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
                      <td>{box.warehouse}</td>
                      <td>{box.widthIn}</td>
                      <td>{box.feetAvailable}</td>
                      <td>{plannedFeetByBox.get(box.boxId) || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        <div className="dialog-actions">
          <Button type="button" variant="ghost" fullWidth onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            fullWidth
            onClick={isOrderFilmMode ? () => void handleOrderFilm() : () => void handleAllocate()}
            disabled={isMatchingBoxesLoading || isSubmitting}
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
      </div>
    </div>
  );
}
