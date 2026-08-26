import { useEffect, useState } from 'react';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import { Input } from '../../../components/Input';
import type { Box } from '../../../domain';
import {
  createFilmCheckinDraft,
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
    lastRollWeightLbs: ''
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
          : { lastRollWeightLbs: '' })
    );
    setError('');
  }, [box, initialDraft, open]);

  function handleRequestClose() {
    if (pending) {
      return;
    }

    setDraft({ lastRollWeightLbs: '' });
    setError('');
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
        {box
          ? 'Enter the returned roll weight to complete this box check-in.'
          : 'Loading the latest box details before completing this return.'}
      </p>
      {releaseJobNumber ? (
        <p className="muted-text">
          This return will close the current checkout for job {releaseJobNumber} and record returned roll history.
        </p>
      ) : null}
      {loading ? <p className="muted-text">Loading the latest box details for this return...</p> : null}
      {loadError ? <p className="error-text">{loadError}</p> : null}
      <div className="form-grid">
        <Input
          label="Returned Roll Weight (lbs)"
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
          hint="The returned scale weight determines physical remaining LF."
          disabled={pending || loading || !box}
        />
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
