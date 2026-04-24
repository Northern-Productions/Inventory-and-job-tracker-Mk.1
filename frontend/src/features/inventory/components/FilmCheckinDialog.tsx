import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import { Input } from '../../../components/Input';
import { Select } from '../../../components/Select';
import type { Box } from '../../../domain';
import {
  CORE_TYPE_OPTIONS,
  checkInNeedsCurrentFeet,
  checkInRequiresCoreType,
  createFilmCheckinDraft,
  requiresFirstReturnCalibration,
  type FilmCheckinDraft,
  validateFilmCheckinDraft
} from '../utils/boxHelpers';

interface FilmCheckinDialogProps {
  open: boolean;
  box: Box | null | undefined;
  initialDraft?: FilmCheckinDraft | null;
  pending?: boolean;
  loading?: boolean;
  loadError?: string;
  releaseJobNumber?: string;
  onCancel: () => void;
  onConfirm: (draft: FilmCheckinDraft) => void | Promise<void>;
}

const CORE_TYPE_SELECT_OPTIONS = [
  { label: 'Select core type', value: '' },
  ...CORE_TYPE_OPTIONS.map((entry) => ({
    label: entry,
    value: entry
  }))
];

export function FilmCheckinDialog({
  open,
  box,
  initialDraft = null,
  pending = false,
  loading = false,
  loadError = '',
  releaseJobNumber = '',
  onCancel,
  onConfirm
}: FilmCheckinDialogProps) {
  const [draft, setDraft] = useState<FilmCheckinDraft>({
    lastRollWeightLbs: '',
    currentFeetOnRoll: '',
    coreType: ''
  });
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setError('');
      return;
    }

    setDraft(
      initialDraft ||
        (box
          ? createFilmCheckinDraft(box)
          : { lastRollWeightLbs: '', currentFeetOnRoll: '', coreType: '' })
    );
    setError('');
  }, [box, initialDraft, open]);

  const needsCurrentFeet = box ? checkInNeedsCurrentFeet(box) : false;
  const coreTypeRequired = box ? checkInRequiresCoreType(box, draft.currentFeetOnRoll) : false;
  const introCopy = useMemo(() => {
    if (!box) {
      return 'Loading the latest box details before completing this return.';
    }

    if (requiresFirstReturnCalibration(box)) {
      return 'This direct-to-site roll is arriving at the warehouse for the first time, so both the returned roll weight and Current Linear Feet are required to establish its tracked inventory baseline.';
    }

    if (needsCurrentFeet) {
      return 'This box does not have enough saved weight history to derive remaining LF from weight alone, so Current Linear Feet is required for this return.';
    }

    return 'Enter the returned roll weight to complete this box check-in.';
  }, [box, needsCurrentFeet]);

  function handleRequestClose() {
    if (pending) {
      return;
    }

    onCancel();
  }

  async function handleSubmit() {
    if (!box) {
      setError('The latest box details are still loading. Try again in a moment.');
      return;
    }

    try {
      validateFilmCheckinDraft(box, draft);
      setError('');
      await onConfirm(draft);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Review the return values and try again.');
    }
  }

  if (!open) {
    return null;
  }

  return (
    <DialogSurface
      open={open}
      onClose={handleRequestClose}
      className="dialog-caulk-checkin"
      backdropClassName="dialog-backdrop-centered"
      titleId="film-checkin-dialog-title"
      descriptionId="film-checkin-dialog-description"
    >
      <div className="dialog-header">
        <h2 id="film-checkin-dialog-title">{box ? `Check In ${box.boxId}` : 'Check In Box'}</h2>
        <button
          type="button"
          className="dialog-close"
          aria-label="Close box checkin dialog"
          onClick={handleRequestClose}
          disabled={pending}
        >
          X
        </button>
      </div>
      <p id="film-checkin-dialog-description" className="muted-text dialog-message">
        {introCopy}
      </p>
      {releaseJobNumber ? (
        <p className="muted-text">
          The planning allocation for job {releaseJobNumber} will be released when this return is saved.
        </p>
      ) : null}
      {loading ? <p className="muted-text">Loading the latest box details for this return...</p> : null}
      {loadError ? <p className="error-text">{loadError}</p> : null}
      <div className="form-grid">
        <Input
          label="Last Roll Weight (lbs)"
          type="number"
          step="0.01"
          min="0"
          autoFocus
          value={draft.lastRollWeightLbs}
          placeholder="Required"
          onChange={(event) => {
            setDraft((current) => ({ ...current, lastRollWeightLbs: event.target.value }));
            setError('');
          }}
          hint="Save the returned roll weight in pounds."
          disabled={pending || loading || !box}
        />
        {needsCurrentFeet ? (
          <Input
            label={coreTypeRequired ? 'Current Linear Feet *' : 'Current Linear Feet'}
            value={draft.currentFeetOnRoll}
            placeholder="Required"
            inputMode="numeric"
            pattern="[0-9]*"
            onChange={(event) => {
              const nextValue = event.target.value.replace(/[^0-9]/g, '');
              setDraft((current) => ({ ...current, currentFeetOnRoll: nextValue }));
              setError('');
            }}
            hint="Required because this box cannot derive remaining LF from weight alone yet."
            disabled={pending || loading || !box}
          />
        ) : null}
        {needsCurrentFeet ? (
          <Select
            label={coreTypeRequired ? 'Core Type *' : 'Core Type'}
            options={CORE_TYPE_SELECT_OPTIONS}
            value={draft.coreType}
            onChange={(event) => {
              setDraft((current) => ({
                ...current,
                coreType: event.target.value as FilmCheckinDraft['coreType']
              }));
              setError('');
            }}
            hint={
              coreTypeRequired
                ? 'Required to establish future weight-based LF math for this box.'
                : 'Leave the saved core type selected unless the returned roll is on a different core.'
            }
            disabled={pending || loading || !box}
          />
        ) : null}
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="dialog-actions dialog-actions-sticky-footer">
        <Button type="button" variant="ghost" onClick={handleRequestClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" variant="primary" onClick={() => void handleSubmit()} disabled={pending || loading || !box}>
          {pending ? 'Checking In...' : 'Check In'}
        </Button>
      </div>
    </DialogSurface>
  );
}
