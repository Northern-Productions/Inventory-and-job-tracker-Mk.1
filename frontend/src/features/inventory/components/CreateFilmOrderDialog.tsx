import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Input';
import type { CreateFilmOrderPayload, Warehouse } from '../../../domain';
import { getManufacturerOptions, hasManufacturerOption } from '../utils/boxHelpers';
import { WarehouseToggle } from './WarehouseToggle';

const CUSTOM_MANUFACTURER_OPTION = '__custom_manufacturer__';

interface CreateFilmOrderDialogProps {
  open: boolean;
  submitting?: boolean;
  onCancel: () => void;
  onSubmit: (payload: CreateFilmOrderPayload) => void;
}

export function CreateFilmOrderDialog({
  open,
  submitting = false,
  onCancel,
  onSubmit
}: CreateFilmOrderDialogProps) {
  const manufacturerOptions = useMemo(() => getManufacturerOptions(), [open]);
  const [warehouse, setWarehouse] = useState<Warehouse>('IL');
  const [jobNumber, setJobNumber] = useState('');
  const [manufacturer, setManufacturer] = useState<string>(manufacturerOptions[0] || '');
  const [filmName, setFilmName] = useState('');
  const [widthIn, setWidthIn] = useState('36');
  const [requestedFeet, setRequestedFeet] = useState('100');
  const [error, setError] = useState('');
  const isKnownManufacturer = hasManufacturerOption(manufacturer, manufacturerOptions);
  const manufacturerSelectValue = isKnownManufacturer
    ? manufacturer
    : CUSTOM_MANUFACTURER_OPTION;
  const isCustomManufacturerSelected = manufacturerSelectValue === CUSTOM_MANUFACTURER_OPTION;

  useEffect(() => {
    if (open) {
      return;
    }

    setWarehouse('IL');
    setJobNumber('');
    setManufacturer(manufacturerOptions[0] || '');
    setFilmName('');
    setWidthIn('36');
    setRequestedFeet('100');
    setError('');
  }, [manufacturerOptions, open]);

  if (!open) {
    return null;
  }

  function handleSubmit() {
    const parsedWidth = Number(widthIn);
    const parsedRequestedFeet = Number(requestedFeet);

    if (!jobNumber.trim()) {
      setError('Job ID is required.');
      return;
    }

    if (!filmName.trim()) {
      setError('Film Name is required.');
      return;
    }

    if (!manufacturer.trim()) {
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
      manufacturer: manufacturer.trim(),
      filmName: filmName.trim(),
      widthIn: parsedWidth,
      requestedFeet: parsedRequestedFeet
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="create-film-order-title">
        <h2 id="create-film-order-title">Order Film</h2>
        <p className="muted-text">
          Save the film order first, then you will be sent to Add Box to create the incoming box records.
        </p>
        <div className="form-grid">
          <div className="field">
            <span className="field-label">Warehouse</span>
            <WarehouseToggle value={warehouse} onChange={setWarehouse} />
          </div>
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
          <Input
            label="Film Name"
            value={filmName}
            onChange={(event) => {
              setFilmName(event.target.value);
              setError('');
            }}
            required
          />
          <Input
            label="Width"
            type="number"
            min="0.01"
            step="0.01"
            value={widthIn}
            onChange={(event) => {
              setWidthIn(event.target.value);
              setError('');
            }}
            required
          />
          <Input
            label="Linear Feet"
            type="number"
            min="1"
            step="1"
            value={requestedFeet}
            onChange={(event) => {
              setRequestedFeet(event.target.value);
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
      </div>
    </div>
  );
}
