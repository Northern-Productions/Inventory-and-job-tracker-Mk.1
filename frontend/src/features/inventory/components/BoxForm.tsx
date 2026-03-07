import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { Input, TextArea } from '../../../components/Input';
import type { FilmCatalogEntry, Warehouse } from '../../../domain';
import {
  CORE_TYPE_OPTIONS,
  STANDARD_WIDTH_OPTIONS,
  getManufacturerOptions,
  getWidthMode,
  hasManufacturerOption,
  type BoxDraft
} from '../utils/boxHelpers';
import { FilmNameAutocompleteInput } from './FilmNameAutocompleteInput';
import { WarehouseToggle } from './WarehouseToggle';

const CUSTOM_MANUFACTURER_OPTION = '__custom_manufacturer__';
const DELETE_DIALOG_FADE_MS = 180;
const DELETE_BACKDROP_FADE_MS = 180;

interface BoxFormProps {
  initialDraft: BoxDraft;
  resetKey: string;
  mode: 'create' | 'edit';
  submitLabel: string;
  submitting?: boolean;
  deleting?: boolean;
  createWarehouse?: Warehouse;
  nextBoxIdByWarehouse?: Record<Warehouse, string>;
  filmCatalogEntries?: FilmCatalogEntry[];
  filmCatalogLoading?: boolean;
  filmCatalogError?: unknown;
  onCreateWarehouseChange?: (warehouse: Warehouse) => void;
  onSubmit: (draft: BoxDraft) => void;
  onCancel?: () => void;
  onDelete?: () => void;
}

export function BoxForm({
  initialDraft,
  resetKey,
  mode,
  submitLabel,
  submitting = false,
  deleting = false,
  createWarehouse,
  nextBoxIdByWarehouse,
  filmCatalogEntries,
  filmCatalogLoading = false,
  filmCatalogError,
  onCreateWarehouseChange,
  onSubmit,
  onCancel,
  onDelete
}: BoxFormProps) {
  const [draft, setDraft] = useState(initialDraft);
  const [widthMode, setWidthMode] = useState(getWidthMode(initialDraft.widthIn));
  const [isCustomWidthOpen, setIsCustomWidthOpen] = useState(false);
  const [customWidthDraft, setCustomWidthDraft] = useState('');
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleteDialogClosing, setIsDeleteDialogClosing] = useState(false);
  const [isDeleteBackdropClosing, setIsDeleteBackdropClosing] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const lastSuggestedBoxIdRef = useRef(initialDraft.boxId);
  const lastCreateWarehouseRef = useRef<Warehouse | null>(createWarehouse ?? null);
  const deleteDialogTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearDeleteDialogTimer() {
    if (deleteDialogTimeoutRef.current !== null) {
      clearTimeout(deleteDialogTimeoutRef.current);
      deleteDialogTimeoutRef.current = null;
    }
  }

  function resetDeleteDialog() {
    clearDeleteDialogTimer();
    setIsDeleteDialogOpen(false);
    setIsDeleteDialogClosing(false);
    setIsDeleteBackdropClosing(false);
    setDeleteConfirmText('');
  }

  function openDeleteDialog() {
    clearDeleteDialogTimer();
    setDeleteConfirmText('');
    setIsDeleteDialogClosing(false);
    setIsDeleteBackdropClosing(false);
    setIsDeleteDialogOpen(true);
  }

  function closeDeleteDialog(afterClose?: () => void) {
    if (!isDeleteDialogOpen || isDeleteDialogClosing) {
      return;
    }

    clearDeleteDialogTimer();
    setIsDeleteDialogClosing(true);
    setIsDeleteBackdropClosing(false);

    deleteDialogTimeoutRef.current = setTimeout(() => {
      setIsDeleteBackdropClosing(true);

      deleteDialogTimeoutRef.current = setTimeout(() => {
        resetDeleteDialog();
        afterClose?.();
      }, DELETE_BACKDROP_FADE_MS);
    }, DELETE_DIALOG_FADE_MS);
  }

  useEffect(() => {
    setDraft(initialDraft);
    setWidthMode(getWidthMode(initialDraft.widthIn));
    setIsCustomWidthOpen(false);
    setCustomWidthDraft(getWidthMode(initialDraft.widthIn) === 'CUSTOM' ? initialDraft.widthIn : '');
    lastSuggestedBoxIdRef.current = initialDraft.boxId;
    lastCreateWarehouseRef.current = createWarehouse ?? null;
    resetDeleteDialog();
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

  useEffect(
    () => () => {
      clearDeleteDialogTimer();
    },
    []
  );

  useEffect(() => {
    if (!isDeleteDialogOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isDeleteDialogClosing || deleting) {
        return;
      }

      event.preventDefault();
      closeDeleteDialog();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [deleting, isDeleteDialogClosing, isDeleteDialogOpen]);

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
  const manufacturerOptions = getManufacturerOptions();
  const isKnownManufacturer = hasManufacturerOption(draft.manufacturer, manufacturerOptions);
  const manufacturerSelectValue = isKnownManufacturer
    ? draft.manufacturer
    : CUSTOM_MANUFACTURER_OPTION;
  const isCustomManufacturerSelected = manufacturerSelectValue === CUSTOM_MANUFACTURER_OPTION;
  const isDeleteConfirmUnlocked = deleteConfirmText.trim().toLowerCase() === 'delete';

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
            <>
              <label className="field">
                <span className="field-label">Manufacturer</span>
                <select
                  className="field-input"
                  value={manufacturerSelectValue}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    if (nextValue === CUSTOM_MANUFACTURER_OPTION) {
                      if (isKnownManufacturer) {
                        updateField('manufacturer', '');
                      }
                      return;
                    }

                    updateField('manufacturer', nextValue);
                  }}
                  required
                >
                  {manufacturerOptions.map((manufacturer) => (
                    <option key={manufacturer} value={manufacturer}>
                      {manufacturer}
                    </option>
                  ))}
                  <option value={CUSTOM_MANUFACTURER_OPTION}>Enter New Manufacturer</option>
                </select>
              </label>
              {isCustomManufacturerSelected ? (
                <Input
                  label="New Manufacturer"
                  value={draft.manufacturer}
                  onChange={(event) => updateField('manufacturer', event.target.value)}
                  required
                />
              ) : null}
            </>
          ) : (
            <Input
              label="Manufacturer"
              value={draft.manufacturer}
              onChange={(event) => updateField('manufacturer', event.target.value)}
              required
            />
          )}
          <FilmNameAutocompleteInput
            label="Film Name"
            value={draft.filmName}
            manufacturer={draft.manufacturer}
            catalogEntries={filmCatalogEntries}
            catalogLoading={filmCatalogLoading}
            catalogError={filmCatalogError}
            onChange={(nextValue) => updateField('filmName', nextValue)}
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
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={draft.initialFeet}
            onChange={(event) =>
              updateField('initialFeet', event.target.value.replace(/[^0-9]/g, ''))
            }
            required
          />
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
              mode === 'create' && canCaptureReceivingDetails
                ? 'Required the first time a received film key is saved.'
                : mode === 'create'
                  ? 'Add a received date to capture initial roll weight.'
                  : undefined
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
            {mode === 'create' ? (
              <span className="field-hint">
                {canCaptureReceivingDetails
                  ? 'Stored on the film key for future auto-filled boxes.'
                  : 'Add a received date to set the core type.'}
              </span>
            ) : null}
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
        <div className="page-actions form-actions">
          {mode === 'edit' && onDelete ? (
            <Button
              type="button"
              variant="danger"
              onClick={openDeleteDialog}
              disabled={submitting || deleting}
            >
              Delete
            </Button>
          ) : null}
          <Button type="submit" disabled={submitting || deleting}>
            {submitting ? 'Saving...' : submitLabel}
          </Button>
        </div>
      </form>

      {isDeleteDialogOpen ? (
        <div
          className={`delete-dialog-backdrop ${isDeleteBackdropClosing ? 'delete-dialog-backdrop-closing' : ''}`.trim()}
          role="presentation"
        >
          <div
            className={`dialog delete-dialog ${isDeleteDialogClosing ? 'delete-dialog-closing' : ''}`.trim()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-box-title"
            aria-describedby="delete-box-message"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="delete-dialog-eyebrow">Warning</p>
            <h2 id="delete-box-title">Delete Box</h2>
            <p id="delete-box-message" className="delete-dialog-message">
              Are you sure? This action cannot be undone. Type &quot;Delete&quot; in order to
              delete.
            </p>
            <Input
              label='Type "Delete" to unlock delete'
              value={deleteConfirmText}
              onChange={(event) => setDeleteConfirmText(event.target.value)}
              placeholder="delete"
              autoFocus
              hint='Enter delete to enable the Delete button.'
            />
            <div className="dialog-actions delete-dialog-actions">
              <Button
                type="button"
                variant="ghost"
                fullWidth
                onClick={() => closeDeleteDialog()}
                disabled={isDeleteDialogClosing || deleting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                fullWidth
                onClick={() => closeDeleteDialog(() => onDelete?.())}
                disabled={!isDeleteConfirmUnlocked || isDeleteDialogClosing || deleting}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      ) : null}

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
