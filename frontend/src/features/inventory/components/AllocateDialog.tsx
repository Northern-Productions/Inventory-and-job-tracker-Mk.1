import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
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
import { planCoverageAllocation } from '../../../domain/allocationCoverageContract.mjs';
import {
  useAllocateBox,
  useAllocationPreview,
  useJob
} from '../hooks/useInventoryQueries';
import { findCompatibleRequirementsForBox } from '../utils/jobAllocationMatching';

interface AllocateDialogProps {
  open: boolean;
  box: Box;
  onCancel: () => void;
}

function formatBoxStatusLabel(status: string) {
  return status.replace(/_/g, ' ');
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

  for (const suggestion of preview.suggestions) {
    if (!selected.has(suggestion.boxId) || remaining <= 0) {
      continue;
    }

    const nextPlan = planCoverageAllocation(
      remaining,
      suggestion.planningFeet ?? suggestion.availableFeet,
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

function formatPlannedFeet(allocatedFeet: number, coveredFeet: number) {
  if (coveredFeet > 0 && coveredFeet !== allocatedFeet) {
    return `${allocatedFeet} physical / ${coveredFeet} covered`;
  }

  return String(allocatedFeet);
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
    requestedWidthIn?: number;
    requirementId?: string;
  } | null>(null);
  const [selectedSuggestionBoxIds, setSelectedSuggestionBoxIds] = useState<string[]>([]);
  const [selectedRequirementId, setSelectedRequirementId] = useState('');
  const [error, setError] = useState('');
  const normalizedJobNumber = jobNumber.trim();
  const jobQuery = useJob(open ? normalizedJobNumber : '');
  const compatibleRequirements = useMemo(
    () => findCompatibleRequirementsForBox(jobQuery.data?.requirements || [], box),
    [box, jobQuery.data?.requirements]
  );
  const selectedRequirement =
    compatibleRequirements.find((entry) => entry.requirementId === selectedRequirementId) || null;

  const previewQuery = useAllocationPreview(open ? previewPayload : null);
  const preview = previewQuery.data;
  const selectionSummary = useMemo(
    () => (preview ? buildSelectionSummary(preview, selectedSuggestionBoxIds) : null),
    [preview, selectedSuggestionBoxIds]
  );
  const selectedAllocationByBoxId = useMemo(() => {
    const allocationByBoxId = new Map<string, { allocatedFeet: number; coveredFeet: number }>();
    if (!selectionSummary) {
      return allocationByBoxId;
    }

    for (const allocation of selectionSummary.allocations) {
      allocationByBoxId.set(allocation.boxId, {
        allocatedFeet: allocation.allocatedFeet,
        coveredFeet: allocation.coveredFeet
      });
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
      setSelectedRequirementId('');
      setError('');
    }
  }, [open]);

  useEffect(() => {
    if (!preview) {
      return;
    }

    setSelectedSuggestionBoxIds(preview.suggestions.map((suggestion) => suggestion.boxId));
  }, [preview]);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (!normalizedJobNumber) {
      setSelectedRequirementId('');
      return;
    }

    if (selectedRequirementId && compatibleRequirements.some((entry) => entry.requirementId === selectedRequirementId)) {
      return;
    }

    if (compatibleRequirements.length === 1) {
      setSelectedRequirementId(compatibleRequirements[0].requirementId);
      return;
    }

    setSelectedRequirementId('');
  }, [compatibleRequirements, normalizedJobNumber, open, selectedRequirementId]);

  if (!open) {
    return null;
  }

  function invalidatePreview() {
    setPreviewPayload(null);
    setSelectedSuggestionBoxIds([]);
  }

  function handleFindCoverage() {
    const parsedFeet = Number(requestedFeet);
    if (!normalizedJobNumber) {
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

    if (jobQuery.isLoading || jobQuery.isFetching) {
      setError('Loading job requirements. Try again in a moment.');
      return;
    }

    if (jobQuery.isError) {
      setError(jobQuery.error.message || 'Unable to load the selected job.');
      return;
    }

    if (!compatibleRequirements.length) {
      setError('No compatible unmet requirement lines were found for this job.');
      return;
    }

    if (!selectedRequirement) {
      setError('Select the requirement line this allocation should satisfy.');
      return;
    }

    setError('');
    setPreviewPayload({
      boxId: box.boxId,
      jobNumber: normalizedJobNumber,
      jobDate: jobDate.trim(),
      crewLeader: crewLeader.trim(),
      requestedFeet: Math.floor(parsedFeet),
      requestedWidthIn: selectedRequirement.widthIn,
      requirementId: selectedRequirement.requirementId
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
              .map((entry) =>
                entry.coveredFeet !== entry.allocatedFeet
                  ? `${entry.boxId}: ${entry.allocatedFeet} LF physical / ${entry.coveredFeet} LF covered`
                  : `${entry.boxId}: ${entry.allocatedFeet} LF`
              )
              .join(', ')}`
          : 'No allocatable boxes could cover the request.';
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
    <DialogSurface open={open} onClose={onCancel} titleId="allocate-dialog-title">
      <div className="dialog-header">
        <h2 id="allocate-dialog-title">Allocate Film</h2>
        <button type="button" className="dialog-close" aria-label="Close allocation dialog" onClick={onCancel}>
          x
        </button>
      </div>
      <div className="dialog-copy">
        <p className="muted-text">
          Request LF for a job, then review compatible boxes in the same warehouse before saving.
        </p>
        <p className="muted-text">
          This source box is {formatBoxStatusLabel(box.status)} with {box.allocationPlanningFeet} LF of planning capacity.
        </p>
      </div>
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
          <label className="field">
            <span className="field-label">Requirement</span>
            <select
              className="field-input"
              value={selectedRequirementId}
              onChange={(event) => {
                setSelectedRequirementId(event.target.value);
                invalidatePreview();
                setError('');
              }}
              disabled={!normalizedJobNumber || compatibleRequirements.length <= 1 || jobQuery.isLoading || jobQuery.isFetching}
            >
              <option value="">
                {compatibleRequirements.length
                  ? compatibleRequirements.length === 1
                    ? 'Compatible requirement auto-selected'
                    : 'Select requirement'
                  : normalizedJobNumber
                    ? jobQuery.isLoading || jobQuery.isFetching
                      ? 'Loading requirements...'
                      : 'No compatible unmet requirement'
                    : 'Enter a job number first'}
              </option>
              {compatibleRequirements.map((requirement) => (
                <option key={requirement.requirementId} value={requirement.requirementId}>
                  {requirement.manufacturer} {requirement.filmName} {requirement.widthIn}" ({requirement.remainingFeet} LF remaining)
                </option>
              ))}
            </select>
          </label>
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
        {!preview && normalizedJobNumber && compatibleRequirements.length > 1 ? (
          <p className="muted-text">
            Choose the exact job requirement line this box should satisfy before finding coverage.
          </p>
        ) : null}

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
                {box.boxId} ({formatBoxStatusLabel(preview.sourceBoxStatus)}) will cover{' '}
                {formatPlannedFeet(preview.sourceSuggestedFeet, preview.sourceSuggestedCoveredFeet)}.
              </p>
            )}

            {preview.suggestions.length ? (
              isPhoneLayout ? (
                <div className="mobile-record-list">
                  {preview.suggestions.map((suggestion) => {
                    const selected = selectedSuggestionBoxIds.includes(suggestion.boxId);
                    const selectedPlanFeet = selectedAllocationByBoxId.get(suggestion.boxId) || {
                      allocatedFeet: 0,
                      coveredFeet: 0
                    };

                    return (
                      <MobileRecordCard key={suggestion.boxId}>
                        <MobileRecordHeader title={suggestion.boxId} />
                        <MobileFieldList>
                          <MobileField label="Use" value={selected ? 'Yes' : 'No'} />
                          <MobileField
                            label="Status"
                            value={
                              <span className={`badge badge-${suggestion.boxStatus}`}>
                                {formatBoxStatusLabel(suggestion.boxStatus)}
                              </span>
                            }
                          />
                          <MobileField label="Planning LF" value={suggestion.planningFeet} />
                          <MobileField
                            label="Planned LF"
                            value={formatPlannedFeet(selectedPlanFeet.allocatedFeet, selectedPlanFeet.coveredFeet)}
                          />
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
                        <th>Status</th>
                        <th>Planning LF</th>
                        <th>Planned LF</th>
                        <th>Received</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.suggestions.map((suggestion) => {
                        const selected = selectedSuggestionBoxIds.includes(suggestion.boxId);
                        const selectedPlanFeet = selectedAllocationByBoxId.get(suggestion.boxId) || {
                          allocatedFeet: 0,
                          coveredFeet: 0
                        };

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
                            <td>
                              <span className={`badge badge-${suggestion.boxStatus}`}>
                                {formatBoxStatusLabel(suggestion.boxStatus)}
                              </span>
                            </td>
                            <td>{suggestion.planningFeet}</td>
                            <td>{formatPlannedFeet(selectedPlanFeet.allocatedFeet, selectedPlanFeet.coveredFeet)}</td>
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
                No other compatible boxes can help bridge this shortage in {box.warehouse}.
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
    </DialogSurface>
  );
}
