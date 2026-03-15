import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { addWarehouse } from '../../../api/client';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Input';
import { Select } from '../../../components/Select';
import type { Warehouse } from '../../../domain';
import { useAuth } from '../../auth/AuthContext';
import { useWarehouseRegistry, warehouseRegistryQueryKey } from '../hooks/useWarehouseRegistry';
import {
  ADD_WAREHOUSE_OPTION_VALUE,
  ALL_WAREHOUSES_OPTION_VALUE,
  normalizeWarehouseCode,
  toWarehouseFilterOptionValue,
  toWarehouseFilterSelectOptions,
  toWarehouseSelectOptions
} from '../utils/warehouseOptions';

const INDEXED_WAREHOUSE_PATTERN = /^[A-Z]{2}[1-9][0-9]{0,6}$/;

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
  const canAddWarehouse = auth.isOwner && includeAddOption;
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [codeDraft, setCodeDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [prefixDraft, setPrefixDraft] = useState('');
  const [formError, setFormError] = useState('');
  const selectValue = allowAll ? toWarehouseFilterOptionValue(value) : value;
  const addWarehouseMutation = useMutation({
    mutationFn: addWarehouse
  });

  const options = useMemo(() => {
    const base = allowAll
      ? toWarehouseFilterSelectOptions(warehouseRegistry.entries)
      : toWarehouseSelectOptions(warehouseRegistry.entries);
    const hasSelectedValue =
      !selectValue ||
      selectValue === ALL_WAREHOUSES_OPTION_VALUE ||
      base.some((option) => option.value === selectValue);

    if (!hasSelectedValue) {
      const fallback = normalizeWarehouseCode(selectValue);
      if (fallback) {
        base.push({ label: fallback, value: fallback });
      }
    }

    if (canAddWarehouse) {
      base.push({ label: 'Add New Warehouse...', value: ADD_WAREHOUSE_OPTION_VALUE });
    }

    return base;
  }, [allowAll, canAddWarehouse, selectValue, warehouseRegistry.entries]);

  const suggestedName = useMemo(() => {
    const normalized = normalizeWarehouseCode(codeDraft);
    if (!normalized) {
      return '';
    }

    const existing = warehouseRegistry.entries.find((entry) => entry.code === normalized);
    return existing?.name || normalized;
  }, [codeDraft, warehouseRegistry.entries]);

  function closeAddDialog() {
    setIsAddDialogOpen(false);
    setFormError('');
    setCodeDraft('');
    setNameDraft('');
    setPrefixDraft('');
  }

  async function handleCreateWarehouse() {
    const normalizedCode = normalizeWarehouseCode(codeDraft);
    const normalizedPrefix = String(prefixDraft || normalizedCode).trim().toUpperCase();
    const resolvedName = String(nameDraft || '').trim() || suggestedName;

    if (!normalizedCode) {
      setFormError('Warehouse code must match AA1, AA2, ... with a 1-based index.');
      return;
    }
    if (!resolvedName) {
      setFormError('Warehouse name is required.');
      return;
    }
    if (!INDEXED_WAREHOUSE_PATTERN.test(normalizedPrefix)) {
      setFormError('BoxID prefix must match AA1, AA2, ... with a 1-based index.');
      return;
    }
    if (normalizedPrefix !== normalizedCode) {
      setFormError('Warehouse code and BoxID prefix must match.');
      return;
    }

    try {
      const created = await addWarehouseMutation.mutateAsync({
        code: normalizedCode,
        name: resolvedName,
        boxIdPrefix: normalizedPrefix
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
          if (!normalized) {
            return;
          }

          onChange(normalized);
        }}
        options={options}
      />

      {isAddDialogOpen ? (
        <div className="dialog-backdrop" role="presentation" onClick={closeAddDialog}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-warehouse-title"
            onClick={(event) => event.stopPropagation()}
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
                label="Warehouse Code"
                value={codeDraft}
                onChange={(event) => {
                  const nextCode = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
                  setCodeDraft(nextCode);
                  if (!prefixDraft || prefixDraft === codeDraft) {
                    setPrefixDraft(nextCode);
                  }
                  setFormError('');
                }}
                placeholder="CA1"
                maxLength={8}
                autoFocus
              />
              <Input
                label="Display Name"
                value={nameDraft}
                onChange={(event) => {
                  setNameDraft(event.target.value);
                  setFormError('');
                }}
                placeholder={suggestedName || 'Texas'}
                maxLength={80}
              />
              <Input
                label="BoxID Prefix"
                value={prefixDraft}
                onChange={(event) => {
                  setPrefixDraft(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
                  setFormError('');
                }}
                placeholder="CA1"
                maxLength={8}
              />
            </div>
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
          </div>
        </div>
      ) : null}
    </>
  );
}
