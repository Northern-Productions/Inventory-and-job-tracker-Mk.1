import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Input';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { useToast } from '../../../components/Toast';
import type { AllocationPreview, Box } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import {
  useAllocateBox,
  useAllocationPreview
} from '../hooks/useInventoryQueries';

interface AllocateDialogProps {
  open: boolean;
  box: Box;
  onCancel: () => void;
}

function buildSelectionSummary(preview: AllocationPreview, selectedSuggestionBoxIds: string[]) {
  const selected = new Set(selectedSuggestionBoxIds);
  const allocations: Array<{ boxId: string; allocatedFeet: number }> = [];
  let remaining = preview.requestedFeet;

  if (preview.sourceSuggestedFeet > 0) {
    allocations.push({
      boxId: preview.sourceBoxId,
      allocatedFeet: preview.sourceSuggestedFeet
    });
    remaining -= preview.sourceSuggestedFeet;
  }

  for (const suggestion of preview.suggestions) {
    if (!selected.has(suggestion.boxId) || remaining <= 0) {
      continue;
    }

    const allocatedFeet = Math.min(suggestion.availableFeet, remaining);
    allocations.push({
      boxId: suggestion.boxId,
      allocatedFeet
    });
    remaining -= allocatedFeet;
  }

  return {
    allocations,
    coveredFeet: preview.requestedFeet - remaining,
    remainingFeet: remaining
  };
}

export function AllocateDialog({ open, box, onCancel }: AllocateDialogProps) {
  const isPhoneLayout = useIsPhoneLayout();
  const toast = useToast();
  const allocateMutation = useAllocateBox();
  const [jobNumber, setJobNumber] = useState('');
  const [jobDate, setJobDate] = useState('');
  const [crewLeader, setCrewLeader] = useState('');
  const [requestedFeet, setRequestedFeet] = useState('');
  const [previewPayload, setPreviewPayload] = useState<{
    boxId: string;
    jobNumber: string;
    jobDate?: string;
    crewLeader?: string;
    requestedFeet: number;
  } | null>(null);
  const [selectedSuggestionBoxIds, setSelectedSuggestionBoxIds] = useState<string[]>([]);
  const [error, setError] = useState('');

  const previewQuery = useAllocationPreview(open ? previewPayload : null);
  const preview = previewQuery.data;
  const selectionSummary = useMemo(
    () => (preview ? buildSelectionSummary(preview, selectedSuggestionBoxIds) : null),
    [preview, selectedSuggestionBoxIds]
  );
  const selectedAllocationByBoxId = useMemo(() => {
    const allocationByBoxId = new Map<string, number>();
    if (!selectionSummary) {
      return allocationByBoxId;
    }

    for (const allocation of selectionSummary.allocations) {
      allocationByBoxId.set(allocation.boxId, allocation.allocatedFeet);
    }

    return allocationByBoxId;
  }, [selectionSummary]);

  useEffect(() => {
    if (!open) {
      setJobNumber('');
      setJobDate('');
      setCrewLeader('');
      setRequestedFeet('');
      setPreviewPayload(null);
      setSelectedSuggestionBoxIds([]);
      setError('');
    }
  }, [open]);

  useEffect(() => {
    if (!preview) {
      return;
    }

    setSelectedSuggestionBoxIds(preview.suggestions.map((suggestion) => suggestion.boxId));
  }, [preview]);

  if (!open) {
    return null;
  }

  function invalidatePreview() {
    setPreviewPayload(null);
    setSelectedSuggestionBoxIds([]);
  }

  function handleFindCoverage() {
    const parsedFeet = Number(requestedFeet);
    if (!jobNumber.trim()) {
      setError('Job Number is required.');
      return;
    }

    if (!Number.isFinite(parsedFeet) || parsedFeet <= 0) {
      setError('Requested LF must be greater than zero.');
      return;
    }

    if (jobDate.trim() && !crewLeader.trim()) {
      setError('Crew Leader is required when a Job Date is set.');
      return;
    }

    setError('');
    setPreviewPayload({
      boxId: box.boxId,
      jobNumber: jobNumber.trim(),
      jobDate: jobDate.trim(),
      crewLeader: crewLeader.trim(),
      requestedFeet: Math.floor(parsedFeet)
    });
  }

  function toggleSuggestion(boxId: string) {
    setSelectedSuggestionBoxIds((current) =>
      current.includes(boxId) ? current.filter((value) => value !== boxId) : [...current, boxId]
    );
  }

  async function handleConfirm() {
    if (!previewPayload || !selectionSummary) {
      return;
    }

    try {
      const { result, warnings } = await allocateMutation.mutateAsync({
        ...previewPayload,
        selectedSuggestionBoxIds
      });

      onCancel();

      let title = 'Film allocated';
      if (result.filmOrder && result.allocations.length) {
        title = 'Allocated with Film Order';
      } else if (result.filmOrder) {
        title = 'Film Order created';
      }

      const allocationSummary =
        result.allocations.length > 0
          ? `${result.allocations
              .map((entry) => `${entry.boxId}: ${entry.allocatedFeet} LF`)
              .join(', ')}`
          : 'No in-stock boxes could cover the request.';
      const filmOrderSummary = result.filmOrder
        ? ` Film Order ${result.filmOrder.filmOrderId} was created for ${result.remainingUncoveredFeet} LF.`
        : '';

      toast.push({
        title,
        description:
          warnings.join(' ') || `${allocationSummary}.${filmOrderSummary}`.trim(),
        variant: 'success'
      });
    } catch (submitError) {
      toast.push({
        title: 'Allocation failed',
        description:
          submitError instanceof Error ? submitError.message : 'The allocation could not be completed.',
        variant: 'error'
      });
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="allocate-dialog-title">
        <h2 id="allocate-dialog-title">Allocate Film</h2>
        <p className="muted-text">
          Request LF for a job, then review matching boxes in the same warehouse before saving.
        </p>
        <p className="muted-text">
          This source box currently has {box.feetAvailable} LF available to allocate.
        </p>
        <div className="form-grid">
          <Input
            label="Job Number"
            value={jobNumber}
            onChange={(event) => {
              setJobNumber(event.target.value);
              invalidatePreview();
            }}
            placeholder="Required"
            autoFocus
          />
          <Input
            label="Job Date"
            type="date"
            value={jobDate}
            onChange={(event) => {
              setJobDate(event.target.value);
              invalidatePreview();
            }}
          />
          <Input
            label="Crew Leader"
            value={crewLeader}
            onChange={(event) => {
              setCrewLeader(event.target.value);
              invalidatePreview();
            }}
            placeholder={jobDate ? 'Required when Job Date is set' : 'Optional'}
          />
          <Input
            label="Requested LF"
            type="number"
            min="1"
            step="1"
            value={requestedFeet}
            onChange={(event) => {
              setRequestedFeet(event.target.value);
              invalidatePreview();
            }}
            placeholder="Required"
          />
        </div>

        {error ? <p className="error-text">{error}</p> : null}
        {previewQuery.isError ? <p className="error-text">{previewQuery.error.message}</p> : null}

        {preview ? (
          <div className="allocation-preview">
            <div className="stat-grid allocation-stat-grid">
              <div className="key-value">
                <dt>Requested</dt>
                <dd>{preview.requestedFeet}</dd>
              </div>
              <div className="key-value">
                <dt>Covered Now</dt>
                <dd>{selectionSummary?.coveredFeet ?? 0}</dd>
              </div>
              <div className="key-value">
                <dt>Still Short</dt>
                <dd>{selectionSummary?.remainingFeet ?? 0}</dd>
              </div>
            </div>

            {preview.sourceConflicts.length ? (
              <p className="error-text">
                {box.boxId} is already allocated on {preview.jobDate} for {preview.sourceConflicts.join(', ')}
                with a different crew leader, so this source box cannot be used for this request.
              </p>
            ) : (
              <p className="muted-text">
                {box.boxId} will cover {preview.sourceSuggestedFeet} LF.
              </p>
            )}

            {preview.suggestions.length ? (
              isPhoneLayout ? (
                <div className="mobile-record-list">
                  {preview.suggestions.map((suggestion) => {
                    const selected = selectedSuggestionBoxIds.includes(suggestion.boxId);
                    const selectedPlanFeet = selectedAllocationByBoxId.get(suggestion.boxId) ?? 0;

                    return (
                      <MobileRecordCard key={suggestion.boxId}>
                        <MobileRecordHeader title={suggestion.boxId} />
                        <MobileFieldList>
                          <MobileField label="Use" value={selected ? 'Yes' : 'No'} />
                          <MobileField label="Avail LF" value={suggestion.availableFeet} />
                          <MobileField label="Planned LF" value={selectedPlanFeet} />
                          <MobileField label="Received" value={suggestion.receivedDate || '--'} />
                        </MobileFieldList>
                        <Button
                          type="button"
                          variant={selected ? 'secondary' : 'ghost'}
                          fullWidth
                          onClick={() => toggleSuggestion(suggestion.boxId)}
                        >
                          {selected ? 'Remove Box' : 'Use Box'}
                        </Button>
                      </MobileRecordCard>
                    );
                  })}
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Use</th>
                        <th>Box</th>
                        <th>Avail LF</th>
                        <th>Planned LF</th>
                        <th>Received</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.suggestions.map((suggestion) => {
                        const selected = selectedSuggestionBoxIds.includes(suggestion.boxId);
                        const selectedPlanFeet = selectedAllocationByBoxId.get(suggestion.boxId) ?? 0;

                        return (
                          <tr key={suggestion.boxId}>
                            <td>
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => toggleSuggestion(suggestion.boxId)}
                              />
                            </td>
                            <td>{suggestion.boxId}</td>
                            <td>{suggestion.availableFeet}</td>
                            <td>{selectedPlanFeet}</td>
                            <td>{suggestion.receivedDate || '--'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
            ) : null}

            {!preview.suggestions.length && selectionSummary?.remainingFeet ? (
              <p className="muted-text">
                No other matching in-stock boxes can help bridge this shortage in {box.warehouse}.
              </p>
            ) : null}

            {selectionSummary?.remainingFeet ? (
              <p className="error-text">
                A Film Order alert will be created for {selectionSummary.remainingFeet} LF if you continue.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="dialog-actions">
          <Button
            type="button"
            variant="ghost"
            fullWidth
            onClick={onCancel}
            disabled={allocateMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            fullWidth
            onClick={preview ? handleConfirm : handleFindCoverage}
            disabled={previewQuery.isLoading || allocateMutation.isPending}
          >
            {preview
              ? allocateMutation.isPending
                ? 'Saving...'
                : 'Allocate'
              : previewQuery.isLoading
                ? 'Checking...'
                : 'Find Coverage'}
          </Button>
        </div>
      </div>
    </div>
  );
}
