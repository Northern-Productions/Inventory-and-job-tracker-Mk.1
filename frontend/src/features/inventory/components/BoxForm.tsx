import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import type { Warehouse } from '../../../domain';
import { Input, TextArea } from '../../../components/Input';
import {
  CORE_TYPE_OPTIONS,
  MANUFACTURER_OPTIONS,
  STANDARD_WIDTH_OPTIONS,
  getWidthMode,
  type BoxDraft
} from '../utils/boxHelpers';
import { WarehouseToggle } from './WarehouseToggle';

interface BoxFormProps {
  initialDraft: BoxDraft;
  resetKey: string;
  mode: 'create' | 'edit';
  submitLabel: string;
  submitting?: boolean;
  createWarehouse?: Warehouse;
  nextBoxIdByWarehouse?: Record<Warehouse, string>;
  onCreateWarehouseChange?: (warehouse: Warehouse) => void;
  onSubmit: (draft: BoxDraft) => void;
  onCancel?: () => void;
}

export function BoxForm({
  initialDraft,
  resetKey,
  mode,
  submitLabel,
  submitting = false,
  createWarehouse,
  nextBoxIdByWarehouse,
  onCreateWarehouseChange,
  onSubmit,
  onCancel
}: BoxFormProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [widthMode, setWidthMode] = useState(getWidthMode(initialDraft.widthIn));
  const [isCustomWidthOpen, setIsCustomWidthOpen] = useState(false);
  const [customWidthDraft, setCustomWidthDraft] = useState('');
  const lastSuggestedBoxIdRef = useRef(initialDraft.boxId);
  const lastCreateWarehouseRef = useRef<Warehouse | null>(createWarehouse ?? null);

  useEffect(() => {
    setDraft(initialDraft);
    setWidthMode(getWidthMode(initialDraft.widthIn));
    setIsCustomWidthOpen(false);
    setCustomWidthDraft(getWidthMode(initialDraft.widthIn) === 'CUSTOM' ? initialDraft.widthIn : '');
    lastSuggestedBoxIdRef.current = initialDraft.boxId;
    lastCreateWarehouseRef.current = createWarehouse ?? null;
  }, [initialDraft, resetKey]);

  useEffect(() => {
    if (mode !== 'create' || !createWarehouse || !nextBoxIdByWarehouse) {
      return;
    }

    const suggestedBoxId = nextBoxIdByWarehouse[createWarehouse] || '';
    if (!suggestedBoxId) {
      return;
    }

    setDraft((current) => {
      const warehouseChanged = lastCreateWarehouseRef.current !== createWarehouse;
      const shouldReplace =
        warehouseChanged || current.boxId.trim() === '' || current.boxId === lastSuggestedBoxIdRef.current;

      lastCreateWarehouseRef.current = createWarehouse;

      if (!shouldReplace) {
        return current;
      }

      lastSuggestedBoxIdRef.current = suggestedBoxId;
      return {
        ...current,
        boxId: suggestedBoxId
      };
    });
  }, [createWarehouse, mode, nextBoxIdByWarehouse]);

  const updateField = <K extends keyof BoxDraft,>(key: K, value: BoxDraft[K]) => {
    setDraft((current) => ({
      ...current,
      [key]: value
    }));
  };

  const widthButtonValues = [...STANDARD_WIDTH_OPTIONS, 'CUSTOM'] as const;
  const isCustomWidthValid =
    customWidthDraft.trim() !== '' &&
    Number.isFinite(Number(customWidthDraft)) &&
    Number(customWidthDraft) >= 0;
  const canCaptureReceivingDetails = draft.receivedDate.trim() !== '';

  const handleWidthButtonClick = (value: (typeof widthButtonValues)[number]) => {
    if (value === 'CUSTOM') {
      setCustomWidthDraft(widthMode === 'CUSTOM' ? draft.widthIn : '');
      setIsCustomWidthOpen(true);
      return;
    }

    setWidthMode(value);
    updateField('widthIn', value);
  };

  const saveCustomWidth = () => {
    if (!isCustomWidthValid) {
      return;
    }

    const nextWidth = customWidthDraft.trim();
    setWidthMode('CUSTOM');
    updateField('widthIn', nextWidth);
    setIsCustomWidthOpen(false);
  };

  const handleBoxIdChange = (value: string) => {
    if (mode === 'create' && createWarehouse === 'MS') {
      const normalized = value.toUpperCase();
      const withoutPrefix = normalized.replace(/^M+/, '');
      updateField('boxId', `M${withoutPrefix}`);
      return;
    }

    updateField('boxId', value);
  };

  return (
    <>
      <form
        className="panel"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(draft);
        }}
      >
        <div className="panel-title-row">
          <h2>{mode === 'create' ? 'Add Box' : 'Edit Box'}</h2>
          {mode === 'create' && createWarehouse && onCreateWarehouseChange ? (
            <WarehouseToggle value={createWarehouse} onChange={onCreateWarehouseChange} />
          ) : null}
          {mode === 'edit' && onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
        <div className="form-grid">
          <Input
            label="BoxID"
            value={draft.boxId}
            onChange={(event) => handleBoxIdChange(event.target.value)}
            disabled={mode === 'edit'}
            required
          />
          {mode === 'create' ? (
            <label className="field">
              <span className="field-label">Manufacturer</span>
              <select
                className="field-input"
                value={draft.manufacturer}
                onChange={(event) => updateField('manufacturer', event.target.value)}
                required
              >
                {MANUFACTURER_OPTIONS.map((manufacturer) => (
                  <option key={manufacturer} value={manufacturer}>
                    {manufacturer}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <Input
              label="Manufacturer"
              value={draft.manufacturer}
              onChange={(event) => updateField('manufacturer', event.target.value)}
              required
            />
          )}
          <Input
            label="Film Name"
            value={draft.filmName}
            onChange={(event) => updateField('filmName', event.target.value)}
            required
          />
          <div className="field width-selector">
            <span className="field-label">Width</span>
            <div className="width-button-grid">
              {widthButtonValues.map((value) => {
                const isActive = value === 'CUSTOM' ? widthMode === 'CUSTOM' : widthMode === value;
                const buttonLabel =
                  value === 'CUSTOM' && widthMode === 'CUSTOM' && draft.widthIn
                    ? draft.widthIn
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
          </div>
          <Input
            label="Linear Feet"
            type="number"
            step="1"
            value={draft.initialFeet}
            onChange={(event) => updateField('initialFeet', event.target.value)}
            required
          />
          {mode === 'edit' ? (
            <Input
              label="Feet Available"
              type="number"
              step="1"
              value={draft.feetAvailable}
              onChange={(event) => updateField('feetAvailable', event.target.value)}
              required
            />
          ) : null}
          {mode === 'edit' ? (
            <Input
              label="Lot Run"
              value={draft.lotRun}
              onChange={(event) => updateField('lotRun', event.target.value)}
            />
          ) : null}
          <Input
            label="Purchase Cost"
            type="number"
            step="0.01"
            min="0"
            value={draft.purchaseCost}
            onChange={(event) => updateField('purchaseCost', event.target.value)}
          />
          <Input
            label="Order Date"
            type="date"
            value={draft.orderDate}
            onChange={(event) => updateField('orderDate', event.target.value)}
            required
          />
          <Input
            label="Received Date"
            type="date"
            value={draft.receivedDate}
            onChange={(event) => updateField('receivedDate', event.target.value)}
          />
          <Input
            label="Initial Weight (lbs)"
            type="number"
            step="0.01"
            min="0"
            value={draft.initialWeightLbs}
            onChange={(event) => updateField('initialWeightLbs', event.target.value)}
            disabled={!canCaptureReceivingDetails}
            hint={
              canCaptureReceivingDetails
                ? 'Required the first time a received film key is saved.'
                : 'Add a received date to capture initial roll weight.'
            }
          />
          <label className="field">
            <span className="field-label">Core Type</span>
            <select
              className="field-input"
              value={draft.coreType}
              onChange={(event) => updateField('coreType', event.target.value)}
              disabled={!canCaptureReceivingDetails}
            >
              <option value="">Select core type</option>
              {CORE_TYPE_OPTIONS.map((coreType) => (
                <option key={coreType} value={coreType}>
                  {coreType}
                </option>
              ))}
            </select>
            <span className="field-hint">
              {canCaptureReceivingDetails
                ? 'Stored on the film key for future auto-filled boxes.'
                : 'Add a received date to set the core type.'}
            </span>
          </label>
          {mode === 'edit' ? (
            <Input
              label="Last Roll Weight (lbs)"
              type="number"
              step="0.01"
              min="0"
              value={draft.lastRollWeightLbs}
              onChange={(event) => updateField('lastRollWeightLbs', event.target.value)}
            />
          ) : null}
          {mode === 'edit' ? (
            <Input
              label="Last Weighed Date"
              type="date"
              value={draft.lastWeighedDate}
              onChange={(event) => updateField('lastWeighedDate', event.target.value)}
            />
          ) : null}
        </div>
        <TextArea
          label="Notes"
          value={draft.notes}
          onChange={(event) => updateField('notes', event.target.value)}
        />
        {mode === 'edit' ? (
          <p className="muted-text">
            Editing Initial Feet, Feet Available, or Width requires confirmation and a reason.
          </p>
        ) : null}
        <div className="page-actions form-actions">
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : submitLabel}
          </Button>
        </div>
      </form>

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
            aria-labelledby="custom-width-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-header">
              <h2 id="custom-width-title">Custom Width</h2>
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
