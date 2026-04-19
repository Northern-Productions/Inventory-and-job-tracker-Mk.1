import { useId } from 'react';
import { Button } from '../../../../components/Button';
import { DialogSurface } from '../../../../components/DialogSurface';
import { TextArea } from '../../../../components/Input';
import { DealerField } from './DealerField';

interface MissingDealerDialogProps {
  open: boolean;
  dealerHint?: string;
  dealerOptions: string[];
  dealerSelectValue: string;
  dealerValue: string;
  isCustomDealerSelected: boolean;
  comment: string;
  submitting?: boolean;
  onDealerInputChange: (value: string) => void;
  onDealerSelectChange: (value: string) => void;
  onCommentChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

const MISSING_DEALER_MESSAGE =
  "You didn't enter the dealer this film was purchased through. Enter a dealer or explain why there is no dealer.";

export function MissingDealerDialog({
  open,
  dealerHint,
  dealerOptions,
  dealerSelectValue,
  dealerValue,
  isCustomDealerSelected,
  comment,
  submitting = false,
  onDealerInputChange,
  onDealerSelectChange,
  onCommentChange,
  onCancel,
  onSubmit
}: MissingDealerDialogProps) {
  const titleId = useId();
  const messageId = useId();

  if (!open) {
    return null;
  }

  return (
    <DialogSurface open={open} onClose={onCancel} titleId={titleId} descriptionId={messageId}>
      <div className="dialog-header">
        <h2 id={titleId}>Missing Dealer</h2>
        <button type="button" className="dialog-close" aria-label="Close dialog" onClick={onCancel}>
          x
        </button>
      </div>
      <p id={messageId} className="muted-text dialog-message">
        {MISSING_DEALER_MESSAGE}
      </p>
      <DealerField
        dealerHint={dealerHint}
        dealerOptions={dealerOptions}
        dealerSelectValue={dealerSelectValue}
        dealerValue={dealerValue}
        isCustomDealerSelected={isCustomDealerSelected}
        onDealerInputChange={onDealerInputChange}
        onDealerSelectChange={onDealerSelectChange}
        autoFocusSelect
      />
      <TextArea
        label="Comment"
        value={comment}
        onChange={(event) => onCommentChange(event.target.value)}
        rows={4}
        placeholder="Explain why there is no dealer"
      />
      <div className="dialog-actions">
        <Button type="button" variant="ghost" fullWidth onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="button" fullWidth onClick={onSubmit} disabled={submitting}>
          Submit
        </Button>
      </div>
    </DialogSurface>
  );
}
