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
import type { Box } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import {
  useAllocateBox,
  useAllocationPreview,
  useJob
} from '../hooks/useInventoryQueries';
import {
  buildSelectionSummary,
  formatPlannedFeet
} from './job-allocate-dialog/helpers';
import { findCompatibleRequirementsForBox } from '../utils/jobAllocationMatching';

interface AllocateDialogProps {
  open: boolean;
  box: Box;
  onOpen?: () => void;
  onCancel: () => void;
}

function formatBoxStatusLabel(status: string) {
  return status.replace(/_/g, ' ');
}

export function AllocateDialog({ open, box, onOpen, onCancel }: AllocateDialogProps) {
  const isPhoneLayout = useIsPhoneLayout();
  const toast = useToast();
  const allocateMutation = useAllocateBox();
  const [jobNumber, setJobNumber] = useState('');
  const [installDate, setInstallDate] = useState('');
  const [crewLeader, setCrewLeader] = useState('');
  const [requestedFeet, setRequestedFeet] = useState('');
  const [previewPayload, setPreviewPayload] = useState<{
    boxId: string;
    jobNumber: string;
    installDate?: string;
    crewLeader?: string;
    requestedFeet: number;
    requestedWidthIn?: number;
    requirementId?: string;
  } | null>(null);
  const [selectedSuggestionBoxIds, setSelectedSuggestionBoxIds] = useState<string[]>([]);
  const [selectedRequirementId, setSelectedRequirementId] = useState('');
  const [error, setError] = useState('');
  const [restoreDraft, setRestoreDraft] = useState<{
    jobNumber: string;
    installDate: string;
    crewLeader: string;
    requestedFeet: string;
    previewPayload: {
      boxId: string;
      jobNumber: string;
      installDate?: string;
      crewLeader?: string;
      requestedFeet: number;
      requestedWidthIn?: number;
      requirementId?: string;
    } | null;
    selectedSuggestionBoxIds: string[];
    selectedRequirementId: string;
  } | null>(null);
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
      setInstallDate('');
      setCrewLeader('');
      setRequestedFeet('');
      setPreviewPayload(null);
      setSelectedSuggestionBoxIds([]);
      setSelectedRequirementId('');
      setError('');
      return;
    }

    if (!restoreDraft) {
      return;
    }

    setJobNumber(restoreDraft.jobNumber);
    setInstallDate(restoreDraft.installDate);
    setCrewLeader(restoreDraft.crewLeader);
    setRequestedFeet(restoreDraft.requestedFeet);
    setPreviewPayload(restoreDraft.previewPayload);
    setSelectedSuggestionBoxIds(restoreDraft.selectedSuggestionBoxIds);
    setSelectedRequirementId(restoreDraft.selectedRequirementId);
    setError('');
    setRestoreDraft(null);
  }, [open, restoreDraft]);

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

    if (installDate.trim() && !crewLeader.trim()) {
      setError('Crew Leader is required when an Install Date is set.');
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
      installDate: installDate.trim(),
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

  function handleConfirm() {
    if (!previewPayload || !selectionSummary) {
      return;
    }

    const draftSnapshot = {
      jobNumber,
      installDate,
      crewLeader,
      requestedFeet,
      previewPayload,
      selectedSuggestionBoxIds,
      selectedRequirementId
    };
    const savePromise = allocateMutation.mutateAsync({
      ...previewPayload,
      selectedSuggestionBoxIds
    });

    onCancel();

    void savePromise
      .then(({ result, warnings }) => {
        const title = 'Film allocated';

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
        const remainingSummary =
          result.remainingUncoveredFeet > 0
            ? ` ${result.remainingUncoveredFeet} LF remains unallocated. Create a film order separately if needed.`
            : '';

        toast.push({
          title,
          description:
            warnings.join(' ') || `${allocationSummary}.${remainingSummary}`.trim(),
          variant: 'success'
        });
      })
      .catch((submitError) => {
        setRestoreDraft(draftSnapshot);
        onOpen?.();
        toast.push({
          title: 'Allocation failed',
          description:
            submitError instanceof Error ? submitError.message : 'The allocation could not be completed.',
          variant: 'error'
        });
      });
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
            label="Install Date"
            type="date"
            value={installDate}
            onChange={(event) => {
              setInstallDate(event.target.value);
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
            placeholder={installDate ? 'Required when Install Date is set' : 'Optional'}
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
                {box.boxId} is already allocated on {preview.installDate} for {preview.sourceConflicts.join(', ')}
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
                The remaining {selectionSummary.remainingFeet} LF will stay unallocated if you continue. Create a
                film order separately if needed.
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
