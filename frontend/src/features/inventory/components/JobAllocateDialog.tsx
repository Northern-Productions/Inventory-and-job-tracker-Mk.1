import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Input';
import { useToast } from '../../../components/Toast';
import { useAuth } from '../../auth/AuthContext';
import type { JobRequirementLine, Warehouse } from '../../../domain';
import {
  useAllocateBox,
  useAllocationPreview,
  useCreateFilmOrder,
  useSearchBoxes
} from '../hooks/useInventoryQueries';

interface JobAllocateDialogProps {
  open: boolean;
  jobNumber: string;
  warehouse: Warehouse;
  dueDate: string;
  requirements: JobRequirementLine[];
  onCancel: () => void;
}

function normalizeLookup(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function JobAllocateDialog({
  open,
  jobNumber,
  warehouse,
  dueDate,
  requirements,
  onCancel
}: JobAllocateDialogProps) {
  const toast = useToast();
  const auth = useAuth();
  const allocateMutation = useAllocateBox();
  const createFilmOrderMutation = useCreateFilmOrder();
  const [selectedRequirementId, setSelectedRequirementId] = useState('');
  const [requestedFeet, setRequestedFeet] = useState('');
  const [previewPayload, setPreviewPayload] = useState<{
    boxId: string;
    jobNumber: string;
    jobDate?: string;
    requestedFeet: number;
    crossWarehouse?: boolean;
  } | null>(null);
  const [selectedSuggestionBoxIds, setSelectedSuggestionBoxIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const selectedRequirement = useMemo(
    () => requirements.find((entry) => entry.requirementId === selectedRequirementId) || null,
    [requirements, selectedRequirementId]
  );
  const searchableFilm = selectedRequirement
    ? `${selectedRequirement.manufacturer} ${selectedRequirement.filmName}`.trim()
    : '';
  const ilBoxesQuery = useSearchBoxes({
    warehouse: 'IL',
    status: 'IN_STOCK',
    film: searchableFilm,
    width: selectedRequirement ? String(selectedRequirement.widthIn) : '-1',
    showRetired: false
  });
  const msBoxesQuery = useSearchBoxes({
    warehouse: 'MS',
    status: 'IN_STOCK',
    film: searchableFilm,
    width: selectedRequirement ? String(selectedRequirement.widthIn) : '-1',
    showRetired: false
  });
  const matchingBoxes = useMemo(() => {
    if (!selectedRequirement) {
      return [];
    }

    const requiredManufacturerKey = normalizeLookup(selectedRequirement.manufacturer);
    const requiredFilmKey = normalizeLookup(selectedRequirement.filmName);
    const requiredWidth = selectedRequirement.widthIn;

    var merged = (ilBoxesQuery.data || []).concat(msBoxesQuery.data || []);
    var dedupedByBoxId = new Map<string, (typeof merged)[number]>();

    for (var mergeIndex = 0; mergeIndex < merged.length; mergeIndex += 1) {
      var mergedBox = merged[mergeIndex];
      var existing = dedupedByBoxId.get(mergedBox.boxId);
      if (!existing || mergedBox.feetAvailable > existing.feetAvailable) {
        dedupedByBoxId.set(mergedBox.boxId, mergedBox);
      }
    }

    const filtered = Array.from(dedupedByBoxId.values()).filter((box) => {
      if (box.status !== 'IN_STOCK' || box.feetAvailable <= 0) {
        return false;
      }

      if (box.widthIn !== requiredWidth) {
        return false;
      }

      if (normalizeLookup(box.manufacturer) !== requiredManufacturerKey) {
        return false;
      }

      if (normalizeLookup(box.filmName) !== requiredFilmKey) {
        return false;
      }

      return true;
    });
    filtered.sort((a, b) => {
      if (a.feetAvailable !== b.feetAvailable) {
        return b.feetAvailable - a.feetAvailable;
      }

      const aDate = a.receivedDate || a.orderDate || '';
      const bDate = b.receivedDate || b.orderDate || '';
      if (aDate && bDate && aDate !== bDate) {
        return aDate < bDate ? -1 : 1;
      }

      return a.boxId.localeCompare(b.boxId);
    });

    return filtered;
  }, [ilBoxesQuery.data, msBoxesQuery.data, selectedRequirement]);
  const autoSourceBox = matchingBoxes[0] || null;
  const isMatchingBoxesLoading = ilBoxesQuery.isLoading || msBoxesQuery.isLoading;
  const availabilityProbePayload = useMemo(() => {
    if (!open || !selectedRequirement || !autoSourceBox) {
      return null;
    }

    return {
      boxId: autoSourceBox.boxId,
      jobNumber,
      jobDate: dueDate || '',
      requestedFeet: 1,
      crossWarehouse: true
    };
  }, [autoSourceBox, dueDate, jobNumber, open, selectedRequirement]);
  const availabilityProbeQuery = useAllocationPreview(open ? availabilityProbePayload : null);
  const hasConflictFreeCoverage = (availabilityProbeQuery.data?.defaultCoveredFeet || 0) > 0;
  const isOrderFilmMode =
    !isMatchingBoxesLoading &&
    Boolean(selectedRequirement) &&
    (!autoSourceBox || (Boolean(availabilityProbeQuery.data) && !hasConflictFreeCoverage));
  const previewQuery = useAllocationPreview(open ? previewPayload : null);
  const isCheckingCoverage =
    previewQuery.isLoading ||
    (!previewQuery.data && (isMatchingBoxesLoading || (Boolean(autoSourceBox) && availabilityProbeQuery.isLoading)));

  useEffect(() => {
    if (!open) {
      setSelectedRequirementId('');
      setRequestedFeet('');
      setPreviewPayload(null);
      setSelectedSuggestionBoxIds([]);
      setError('');
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
      setPreviewPayload(null);
      return;
    }

    setRequestedFeet(selectedRequirement.remainingFeet > 0 ? String(selectedRequirement.remainingFeet) : '');
    setPreviewPayload(null);
    setSelectedSuggestionBoxIds([]);
    setError('');
  }, [selectedRequirement?.requirementId]);

  useEffect(() => {
    if (!previewQuery.data) {
      return;
    }

    setSelectedSuggestionBoxIds(previewQuery.data.suggestions.map((entry) => entry.boxId));
  }, [previewQuery.data]);

  if (!open) {
    return null;
  }

  function toggleSuggestion(boxId: string) {
    setSelectedSuggestionBoxIds((current) =>
      current.includes(boxId) ? current.filter((value) => value !== boxId) : [...current, boxId]
    );
  }

  function handleFindCoverage() {
    if (!selectedRequirement) {
      setError('Select a requirement line first.');
      return;
    }

    if (isMatchingBoxesLoading || availabilityProbeQuery.isLoading) {
      setError('Matching boxes are still loading. Try again in a moment.');
      return;
    }

    if (!autoSourceBox) {
      setError('No matching in-stock source box was found for this requirement.');
      return;
    }

    const parsedRequestedFeet = Number(requestedFeet);
    if (!Number.isFinite(parsedRequestedFeet) || parsedRequestedFeet <= 0) {
      setError('Requested LF must be greater than zero.');
      return;
    }

    setError('');
    setPreviewPayload({
      boxId: autoSourceBox.boxId,
      jobNumber,
      jobDate: dueDate || '',
      requestedFeet: Math.floor(parsedRequestedFeet),
      crossWarehouse: true
    });
  }

  async function handleAllocate() {
    if (!previewPayload) {
      return;
    }

    try {
      const { result, warnings } = await allocateMutation.mutateAsync({
        ...previewPayload,
        selectedSuggestionBoxIds,
        crossWarehouse: true,
        jobWarehouse: warehouse
      });

      onCancel();

      const summary =
        result.allocations.length > 0
          ? result.allocations.map((entry) => `${entry.boxId}: ${entry.allocatedFeet} LF`).join(', ')
          : 'No in-stock boxes covered this request.';
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
        title: 'Google sign-in is not configured',
        description: 'Set VITE_GOOGLE_CLIENT_ID before creating film orders.',
        variant: 'error'
      });
      return;
    }

    if (!auth.isAuthenticated) {
      toast.push({
        title: 'Sign-in required',
        description: 'Sign in with Google before creating a film order.',
        variant: 'error'
      });
      return;
    }

    const parsedRequestedFeet = Number(requestedFeet);
    if (!Number.isFinite(parsedRequestedFeet) || parsedRequestedFeet <= 0) {
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
        requestedFeet: Math.floor(parsedRequestedFeet)
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
              setPreviewPayload(null);
              setError('');
            }}
          />
        </div>
        {!isMatchingBoxesLoading && autoSourceBox ? (
          <p className="muted-text">
            Source box auto-selected: {autoSourceBox.boxId} ({autoSourceBox.warehouse}, {autoSourceBox.feetAvailable}{' '}
            LF available).
          </p>
        ) : null}

        {isMatchingBoxesLoading ? <p className="muted-text">Loading matching in-stock boxes...</p> : null}
        {!isMatchingBoxesLoading && selectedRequirement && !matchingBoxes.length ? (
          <p className="muted-text">
            No matching in-stock boxes were found for this requirement. Create a film-order alert instead.
          </p>
        ) : null}

        {error ? <p className="error-text">{error}</p> : null}
        {availabilityProbeQuery.isError ? <p className="error-text">{availabilityProbeQuery.error.message}</p> : null}
        {previewQuery.isError ? <p className="error-text">{previewQuery.error.message}</p> : null}

        {previewQuery.data ? (
          <div className="allocation-preview">
            <div className="stat-grid allocation-stat-grid">
              <div className="key-value">
                <dt>Requested</dt>
                <dd>{previewQuery.data.requestedFeet}</dd>
              </div>
              <div className="key-value">
                <dt>Covered</dt>
                <dd>{previewQuery.data.defaultCoveredFeet}</dd>
              </div>
              <div className="key-value">
                <dt>Still Short</dt>
                <dd>{previewQuery.data.defaultRemainingFeet}</dd>
              </div>
            </div>

            {previewQuery.data.suggestions.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Use</th>
                      <th>Box</th>
                      <th>Warehouse</th>
                      <th>Avail LF</th>
                      <th>Suggested LF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewQuery.data.suggestions.map((suggestion) => (
                      <tr key={suggestion.boxId}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedSuggestionBoxIds.includes(suggestion.boxId)}
                            onChange={() => toggleSuggestion(suggestion.boxId)}
                          />
                        </td>
                        <td>{suggestion.boxId}</td>
                        <td>{suggestion.warehouse}</td>
                        <td>{suggestion.availableFeet}</td>
                        <td>{suggestion.suggestedFeet}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
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
            onClick={
              previewQuery.data
                ? () => void handleAllocate()
                : isOrderFilmMode
                  ? () => void handleOrderFilm()
                  : handleFindCoverage
            }
            disabled={isCheckingCoverage || isSubmitting}
          >
            {previewQuery.data
              ? allocateMutation.isPending
                ? 'Saving...'
                : 'Allocate'
              : isOrderFilmMode
                ? createFilmOrderMutation.isPending
                  ? 'Ordering...'
                  : 'Order Film'
              : isCheckingCoverage
                ? 'Checking...'
                : 'Find Coverage'}
          </Button>
        </div>
      </div>
    </div>
  );
}
