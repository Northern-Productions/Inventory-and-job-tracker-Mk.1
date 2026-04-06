import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import { Input, TextArea } from '../../../components/Input';
import type { FilmCatalogEntry, Warehouse } from '../../../domain';
import {
  CORE_TYPE_OPTIONS,
  STANDARD_WIDTH_OPTIONS,
  deriveFeetAvailableFromRollWeight,
  deriveLastRollWeightLbsFromCurrentFeet,
  getWarehouseBoxIdPrefixToken,
  isWarehousePrefixOnlyBoxId,
  getManufacturerOptionsWithCatalog,
  getWidthMode,
  hasManufacturerOption,
  normalizeCreateBoxIdForWarehouse,
  remapCreateBoxIdForWarehouse,
  type BoxDraft
} from '../utils/boxHelpers';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { getWarehousePrefix } from '../utils/warehouseOptions';
import { FilmNameAutocompleteInput } from './FilmNameAutocompleteInput';

const CUSTOM_MANUFACTURER_OPTION = '__custom_manufacturer__';
const DELETE_DIALOG_FADE_MS = 180;
const DELETE_BACKDROP_FADE_MS = 180;

interface BoxFormProps {
  initialDraft: BoxDraft;
  resetKey: string;
  mode: 'create' | 'edit';
  submitLabel: string;
  disabled?: boolean;
  submitting?: boolean;
  deleting?: boolean;
  preserveInitialFeetInEdit?: boolean;
  createWarehouse?: Warehouse;
  nextBoxIdForCreateWarehouse?: string;
  filmCatalogEntries?: FilmCatalogEntry[];
  filmCatalogLoading?: boolean;
  filmCatalogError?: unknown;
  onSubmit: (draft: BoxDraft) => void;
  onCancel?: () => void;
  onDelete?: () => void;
}

export function BoxForm({
  initialDraft,
  resetKey,
  mode,
  submitLabel,
  disabled = false,
  submitting = false,
  deleting = false,
  preserveInitialFeetInEdit = false,
  createWarehouse,
  nextBoxIdForCreateWarehouse,
  filmCatalogEntries,
  filmCatalogLoading = false,
  filmCatalogError,
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
  const [hasAutoSelectedManufacturer, setHasAutoSelectedManufacturer] = useState(false);
  const lastSuggestedBoxIdRef = useRef(initialDraft.boxId);
  const lastCreateWarehouseRef = useRef<Warehouse | null>(createWarehouse ?? null);
  const deleteDialogTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warehouseRegistry = useWarehouseRegistry();
  const createWarehousePrefix = getWarehousePrefix(warehouseRegistry.entries, createWarehouse || '');
  const createWarehousePrefixToken = getWarehouseBoxIdPrefixToken(createWarehousePrefix);

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
    setHasAutoSelectedManufacturer(false);
    resetDeleteDialog();
  }, [initialDraft, resetKey]);

  useEffect(() => {
    if (mode !== 'create' || !createWarehouse) {
      return;
    }

    setDraft((current) => {
      const warehouseChanged = lastCreateWarehouseRef.current !== createWarehouse;
      const previousWarehousePrefix = getWarehousePrefix(
        warehouseRegistry.entries,
        lastCreateWarehouseRef.current || ''
      );
      const shouldReplace =
        current.boxId.trim() === '' ||
        current.boxId === lastSuggestedBoxIdRef.current ||
        isWarehousePrefixOnlyBoxId(current.boxId, previousWarehousePrefix || createWarehousePrefix);

      lastCreateWarehouseRef.current = createWarehouse;

      if (shouldReplace) {
        if (nextBoxIdForCreateWarehouse) {
          lastSuggestedBoxIdRef.current = nextBoxIdForCreateWarehouse;
          return current.boxId === nextBoxIdForCreateWarehouse
            ? current
            : {
                ...current,
                boxId: nextBoxIdForCreateWarehouse
              };
        }

        if (createWarehousePrefixToken && current.boxId !== createWarehousePrefixToken) {
          return {
            ...current,
            boxId: createWarehousePrefixToken
          };
        }

        return current;
      }

      if (!warehouseChanged || !createWarehousePrefix) {
        return current;
      }

      const remappedBoxId = remapCreateBoxIdForWarehouse(current.boxId, createWarehousePrefix);
      if (remappedBoxId === current.boxId) {
        return current;
      }

      return {
        ...current,
        boxId: remappedBoxId
      };
    });
  }, [
    createWarehouse,
    createWarehousePrefix,
    createWarehousePrefixToken,
    mode,
    nextBoxIdForCreateWarehouse,
    warehouseRegistry.entries
  ]);

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

  const handleFootageChange = (value: string) => {
    const nextCurrentFeet = value.replace(/[^0-9]/g, '');

    setDraft((current) => {
      const nextDraft: BoxDraft = {
        ...current,
        currentFeetOnRoll: nextCurrentFeet,
        rollTrackingEditedField: mode === 'edit' ? 'currentFeetOnRoll' : ''
      };

      if (mode === 'create' || !preserveInitialFeetInEdit) {
        nextDraft.initialFeet = nextCurrentFeet;
      }

      if (mode === 'edit' && preserveInitialFeetInEdit) {
        const currentFeetValue = Number(nextCurrentFeet);
        const coreWeightValue = Number(current.coreWeightLbs);
        const lfWeightValue = Number(current.lfWeightLbsPerFt);

        if (
          nextCurrentFeet.trim() &&
          Number.isFinite(currentFeetValue) &&
          currentFeetValue >= 0 &&
          Number.isFinite(coreWeightValue) &&
          coreWeightValue >= 0 &&
          Number.isFinite(lfWeightValue) &&
          lfWeightValue > 0
        ) {
          nextDraft.lastRollWeightLbs = String(
            deriveLastRollWeightLbsFromCurrentFeet(currentFeetValue, coreWeightValue, lfWeightValue)
          );
        }
      }

      return nextDraft;
    });
  };

  const handleLastRollWeightChange = (value: string) => {
    setDraft((current) => {
      const nextDraft: BoxDraft = {
        ...current,
        lastRollWeightLbs: value,
        rollTrackingEditedField: 'lastRollWeightLbs'
      };

      if (mode === 'edit' && preserveInitialFeetInEdit) {
        const lastRollWeightValue = Number(value);
        const coreWeightValue = Number(current.coreWeightLbs);
        const lfWeightValue = Number(current.lfWeightLbsPerFt);
        const initialFeetValueForRollMath = Number(current.initialFeet);

        if (
          value.trim() &&
          Number.isFinite(lastRollWeightValue) &&
          lastRollWeightValue >= 0 &&
          Number.isFinite(coreWeightValue) &&
          coreWeightValue >= 0 &&
          Number.isFinite(lfWeightValue) &&
          lfWeightValue > 0 &&
          Number.isFinite(initialFeetValueForRollMath) &&
          initialFeetValueForRollMath >= 0
        ) {
          nextDraft.currentFeetOnRoll = String(
            deriveFeetAvailableFromRollWeight(
              lastRollWeightValue,
              coreWeightValue,
              lfWeightValue,
              initialFeetValueForRollMath
            )
          );
        }
      }

      return nextDraft;
    });
  };

  const widthButtonValues = [...STANDARD_WIDTH_OPTIONS, 'CUSTOM'] as const;
  const isCustomWidthValid =
    customWidthDraft.trim() !== '' &&
    Number.isFinite(Number(customWidthDraft)) &&
    Number(customWidthDraft) >= 0;
  const canCaptureReceivingDetails = draft.receivedDate.trim() !== '';
  const purchaseCostValue = Number(draft.purchaseCost);
  const initialFeetValue = Number(draft.initialFeet);
  const hasPurchaseCost = draft.purchaseCost.trim() !== '';
  const shouldAutoDerivePricePerLf =
    hasPurchaseCost &&
    Number.isFinite(purchaseCostValue) &&
    purchaseCostValue >= 0 &&
    Number.isFinite(initialFeetValue) &&
    initialFeetValue > 0;
  const derivedPricePerLf = shouldAutoDerivePricePerLf
    ? (Math.round((purchaseCostValue / initialFeetValue) * 10000) / 10000).toFixed(4)
    : '';
  const pricePerLfHint = shouldAutoDerivePricePerLf
    ? 'Auto-calculated from Purchase Cost / Initial Linear Feet.'
    : hasPurchaseCost
      ? 'Initial Linear Feet must be greater than 0 when Purchase Cost is set.'
      : undefined;
  const footageFieldLabel = mode === 'create' ? 'Initial Linear Feet' : 'Current Linear Feet';
  const footageSectionCopy =
    mode === 'create'
      ? 'Set the label, product, width, and starting footage.'
      : 'Set the label, product, width, and current footage.';
  const manufacturerOptions = getManufacturerOptionsWithCatalog(filmCatalogEntries);
  const isKnownManufacturer = hasManufacturerOption(draft.manufacturer, manufacturerOptions);
  const manufacturerSelectValue = isKnownManufacturer
    ? draft.manufacturer
    : CUSTOM_MANUFACTURER_OPTION;
  const isCustomManufacturerSelected = manufacturerSelectValue === CUSTOM_MANUFACTURER_OPTION;
  const isDeleteConfirmUnlocked = deleteConfirmText.trim().toLowerCase() === 'delete';

  useEffect(() => {
    if (
      mode !== 'create' ||
      hasAutoSelectedManufacturer ||
      draft.manufacturer.trim() ||
      manufacturerOptions.length === 0
    ) {
      return;
    }

    setDraft((current) => ({
      ...current,
      manufacturer: manufacturerOptions[0]
    }));
    setHasAutoSelectedManufacturer(true);
  }, [
    draft.manufacturer,
    hasAutoSelectedManufacturer,
    manufacturerOptions,
    mode
  ]);

  useEffect(() => {
    if (!shouldAutoDerivePricePerLf) {
      return;
    }

    setDraft((current) =>
      current.pricePerLf === derivedPricePerLf
        ? current
        : {
            ...current,
            pricePerLf: derivedPricePerLf
          }
    );
  }, [derivedPricePerLf, shouldAutoDerivePricePerLf]);

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
    if (mode === 'create' && createWarehousePrefix) {
      updateField('boxId', normalizeCreateBoxIdForWarehouse(value, createWarehousePrefix));
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
          if (disabled) {
            return;
          }
          onSubmit(draft);
        }}
      >
        {mode === 'edit' ? (
          <>
            <div className="panel-title-row">
              <h2>Edit Box</h2>
              {onCancel ? (
                <Button type="button" variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              ) : null}
            </div>
            <p className="muted-text form-intro">
              Update the box record without changing its workflow logic or warehouse rules.
            </p>
          </>
        ) : null}

        <div className={`form-section ${mode === 'create' ? 'form-section-first' : ''}`.trim()}>
          <div className="form-section-header">
            <h3>Box Identity</h3>
            <p className="muted-text">{footageSectionCopy}</p>
          </div>
          <div className="form-grid">
          <Input
            label="BoxID"
            value={draft.boxId}
            onChange={(event) => handleBoxIdChange(event.target.value)}
            disabled={mode === 'edit'}
            required
          />
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
            label={footageFieldLabel}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={mode === 'create' ? draft.initialFeet : draft.currentFeetOnRoll}
            onChange={(event) => handleFootageChange(event.target.value)}
            required
          />
          <Input
            label="Lot Run"
            value={draft.lotRun}
            onChange={(event) => updateField('lotRun', event.target.value)}
          />
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-header">
            <h3>Dates And Costing</h3>
            <p className="muted-text">Capture order timing, purchase cost, and derived pricing.</p>
          </div>
          <div className="form-grid">
          <Input
            label="Price / LF"
            type="number"
            step="0.0001"
            min="0"
            value={draft.pricePerLf}
            onChange={(event) => updateField('pricePerLf', event.target.value)}
            readOnly={shouldAutoDerivePricePerLf}
            disabled={shouldAutoDerivePricePerLf}
            hint={pricePerLfHint}
          />
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
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-header">
            <h3>Roll Tracking</h3>
            <p className="muted-text">Store the physical roll details used for check-in and stock math.</p>
          </div>
          <div className="form-grid">
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
              onChange={(event) => handleLastRollWeightChange(event.target.value)}
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
        </div>

        <div className="form-section">
          <div className="form-section-header">
            <h3>Notes</h3>
            <p className="muted-text">Capture anything installers or coordinators should see later.</p>
          </div>
          <TextArea
            label="Notes"
            value={draft.notes}
            onChange={(event) => updateField('notes', event.target.value)}
          />
        </div>
        <div className="page-actions form-actions">
          {mode === 'edit' && onDelete ? (
            <Button
              type="button"
              variant="danger"
              onClick={openDeleteDialog}
              disabled={disabled || submitting || deleting}
            >
              Delete
            </Button>
          ) : null}
          <Button type="submit" disabled={disabled || submitting || deleting}>
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
        <DialogSurface
          open={isCustomWidthOpen}
          onClose={() => setIsCustomWidthOpen(false)}
          className="width-dialog"
          titleId="custom-width-title"
          closeOnBackdrop
        >
            <div className="dialog-header">
              <h2 id="custom-width-title">Custom Width</h2>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close custom width dialog"
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
