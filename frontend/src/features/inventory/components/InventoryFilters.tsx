import { useState } from 'react';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Input';
import { Select } from '../../../components/Select';
import type { InventoryFilterValues } from '../schemas/boxSchemas';
import { STANDARD_WIDTH_OPTIONS, getWidthMode } from '../utils/boxHelpers';

interface InventoryFiltersProps {
  values: InventoryFilterValues;
  onChange: (next: Partial<InventoryFilterValues>) => void;
}

export function InventoryFilters({ values, onChange }: InventoryFiltersProps) {
  const [isCustomWidthOpen, setIsCustomWidthOpen] = useState(false);
  const [customWidthDraft, setCustomWidthDraft] = useState('');
  const widthMode = values.width ? getWidthMode(values.width) : '';
  const widthButtonValues = [...STANDARD_WIDTH_OPTIONS, 'CUSTOM'] as const;
  const isCustomWidthValid =
    customWidthDraft.trim() !== '' &&
    Number.isFinite(Number(customWidthDraft)) &&
    Number(customWidthDraft) >= 0;

  function handleWidthButtonClick(value: (typeof widthButtonValues)[number]) {
    if (value === 'CUSTOM') {
      setCustomWidthDraft(widthMode === 'CUSTOM' ? values.width : '');
      setIsCustomWidthOpen(true);
      return;
    }

    onChange({ width: value });
  }

  function saveCustomWidth() {
    if (!isCustomWidthValid) {
      return;
    }

    onChange({ width: customWidthDraft.trim() });
    setIsCustomWidthOpen(false);
  }

  return (
    <>
      <div className="filters-grid">
        <Input
          label="Search"
          value={values.q}
          onChange={(event) => onChange({ q: event.target.value })}
          placeholder="BoxID, manufacturer, film"
        />
        <Select
          label="Status"
          value={values.status}
          onChange={(event) =>
            onChange({
              status: event.target.value as InventoryFilterValues['status']
            })
          }
          options={[
            { label: 'All', value: '' },
            { label: 'Ordered', value: 'ORDERED' },
            { label: 'In Stock', value: 'IN_STOCK' },
            { label: 'Checked Out', value: 'CHECKED_OUT' },
            { label: 'Zeroed', value: 'ZEROED' }
          ]}
        />
        <div className="field width-selector">
          <span className="field-label">Width</span>
          <div className="width-button-grid">
            {widthButtonValues.map((value) => {
              const isActive = value === 'CUSTOM' ? widthMode === 'CUSTOM' : widthMode === value;
              const buttonLabel =
                value === 'CUSTOM' && widthMode === 'CUSTOM' && values.width
                  ? values.width
                  : value === 'CUSTOM'
                    ? 'Cust.'
                    : value;

              return (
                <button
                  key={value}
                  type="button"
                  className={`width-chip ${isActive ? 'width-chip-active' : ''}`.trim()}
                  onClick={() => handleWidthButtonClick(value)}
                >
                  {buttonLabel}
                </button>
              );
            })}
          </div>
          {values.width ? (
            <Button type="button" variant="ghost" className="width-clear-button" onClick={() => onChange({ width: '' })}>
              All Widths
            </Button>
          ) : null}
        </div>
      </div>

      {isCustomWidthOpen ? (
        <div
          className="dialog-backdrop"
          role="presentation"
          onClick={() => setIsCustomWidthOpen(false)}
        >
          <div
            className="dialog width-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="inventory-custom-width-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-header">
              <h2 id="inventory-custom-width-title">Custom Width</h2>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close custom width dialog"
                onClick={() => setIsCustomWidthOpen(false)}
              >
                X
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
          </div>
        </div>
      ) : null}
    </>
  );
}
