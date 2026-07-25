import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { addWarehouse } from '../../../api/features/warehouseClient';
import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import { Input } from '../../../components/Input';
import { Select } from '../../../components/Select';
import type { Warehouse } from '../../../domain';
import { useAuth } from '../../auth/AuthContext';
import { useWarehouseRegistry, warehouseRegistryQueryKey } from '../hooks/useWarehouseRegistry';
import {
  ADD_WAREHOUSE_OPTION_VALUE,
  ALL_WAREHOUSES_OPTION_VALUE,
  buildWarehouseCreateDraft,
  getSafeSpecificWarehouseValue,
  isWarehouseInRegistry,
  isValidWarehouseStateCode,
  normalizeWarehouseCity,
  normalizeWarehouseCode,
  normalizeWarehouseStateCode,
  toWarehouseFilterOptionValue,
  toWarehouseFilterSelectOptions,
  toWarehouseSelectOptions
} from '../utils/warehouseOptions';

interface WarehouseSelectFieldProps {
  label?: string;
  value: Warehouse | '';
  onChange: (value: Warehouse | '') => void;
  allowAll?: boolean;
  disabled?: boolean;
  includeAddOption?: boolean;
}

export function WarehouseSelectField({
  label = 'Warehouse',
  value,
  onChange,
  allowAll = false,
  disabled = false,
  includeAddOption = true
}: WarehouseSelectFieldProps) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const warehouseRegistry = useWarehouseRegistry();
  const warehouseRegistrySettled =
    warehouseRegistry.scopeReady === true && warehouseRegistry.isSuccess;
  const canAddWarehouse = auth.isOwner && includeAddOption;
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [cityDraft, setCityDraft] = useState('');
  const [stateDraft, setStateDraft] = useState('');
  const [formError, setFormError] = useState('');
  const normalizedValue = normalizeWarehouseCode(value);
  const safeSpecificValue =
    getSafeSpecificWarehouseValue(warehouseRegistry.entries, normalizedValue) ||
    (!warehouseRegistrySettled ? normalizedValue : '');
  const selectValue = allowAll ? toWarehouseFilterOptionValue(safeSpecificValue) : safeSpecificValue;
  const hasConfiguredWarehouses = warehouseRegistry.entries.length > 0;
  const emptyWarehouseHint = !warehouseRegistrySettled || hasConfiguredWarehouses
    ? undefined
    : canAddWarehouse
      ? 'No warehouses are configured for this organization yet. Add a warehouse to continue.'
      : 'No warehouses are configured for this organization yet.';
  const addWarehouseMutation = useMutation({
    mutationFn: addWarehouse
  });

  const options = useMemo(() => {
    const base = allowAll
      ? toWarehouseFilterSelectOptions(warehouseRegistry.entries)
      : toWarehouseSelectOptions(warehouseRegistry.entries);
    if (
      safeSpecificValue &&
      !isWarehouseInRegistry(warehouseRegistry.entries, safeSpecificValue)
    ) {
      base.push({ label: safeSpecificValue, value: safeSpecificValue });
    }
    if (!allowAll && base.length === 0) {
      base.push({ label: 'No warehouses configured', value: '' });
    }

    if (canAddWarehouse) {
      base.push({ label: 'Add New Warehouse...', value: ADD_WAREHOUSE_OPTION_VALUE });
    }

    return base;
  }, [
    allowAll,
    canAddWarehouse,
    safeSpecificValue,
    warehouseRegistry.entries
  ]);

  const generatedWarehouse = useMemo(
    () => buildWarehouseCreateDraft(warehouseRegistry.entries, cityDraft, stateDraft),
    [cityDraft, stateDraft, warehouseRegistry.entries]
  );

  function closeAddDialog() {
    setIsAddDialogOpen(false);
    setFormError('');
    setCityDraft('');
    setStateDraft('');
  }

  async function handleCreateWarehouse() {
    const normalizedCity = normalizeWarehouseCity(cityDraft);
    const normalizedState = normalizeWarehouseStateCode(stateDraft);

    if (!normalizedCity) {
      setFormError('City is required.');
      return;
    }
    if (!isValidWarehouseStateCode(normalizedState)) {
      setFormError('State must be a valid two-letter abbreviation, such as MI.');
      return;
    }
    if (!generatedWarehouse.code || !generatedWarehouse.name) {
      setFormError('Unable to generate a warehouse code for this state.');
      return;
    }

    try {
      const created = await addWarehouseMutation.mutateAsync({
        code: generatedWarehouse.code,
        name: generatedWarehouse.name,
        boxIdPrefix: generatedWarehouse.boxIdPrefix
      });
      await queryClient.invalidateQueries({ queryKey: warehouseRegistryQueryKey });
      onChange(created.code);
      closeAddDialog();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to add warehouse.');
    }
  }

  return (
    <>
      <Select
        label={label}
        value={selectValue}
        disabled={disabled}
        hint={emptyWarehouseHint}
        onChange={(event) => {
          const nextValue = event.target.value;
          if (nextValue === ADD_WAREHOUSE_OPTION_VALUE && canAddWarehouse) {
            setIsAddDialogOpen(true);
            return;
          }

          if (allowAll && nextValue === ALL_WAREHOUSES_OPTION_VALUE) {
            onChange('');
            return;
          }

          const normalized = normalizeWarehouseCode(nextValue);
          if (!normalized || !isWarehouseInRegistry(warehouseRegistry.entries, normalized)) {
            return;
          }

          onChange(normalized);
        }}
        options={options}
      />

      <DialogSurface
        open={isAddDialogOpen}
        onClose={closeAddDialog}
        titleId="add-warehouse-title"
        closeOnBackdrop
      >
        <div className="dialog-header">
          <h2 id="add-warehouse-title">Add Warehouse</h2>
          <button
            type="button"
            className="dialog-close"
            aria-label="Close add warehouse dialog"
            onClick={closeAddDialog}
          >
            X
          </button>
        </div>
        <div className="form-grid">
          <Input
            label="City"
            value={cityDraft}
            onChange={(event) => {
              setCityDraft(event.target.value);
              setFormError('');
            }}
            placeholder="Auburn Hills"
            maxLength={80}
            autoFocus
          />
          <Input
            label="State"
            value={stateDraft}
            onChange={(event) => {
              setStateDraft(event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2));
              setFormError('');
            }}
            placeholder="MI"
            maxLength={2}
          />
        </div>
        <p className="field-hint">
          Enter the city name, for example Auburn Hills. Enter the two-letter state abbreviation,
          for example MI. The app will create the next warehouse code automatically, such as MI1 or MI2.
        </p>
        {generatedWarehouse.label ? (
          <p className="field-hint">This will create: {generatedWarehouse.label}</p>
        ) : null}
        {formError ? <p className="error-text">{formError}</p> : null}
        <div className="dialog-actions">
          <Button type="button" variant="ghost" onClick={closeAddDialog}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleCreateWarehouse()}
            disabled={addWarehouseMutation.isPending}
          >
            {addWarehouseMutation.isPending ? 'Saving...' : 'Add Warehouse'}
          </Button>
        </div>
      </DialogSurface>
    </>
  );
}
