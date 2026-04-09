import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { Button } from '../../../../components/Button';
import { DialogSurface } from '../../../../components/DialogSurface';
import { Input } from '../../../../components/Input';
import { deriveCaulkCheckinTotals } from '../../utils/jobReturnedMaterials';
import type { CaulkCheckinDraft } from './types';

interface CaulkCheckinDialogProps {
  draft: CaulkCheckinDraft | null;
  setDraft: Dispatch<SetStateAction<CaulkCheckinDraft | null>>;
  error: string;
  setError: Dispatch<SetStateAction<string>>;
  pending: boolean;
  onSubmit: () => void;
}

export function CaulkCheckinDialog({
  draft,
  setDraft,
  error,
  setError,
  pending,
  onSubmit
}: CaulkCheckinDialogProps) {
  const totals = useMemo(() => {
    if (!draft) {
      return null;
    }

    return deriveCaulkCheckinTotals({
      checkoutTubes: draft.checkoutTubes,
      tubesPerCase: draft.tubesPerCase,
      unusedLooseTubes: Math.max(0, Math.floor(Number(draft.unusedLooseTubes || '0'))),
      unusedCases: Math.max(0, Math.floor(Number(draft.unusedCases || '0')))
    });
  }, [draft]);

  if (!draft) {
    return null;
  }

  function handleClose() {
    setDraft(null);
    setError('');
  }

  return (
    <DialogSurface
      open={Boolean(draft)}
      onClose={handleClose}
      className="dialog-caulk-checkin"
      backdropClassName="dialog-backdrop-centered"
      titleId="caulk-checkin-dialog-title"
    >
      <div className="dialog-header">
        <h2 id="caulk-checkin-dialog-title">Check In Caulk</h2>
        <button
          type="button"
          className="dialog-close"
          aria-label="Close caulk checkin dialog"
          onClick={handleClose}
        >
          X
        </button>
      </div>
      <p className="muted-text">
        {draft.productLabel} | Checked out: {draft.checkoutTubes} tubes | {draft.tubesPerCase} tubes per case
      </p>
      <div className="form-grid">
        <Input
          label="Unused Loose Tubes"
          value={draft.unusedLooseTubes}
          placeholder="0"
          inputMode="numeric"
          pattern="[0-9]*"
          onChange={(event) => {
            const value = event.target.value.replace(/[^0-9]/g, '');
            setDraft((current) => (current ? { ...current, unusedLooseTubes: value } : current));
            setError('');
          }}
          hint={`Must be between 0 and ${Math.max(draft.tubesPerCase - 1, 0)}.`}
        />
        <Input
          label="Unused Full Cases"
          value={draft.unusedCases}
          placeholder="0"
          inputMode="numeric"
          pattern="[0-9]*"
          onChange={(event) => {
            const value = event.target.value.replace(/[^0-9]/g, '');
            setDraft((current) => (current ? { ...current, unusedCases: value } : current));
            setError('');
          }}
          hint="Enter unopened full cases only."
        />
        <Input
          label="Notes"
          value={draft.notes}
          onChange={(event) => {
            const value = event.target.value;
            setDraft((current) => (current ? { ...current, notes: value } : current));
            setError('');
          }}
        />
      </div>
      {totals ? (
        <p className="muted-text">
          Returning {totals.totalReturnedTubes} tubes total; {totals.usedTubes} tube
          {totals.usedTubes === 1 ? '' : 's'} will be marked used.
        </p>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
      <div className="dialog-actions dialog-actions-sticky-footer">
        <Button type="button" variant="ghost" onClick={handleClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" variant="primary" onClick={onSubmit} disabled={pending}>
          {pending ? 'Checking In...' : 'Check In'}
        </Button>
      </div>
    </DialogSurface>
  );
}
