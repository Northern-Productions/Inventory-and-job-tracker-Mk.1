import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import { Input } from '../../../components/Input';
import { Select } from '../../../components/Select';
import type {
  CaulkManufacturerEntry,
  UpsertCaulkProductPayload,
  Warehouse,
  WarehouseEntry
} from '../../../domain';

interface NewCaulkProductDialogProps {
  open: boolean;
  pending: boolean;
  error: string;
  manufacturers: CaulkManufacturerEntry[];
  warehouseEntries: WarehouseEntry[];
  lockedWarehouse?: Warehouse | '';
  onClose: () => void;
  onClearError: () => void;
  onSubmit: (payload: UpsertCaulkProductPayload) => void;
}

export function NewCaulkProductDialog({
  open,
  pending,
  error,
  manufacturers,
  warehouseEntries,
  lockedWarehouse = '',
  onClose,
  onClearError,
  onSubmit
}: NewCaulkProductDialogProps) {
  const selectableManufacturers = useMemo(() => {
    const activeManufacturers = manufacturers.filter((entry) => entry.isActive);
    const source = activeManufacturers.length ? activeManufacturers : manufacturers;
    return [...source].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
  }, [manufacturers]);

  const defaultManufacturerId = selectableManufacturers[0]?.manufacturerId || '';
  const [manufacturerId, setManufacturerId] = useState(defaultManufacturerId);
  const [productName, setProductName] = useState('');
  const [productCode, setProductCode] = useState('');
  const [warehouse, setWarehouse] = useState<Warehouse | ''>(lockedWarehouse);
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    if (!open) {
      return;
    }

    setManufacturerId(defaultManufacturerId);
    setProductName('');
    setProductCode('');
    setWarehouse(lockedWarehouse);
    setLocalError('');
  }, [defaultManufacturerId, lockedWarehouse, open]);

  const warehouseOptions = useMemo(
    () =>
      warehouseEntries
        .map((entry) => ({
          value: entry.code,
          label: entry.name || entry.code
        }))
        .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })),
    [warehouseEntries]
  );

  const displayError = localError || error;
  const warehouseIsLocked = Boolean(lockedWarehouse);

  function clearErrors() {
    if (localError) {
      setLocalError('');
    }
    if (error) {
      onClearError();
    }
  }

  function handleSubmit() {
    const trimmedProductName = productName.trim();
    const trimmedProductCode = productCode.trim();

    if (!manufacturerId) {
      setLocalError('Select a manufacturer first.');
      return;
    }

    if (!trimmedProductName) {
      setLocalError('Product name is required.');
      return;
    }

    if (!warehouse) {
      setLocalError('Choose the warehouse where this product should appear.');
      return;
    }

    clearErrors();
    onSubmit({
      manufacturerId,
      productName: trimmedProductName,
      productCode: trimmedProductCode || undefined,
      warehouse,
      tubesPerCase: 16
    });
  }

  if (!open) {
    return null;
  }

  return (
    <DialogSurface
      open={open}
      onClose={pending ? undefined : onClose}
      className="dialog-new-caulk-product"
      backdropClassName="dialog-backdrop-centered"
      titleId="new-caulk-product-dialog-title"
    >
      <div className="dialog-header">
        <h2 id="new-caulk-product-dialog-title">New Caulk Product</h2>
        <button
          type="button"
          className="dialog-close"
          aria-label="Close new caulk product dialog"
          onClick={onClose}
          disabled={pending}
        >
          X
        </button>
      </div>

      <div className="form-grid">
        <Select
          label="Manufacturer"
          value={manufacturerId}
          onChange={(event) => {
            setManufacturerId(event.target.value);
            clearErrors();
          }}
          options={[
            { value: '', label: 'Select manufacturer' },
            ...selectableManufacturers.map((entry) => ({
              value: entry.manufacturerId,
              label: entry.name
            }))
          ]}
          disabled={pending}
        />

        <Input
          label="Product Name"
          value={productName}
          onChange={(event) => {
            setProductName(event.target.value);
            clearErrors();
          }}
          placeholder="3M IPA White"
          autoFocus
          disabled={pending}
        />

        <Input
          label="Product Code"
          value={productCode}
          onChange={(event) => {
            setProductCode(event.target.value);
            clearErrors();
          }}
          placeholder="Optional code"
          disabled={pending}
        />

        <Select
          label="Warehouse"
          value={warehouse}
          onChange={(event) => {
            setWarehouse(event.target.value as Warehouse | '');
            clearErrors();
          }}
          options={
            warehouseIsLocked
              ? warehouseOptions.filter((entry) => entry.value === lockedWarehouse)
              : [{ value: '', label: 'Select warehouse' }, ...warehouseOptions]
          }
          disabled={pending || warehouseIsLocked}
          hint={
            warehouseIsLocked
              ? 'This product will be created for the warehouse currently selected in the CAUC inventory filter.'
              : 'The product will be added at zero stock in the warehouse you choose.'
          }
        />
      </div>

      {displayError ? <p className="error-text">{displayError}</p> : null}

      <div className="dialog-actions dialog-actions-sticky-footer">
        <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={handleSubmit}
          loading={pending}
          loadingLabel="Saving..."
        >
          Create Product
        </Button>
      </div>
    </DialogSurface>
  );
}
