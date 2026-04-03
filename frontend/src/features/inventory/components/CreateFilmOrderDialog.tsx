import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import { Input } from '../../../components/Input';
import type { CreateFilmOrderPayload, FilmCatalogEntry, Warehouse } from '../../../domain';
import {
  STANDARD_WIDTH_OPTIONS,
  canonicalizeManufacturerLabel,
  getManufacturerOptionsWithCatalog,
  hasManufacturerOption
} from '../utils/boxHelpers';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { FilmNameAutocompleteInput } from './FilmNameAutocompleteInput';
import { WarehouseSelectField } from './WarehouseSelectField';

const CUSTOM_MANUFACTURER_OPTION = '__custom_manufacturer__';
const WIDTH_BUTTON_VALUES = [...STANDARD_WIDTH_OPTIONS, 'CUSTOM'] as const;

interface CreateFilmOrderDialogProps {
  open: boolean;
  submitting?: boolean;
  filmCatalogEntries?: FilmCatalogEntry[];
  filmCatalogLoading?: boolean;
  filmCatalogError?: unknown;
  onCancel: () => void;
  onSubmit: (payload: CreateFilmOrderPayload) => void;
}

export function CreateFilmOrderDialog({
  open,
  submitting = false,
  filmCatalogEntries,
  filmCatalogLoading = false,
  filmCatalogError,
  onCancel,
  onSubmit
}: CreateFilmOrderDialogProps) {
  const manufacturerOptions = useMemo(
    () => getManufacturerOptionsWithCatalog(filmCatalogEntries),
    [filmCatalogEntries]
  );
  const warehouseRegistry = useWarehouseRegistry();
  const defaultWarehouse = warehouseRegistry.entries[0]?.code || '';
  const [warehouse, setWarehouse] = useState<Warehouse>(defaultWarehouse);
  const [jobNumber, setJobNumber] = useState('');
  const [manufacturer, setManufacturer] = useState<string>(manufacturerOptions[0] || '');
  const [filmName, setFilmName] = useState('');
  const [widthIn, setWidthIn] = useState('36');
  const [requestedFeet, setRequestedFeet] = useState('100');
  const [error, setError] = useState('');
  const [isCustomWidthOpen, setIsCustomWidthOpen] = useState(false);
  const [customWidthDraft, setCustomWidthDraft] = useState('');
  const isKnownManufacturer = hasManufacturerOption(manufacturer, manufacturerOptions);
  const manufacturerSelectValue = isKnownManufacturer
    ? manufacturer
    : CUSTOM_MANUFACTURER_OPTION;
  const isCustomManufacturerSelected = manufacturerSelectValue === CUSTOM_MANUFACTURER_OPTION;
  const hasCustomWidth =
    widthIn.trim() !== '' &&
    !STANDARD_WIDTH_OPTIONS.includes(widthIn as (typeof STANDARD_WIDTH_OPTIONS)[number]);
  const isCustomWidthValid =
    customWidthDraft.trim() !== '' &&
    Number.isFinite(Number(customWidthDraft)) &&
    Number(customWidthDraft) > 0;

  useEffect(() => {
    if (open) {
      return;
    }

    setWarehouse(defaultWarehouse);
    setJobNumber('');
    setManufacturer(manufacturerOptions[0] || '');
    setFilmName('');
    setWidthIn('36');
    setRequestedFeet('100');
    setCustomWidthDraft('');
    setIsCustomWidthOpen(false);
    setError('');
  }, [defaultWarehouse, manufacturerOptions, open]);

  if (!open) {
    return null;
  }

  function handleSubmit() {
    const parsedWidth = Number(widthIn);
    const parsedRequestedFeet = Number(requestedFeet);
    const normalizedManufacturer = canonicalizeManufacturerLabel(manufacturer);

    if (!jobNumber.trim()) {
      setError('Job ID is required.');
      return;
    }

    if (!filmName.trim()) {
      setError('Film Name is required.');
      return;
    }

    if (!normalizedManufacturer.trim()) {
      setError('Manufacturer is required.');
      return;
    }

    if (!Number.isFinite(parsedWidth) || parsedWidth <= 0) {
      setError('Width must be greater than zero.');
      return;
    }

    if (!Number.isFinite(parsedRequestedFeet) || parsedRequestedFeet <= 0) {
      setError('Linear Feet must be greater than zero.');
      return;
    }

    setError('');
    onSubmit({
      jobNumber: jobNumber.trim(),
      warehouse,
      manufacturer: normalizedManufacturer.trim(),
      filmName: filmName.trim(),
      widthIn: parsedWidth,
      requestedFeet: parsedRequestedFeet
    });
  }

  function handleWidthButtonClick(value: (typeof WIDTH_BUTTON_VALUES)[number]) {
    if (value === 'CUSTOM') {
      setCustomWidthDraft(hasCustomWidth ? widthIn : '');
      setIsCustomWidthOpen(true);
      setError('');
      return;
    }

    setWidthIn(value);
    setError('');
  }

  function saveCustomWidth() {
    if (!isCustomWidthValid) {
      return;
    }

    setWidthIn(customWidthDraft.trim());
    setError('');
    setIsCustomWidthOpen(false);
  }

  return (
    <>
      <DialogSurface open={open} onClose={onCancel} titleId="create-film-order-title">
        <div className="dialog-header">
          <h2 id="create-film-order-title">Order Film</h2>
          <button type="button" className="dialog-close" aria-label="Close film order dialog" onClick={onCancel}>
            x
          </button>
        </div>
        <div className="dialog-copy">
          <p className="muted-text">
            Save the film order first, then you will be sent to Add Box to create the incoming box records.
          </p>
        </div>
        <div className="form-grid">
          <WarehouseSelectField
            label="Warehouse"
            value={warehouse}
            onChange={(nextWarehouse) => setWarehouse(nextWarehouse as Warehouse)}
          />
          <Input
            label="Job ID"
            value={jobNumber}
            onChange={(event) => {
              setJobNumber(event.target.value);
              setError('');
            }}
            autoFocus
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
                    setManufacturer('');
                  }
                  setError('');
                  return;
                }

                setManufacturer(nextValue);
                setError('');
              }}
            >
              {manufacturerOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
              <option value={CUSTOM_MANUFACTURER_OPTION}>Enter New Manufacturer</option>
            </select>
          </label>
          {isCustomManufacturerSelected ? (
            <Input
              label="New Manufacturer"
              value={manufacturer}
              onChange={(event) => {
                setManufacturer(event.target.value);
                setError('');
              }}
              required
            />
          ) : null}
          <FilmNameAutocompleteInput
            label="Film Name"
            value={filmName}
            manufacturer={manufacturer}
            catalogEntries={filmCatalogEntries}
            catalogLoading={filmCatalogLoading}
            catalogError={filmCatalogError}
            onChange={(nextValue) => {
              setFilmName(nextValue);
              setError('');
            }}
            required
          />
          <div className="field width-selector">
            <span className="field-label">Width</span>
            <div className="width-button-grid">
              {WIDTH_BUTTON_VALUES.map((value) => {
                const isActive = value === 'CUSTOM' ? hasCustomWidth : widthIn === value;
                const buttonLabel =
                  value === 'CUSTOM' && hasCustomWidth
                    ? widthIn
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
            value={requestedFeet}
            onChange={(event) => {
              setRequestedFeet(event.target.value.replace(/[^0-9]/g, ''));
              setError('');
            }}
            required
          />
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <div className="dialog-actions">
          <Button type="button" variant="ghost" fullWidth onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" variant="secondary" fullWidth onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Saving...' : 'Save And Continue'}
          </Button>
        </div>
      </DialogSurface>

      {isCustomWidthOpen ? (
        <DialogSurface
          open={isCustomWidthOpen}
          onClose={() => setIsCustomWidthOpen(false)}
          className="width-dialog"
          titleId="create-film-order-custom-width-title"
          closeOnBackdrop
        >
          <div className="dialog-header">
            <h2 id="create-film-order-custom-width-title">Custom Width</h2>
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
            min="0.01"
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
