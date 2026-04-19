import { useEffect, useState } from 'react';
import { Button } from '../../../../components/Button';
import { DialogSurface } from '../../../../components/DialogSurface';
import { Input } from '../../../../components/Input';
import type { Box } from '../../../../domain';
import {
  createOrderedBoxReceiveDraft,
  type OrderedBoxReceiveDraft,
  validateOrderedBoxReceiveDraft
} from '../../utils/boxHelpers';

interface ReceiveOrderedBoxDialogProps {
  open: boolean;
  box: Box | null | undefined;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (draft: OrderedBoxReceiveDraft) => void | Promise<void>;
}

export function ReceiveOrderedBoxDialog({
  open,
  box,
  pending = false,
  onCancel,
  onConfirm
}: ReceiveOrderedBoxDialogProps) {
  const [draft, setDraft] = useState<OrderedBoxReceiveDraft>({
    receivedWeightLbs: '',
    lotRun: ''
  });
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setError('');
      return;
    }

    setDraft(box ? createOrderedBoxReceiveDraft(box) : { receivedWeightLbs: '', lotRun: '' });
    setError('');
  }, [box, open]);

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
      validateOrderedBoxReceiveDraft(draft);
      setError('');
      await onConfirm(draft);
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : 'Review the receive values and try again.'
      );
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
      titleId="receive-ordered-box-dialog-title"
      descriptionId="receive-ordered-box-dialog-description"
    >
      <div className="dialog-header">
        <h2 id="receive-ordered-box-dialog-title">{box ? `Receive ${box.boxId}` : 'Receive Box'}</h2>
        <button
          type="button"
          className="dialog-close"
          aria-label="Close ordered box receive dialog"
          onClick={handleRequestClose}
          disabled={pending}
        >
          X
        </button>
      </div>
      <p id="receive-ordered-box-dialog-description" className="muted-text dialog-message">
        Save this box as received and move it into active in-stock inventory. Weight and lot run are
        optional so receipt is not blocked when the box cannot be weighed right away.
      </p>
      <div className="form-grid">
        <Input
          label="Weight (lbs)"
          type="number"
          step="0.01"
          min="0"
          inputMode="decimal"
          className="field-input-no-spinner"
          autoFocus
          value={draft.receivedWeightLbs}
          placeholder="Optional"
          onChange={(event) => {
            if (!/^\d+(\.\d{0,2})?$|^$/.test(event.target.value)) {
              return;
            }
            setDraft((current) => ({ ...current, receivedWeightLbs: event.target.value }));
            setError('');
          }}
          hint="Optional. When entered, this is saved as the first full-box receipt weight."
          disabled={pending || !box}
        />
        <Input
          label="Lot/Run Number"
          value={draft.lotRun}
          placeholder="Optional"
          onChange={(event) => {
            setDraft((current) => ({ ...current, lotRun: event.target.value }));
            setError('');
          }}
          hint="Optional. Leave blank to keep the current lot run value."
          disabled={pending || !box}
        />
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="dialog-actions dialog-actions-sticky-footer">
        <Button type="button" variant="ghost" onClick={handleRequestClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" variant="primary" onClick={() => void handleSubmit()} disabled={pending || !box}>
          {pending ? 'Receiving...' : 'Receive Box'}
        </Button>
      </div>
    </DialogSurface>
  );
}
