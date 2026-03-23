import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import { Input } from '../../../components/Input';
import { STANDARD_WIDTH_OPTIONS } from '../utils/boxHelpers';
import {
  applyCustomWidth,
  getActiveCustomWidth,
  normalizeSelectedWidths,
  removeCustomWidth,
  togglePresetWidth
} from '../utils/widthFilters';

interface WidthFilterFieldProps {
  widths: string[];
  rememberedCustomWidth: string;
  onWidthsChange: (widths: string[]) => void;
  onRememberedCustomWidthChange: (value: string) => void;
  className?: string;
  dialogTitle: string;
  dialogTitleId: string;
}

export function WidthFilterField({
  widths,
  rememberedCustomWidth,
  onWidthsChange,
  onRememberedCustomWidthChange,
  className = '',
  dialogTitle,
  dialogTitleId
}: WidthFilterFieldProps) {
  const [isCustomWidthOpen, setIsCustomWidthOpen] = useState(false);
  const [customWidthDraft, setCustomWidthDraft] = useState('');
  const normalizedWidths = useMemo(() => normalizeSelectedWidths(widths), [widths]);
  const activeCustomWidth = useMemo(() => getActiveCustomWidth(normalizedWidths), [normalizedWidths]);
  const customChipLabel = activeCustomWidth || rememberedCustomWidth || 'Cust.';
  const isCustomWidthValid =
    customWidthDraft.trim() !== '' &&
    Number.isFinite(Number(customWidthDraft)) &&
    Number(customWidthDraft) >= 0;

  useEffect(() => {
    if (activeCustomWidth && activeCustomWidth !== rememberedCustomWidth) {
      onRememberedCustomWidthChange(activeCustomWidth);
    }
  }, [activeCustomWidth, onRememberedCustomWidthChange, rememberedCustomWidth]);

  function handleWidthButtonClick(value: string | 'CUSTOM') {
    if (value === 'CUSTOM') {
      if (activeCustomWidth) {
        onWidthsChange(removeCustomWidth(normalizedWidths));
        return;
      }

      setCustomWidthDraft(rememberedCustomWidth);
      setIsCustomWidthOpen(true);
      return;
    }

    onWidthsChange(togglePresetWidth(normalizedWidths, value));
  }

  function saveCustomWidth() {
    if (!isCustomWidthValid) {
      return;
    }

    const nextSelection = applyCustomWidth(normalizedWidths, customWidthDraft);
    onRememberedCustomWidthChange(nextSelection.rememberedCustomWidth);
    onWidthsChange(nextSelection.widths);
    setIsCustomWidthOpen(false);
  }

  return (
    <>
      <div className={`field width-selector ${className}`.trim()}>
        <span className="field-label">Width</span>
        <div className="width-button-grid">
          {STANDARD_WIDTH_OPTIONS.map((value) => {
            const isActive = normalizedWidths.includes(value);

            return (
              <button
                key={value}
                type="button"
                className={`width-chip ${isActive ? 'width-chip-active' : ''}`.trim()}
                aria-pressed={isActive}
                onClick={() => handleWidthButtonClick(value)}
              >
                {value}
              </button>
            );
          })}
          <button
            type="button"
            className={`width-chip ${activeCustomWidth ? 'width-chip-active' : ''}`.trim()}
            aria-pressed={Boolean(activeCustomWidth)}
            onClick={() => handleWidthButtonClick('CUSTOM')}
          >
            {customChipLabel}
          </button>
        </div>
      </div>

      {isCustomWidthOpen ? (
        <DialogSurface
          open={isCustomWidthOpen}
          onClose={() => setIsCustomWidthOpen(false)}
          className="width-dialog"
          titleId={dialogTitleId}
          closeOnBackdrop
        >
          <div className="dialog-header">
            <h2 id={dialogTitleId}>{dialogTitle}</h2>
            <button
              type="button"
              className="dialog-close"
              aria-label={`Close ${dialogTitle.toLowerCase()} dialog`}
              onClick={() => setIsCustomWidthOpen(false)}
            >
              x
            </button>
          </div>
          <Input
            label="Width In"
            type="number"
            step="0.01"
            min="0"
            value={customWidthDraft}
            onChange={(event) => setCustomWidthDraft(event.target.value)}
            autoFocus
          />
          <div className="dialog-actions dialog-actions-center">
            <Button
              type="button"
              variant="primary"
              className="custom-width-save"
              onClick={saveCustomWidth}
              disabled={!isCustomWidthValid}
            >
              Save
            </Button>
          </div>
        </DialogSurface>
      ) : null}
    </>
  );
}
