import { useEffect, useState } from 'react';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import { Input, TextArea } from '../../../components/Input';
import type { FilmOrderDetailLinkedBox } from '../../../domain';

interface CorrectFilmOrderReceiptDialogProps {
  open: boolean;
  filmOrderId: string;
  receipt: FilmOrderDetailLinkedBox | null;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (correctedReceivedFeet: number, reason: string) => void | Promise<void>;
}

export function CorrectFilmOrderReceiptDialog({
  open,
  filmOrderId,
  receipt,
  pending = false,
  onCancel,
  onConfirm
}: CorrectFilmOrderReceiptDialogProps) {
  const [receivedFeet, setReceivedFeet] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setError('');
      return;
    }
    setReceivedFeet(String(receipt?.receiptContributionFeet ?? ''));
    setReason('');
    setError('');
  }, [open, receipt]);

  function requestClose() {
    if (!pending) {
      onCancel();
    }
  }

  async function submit() {
    const normalizedReason = reason.trim();
    if (!receipt?.linkId || receipt.receiptHistoryStatus !== 'FINALIZED') {
      setError('This receipt is not available for correction.');
      return;
    }
    if (!/^\d+$/.test(receivedFeet)) {
      setError('Corrected Received LF must be a non-negative whole number.');
      return;
    }
    const correctedReceivedFeet = Number(receivedFeet);
    if (!Number.isSafeInteger(correctedReceivedFeet) || correctedReceivedFeet > 2147483647) {
      setError('Corrected Received LF is outside the supported range.');
      return;
    }
    if (correctedReceivedFeet === receipt.receiptContributionFeet) {
      setError('Enter a value different from the recorded receipt.');
      return;
    }
    if (!normalizedReason) {
      setError('A correction reason is required.');
      return;
    }

    setError('');
    await onConfirm(correctedReceivedFeet, normalizedReason);
  }

  return (
    <DialogSurface
      open={open}
      onClose={requestClose}
      className="dialog-caulk-checkin"
      backdropClassName="dialog-backdrop-centered"
      titleId="correct-film-order-receipt-title"
      descriptionId="correct-film-order-receipt-description"
    >
      <div className="dialog-header">
        <h2 id="correct-film-order-receipt-title">Correct Received LF</h2>
        <button
          type="button"
          className="dialog-close"
          aria-label="Close receipt correction dialog"
          onClick={requestClose}
          disabled={pending}
        >
          X
        </button>
      </div>
      <p id="correct-film-order-receipt-description" className="muted-text dialog-message">
        {filmOrderId} / {receipt?.boxId || 'Linked box'} currently records{' '}
        {receipt?.receiptContributionFeet ?? 0} LF received. This changes Film Order history only.
      </p>
      <div className="form-grid">
        <Input
          label="Corrected Received LF"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={10}
          value={receivedFeet}
          autoFocus
          onChange={(event) => {
            if (/^\d*$/.test(event.target.value)) {
              setReceivedFeet(event.target.value);
              setError('');
            }
          }}
          disabled={pending}
        />
        <TextArea
          label="Correction reason"
          maxLength={500}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setError('');
          }}
          disabled={pending}
        />
      </div>
      {error ? <p className="error-text">{error}</p> : null}
      <div className="dialog-actions dialog-actions-sticky-footer">
        <Button type="button" variant="ghost" onClick={requestClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" variant="primary" onClick={() => void submit()} disabled={pending}>
          {pending ? 'Correcting...' : 'Save Correction'}
        </Button>
      </div>
    </DialogSurface>
  );
}
