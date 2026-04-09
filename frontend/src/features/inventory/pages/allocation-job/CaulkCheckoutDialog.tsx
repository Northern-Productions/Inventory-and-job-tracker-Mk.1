import type { Dispatch, SetStateAction } from 'react';
import { Button } from '../../../../components/Button';
import { DialogSurface } from '../../../../components/DialogSurface';
import type { CaulkCheckoutDraft } from './types';

interface CaulkCheckoutDialogProps {
  draft: CaulkCheckoutDraft | null;
  setDraft: Dispatch<SetStateAction<CaulkCheckoutDraft | null>>;
  error: string;
  setError: Dispatch<SetStateAction<string>>;
  pending: boolean;
  onSubmit: () => void;
}

export function CaulkCheckoutDialog({
  draft,
  setDraft,
  error,
  setError,
  pending,
  onSubmit
}: CaulkCheckoutDialogProps) {
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
      className="dialog-caulk-checkout"
      backdropClassName="dialog-backdrop-centered"
      titleId="caulk-checkout-dialog-title"
    >
      <div className="dialog-header">
        <h2 id="caulk-checkout-dialog-title">Check Out Caulk</h2>
        <button
          type="button"
          className="dialog-close"
          aria-label="Close caulk checkout dialog"
          onClick={handleClose}
        >
          X
        </button>
      </div>
      <p className="muted-text">
        {draft.productLabel} | Allocated amount: {draft.reservedTubesRemaining} tubes
      </p>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="dialog-actions dialog-actions-sticky-footer">
        <Button type="button" variant="ghost" onClick={handleClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" variant="primary" onClick={onSubmit} disabled={pending}>
          {pending ? 'Checking Out...' : 'Check Out'}
        </Button>
      </div>
    </DialogSurface>
  );
}
