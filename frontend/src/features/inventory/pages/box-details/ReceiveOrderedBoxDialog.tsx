import { useEffect, useState } from 'react';
import { Button } from '../../../../components/Button';
import { DialogSurface } from '../../../../components/DialogSurface';
import { Input } from '../../../../components/Input';
import type { Box } from '../../../../domain';
import {
  CORE_TYPE_OPTIONS,
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
    currentFeetOnRoll: '',
    lotRun: '',
    coreType: ''
  });
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setError('');
      return;
    }

    setDraft(box ? createOrderedBoxReceiveDraft(box) : { receivedWeightLbs: '', currentFeetOnRoll: '', lotRun: '', coreType: '' });
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
        Save this box as received and move it into active in-stock inventory. Adjust Current LF when
        the physical label differs from the ordered LF. Weight, lot run, and core type are optional.
      </p>
      <div className="form-grid">
        <Input
          label="Current LF"
          type="number"
          step="1"
          min="0"
          inputMode="numeric"
          className="field-input-no-spinner"
          autoFocus
          value={draft.currentFeetOnRoll}
          onChange={(event) => {
            if (!/^\d*$/.test(event.target.value)) {
              return;
            }
            setDraft((current) => ({ ...current, currentFeetOnRoll: event.target.value }));
            setError('');
          }}
          hint="Use the physical label LF. This may be lower than the ordered LF."
          disabled={pending || !box}
        />
        <Input
          label="Weight (lbs)"
          type="number"
          step="0.01"
          min="0"
          inputMode="decimal"
          className="field-input-no-spinner"
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
        <label className="field">
          <span className="field-label">Core Type</span>
          <select
            className="field-input"
            value={draft.coreType}
            onChange={(event) => {
              setDraft((current) => ({ ...current, coreType: event.target.value }));
              setError('');
            }}
            disabled={pending || !box}
          >
            <option value="">Select core type</option>
            {CORE_TYPE_OPTIONS.map((coreType) => (
              <option key={coreType} value={coreType}>
                {coreType}
              </option>
            ))}
          </select>
          <span className="field-hint">Optional. Leave blank to keep the current core type.</span>
        </label>
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
