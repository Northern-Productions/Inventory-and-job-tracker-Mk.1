import { useEffect, useMemo, useState, type InputHTMLAttributes } from 'react';
import { Button } from './Button';
import { Input, TextArea } from './Input';
import { Select } from './Select';

interface ReasonOption {
  label: string;
  value: string;
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  requireReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  reasonField?: 'textarea' | 'input';
  reasonInputType?: InputHTMLAttributes<HTMLInputElement>['type'];
  reasonInputStep?: InputHTMLAttributes<HTMLInputElement>['step'];
  reasonInputMin?: InputHTMLAttributes<HTMLInputElement>['min'];
  reasonInputMode?: InputHTMLAttributes<HTMLInputElement>['inputMode'];
  reasonInputPattern?: InputHTMLAttributes<HTMLInputElement>['pattern'];
  reasonDigitsOnly?: boolean;
  reasonOptions?: ReasonOption[];
  reasonSelectLabel?: string;
  reasonAllowCustomOption?: boolean;
  reasonCustomOptionLabel?: string;
  customReasonLabel?: string;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

const CUSTOM_REASON_OPTION_VALUE = '__custom_reason__';

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  requireReason = false,
  reasonLabel = 'Reason',
  reasonPlaceholder = 'Required',
  reasonField = 'textarea',
  reasonInputType = 'text',
  reasonInputStep,
  reasonInputMin,
  reasonInputMode,
  reasonInputPattern,
  reasonDigitsOnly = false,
  reasonOptions,
  reasonSelectLabel,
  reasonAllowCustomOption = false,
  reasonCustomOptionLabel = 'Enter New Value',
  customReasonLabel,
  onCancel,
  onConfirm
}: ConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const [selectedReasonOption, setSelectedReasonOption] = useState('');

  const selectOptions = useMemo(() => {
    if (!reasonOptions?.length) {
      return [];
    }

    if (!reasonAllowCustomOption) {
      return reasonOptions;
    }

    return [
      ...reasonOptions,
      {
        label: reasonCustomOptionLabel,
        value: CUSTOM_REASON_OPTION_VALUE
      }
    ];
  }, [reasonAllowCustomOption, reasonCustomOptionLabel, reasonOptions]);

  const usesReasonOptions = requireReason && selectOptions.length > 0;
  const usesCustomReasonInput =
    usesReasonOptions &&
    reasonAllowCustomOption &&
    selectedReasonOption === CUSTOM_REASON_OPTION_VALUE;

  const resolvedReason = usesReasonOptions
    ? usesCustomReasonInput
      ? reason.trim()
      : selectedReasonOption.trim()
    : reason.trim();

  function handleReasonChange(nextValue: string) {
    setReason(reasonDigitsOnly ? nextValue.replace(/\D+/g, '') : nextValue);
  }

  useEffect(() => {
    if (!open) {
      setReason('');
      setSelectedReasonOption('');
      return;
    }

    if (selectOptions.length > 0) {
      setSelectedReasonOption(selectOptions[0].value);
    }
  }, [open, selectOptions]);

  if (!open) {
    return null;
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{title}</h2>
        <p className="muted-text">{message}</p>
        {requireReason ? (
          usesReasonOptions ? (
            <>
              <Select
                label={reasonSelectLabel || reasonLabel}
                options={selectOptions}
                value={selectedReasonOption || selectOptions[0].value}
                onChange={(event) => setSelectedReasonOption(event.target.value)}
                autoFocus
              />
              {usesCustomReasonInput ? (
                <Input
                  label={customReasonLabel || reasonLabel}
                  type={reasonInputType}
                  step={reasonInputStep}
                  min={reasonInputMin}
                  inputMode={reasonInputMode}
                  pattern={reasonInputPattern}
                  value={reason}
                  onChange={(event) => handleReasonChange(event.target.value)}
                  placeholder={reasonPlaceholder}
                />
              ) : null}
            </>
          ) : reasonField === 'input' ? (
            <Input
              label={reasonLabel}
              type={reasonInputType}
              step={reasonInputStep}
              min={reasonInputMin}
              inputMode={reasonInputMode}
              pattern={reasonInputPattern}
              value={reason}
              onChange={(event) => handleReasonChange(event.target.value)}
              placeholder={reasonPlaceholder}
              autoFocus
            />
          ) : (
            <TextArea
              label={reasonLabel}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
              placeholder={reasonPlaceholder}
            />
          )
        ) : null}
        <div className="dialog-actions">
          <Button type="button" variant="ghost" fullWidth onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="danger"
            fullWidth
            onClick={() => onConfirm(resolvedReason)}
            disabled={requireReason && !resolvedReason}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
