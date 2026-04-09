import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listCaulkStock } from '../../../../api/features/caulkClient';
import { Button } from '../../../../components/Button';
import { DialogSurface } from '../../../../components/DialogSurface';
import { Input } from '../../../../components/Input';
import type { CaulkJobAllocationEntry, CaulkProductEntry, JobCaulkRequirementLine, Warehouse } from '../../../../domain';
import {
  buildCaulkAllocationValuesForRequirement,
  sortCaulkStockEntriesForAllocation
} from '../../utils/caulkAllocationPlanning';
import { buildCaulkProductLabel } from '../../utils/caulkProductLabels';
import type { CaulkAllocationEditorState } from './types';

interface CaulkAllocationDialogProps {
  editor: CaulkAllocationEditorState | null;
  setEditor: Dispatch<SetStateAction<CaulkAllocationEditorState | null>>;
  error: string;
  setError: Dispatch<SetStateAction<string>>;
  pending: boolean;
  caulkRequirements: JobCaulkRequirementLine[];
  caulkAllocations: CaulkJobAllocationEntry[];
  caulkProducts: CaulkProductEntry[];
  warehouseOptions: Warehouse[];
  onSubmit: () => void;
}

export function CaulkAllocationDialog({
  editor,
  setEditor,
  error,
  setError,
  pending,
  caulkRequirements,
  caulkAllocations,
  caulkProducts,
  warehouseOptions,
  onSubmit
}: CaulkAllocationDialogProps) {
  const selectedRequirement = useMemo(() => {
    if (!editor?.requirementId) {
      return null;
    }

    return caulkRequirements.find((entry) => entry.requirementId === editor.requirementId) || null;
  }, [editor?.requirementId, caulkRequirements]);

  const selectedAllocationRow = useMemo(() => {
    if (!editor || editor.mode !== 'edit') {
      return null;
    }

    return caulkAllocations.find((entry) => entry.caulkAllocationId === editor.caulkAllocationId) || null;
  }, [editor, caulkAllocations]);

  const caulkProductLabelById = useMemo(
    () =>
      Object.fromEntries(
        caulkProducts.map((entry) => [
          entry.productId,
          buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)
        ])
      ) as Record<string, string>,
    [caulkProducts]
  );

  const selectedCaulkAllocationProductId = selectedRequirement?.productId || editor?.productId || '';
  const selectedCaulkAllocationProductLabel =
    (selectedCaulkAllocationProductId && caulkProductLabelById[selectedCaulkAllocationProductId]) ||
    (selectedRequirement
      ? buildCaulkProductLabel(
          selectedRequirement.manufacturer,
          selectedRequirement.productName,
          selectedRequirement.productCode
        )
      : selectedAllocationRow
        ? buildCaulkProductLabel(
            selectedAllocationRow.manufacturer,
            selectedAllocationRow.productName,
            selectedAllocationRow.productCode
          )
        : '');

  const caulkAllocationStockQuery = useQuery({
    queryKey: ['caulk', 'stock', 'allocation-dialog', selectedCaulkAllocationProductId],
    queryFn: () =>
      listCaulkStock({
        warehouse: 'ALL',
        productId: selectedCaulkAllocationProductId
      }),
    enabled: Boolean(editor && selectedCaulkAllocationProductId)
  });

  const caulkAllocationStockRows = useMemo(() => {
    const rows = caulkAllocationStockQuery.data || [];
    if (!selectedCaulkAllocationProductId) {
      return [];
    }

    return sortCaulkStockEntriesForAllocation(
      rows.filter((entry) => entry.productId === selectedCaulkAllocationProductId),
      editor?.warehouse || ''
    );
  }, [editor?.warehouse, caulkAllocationStockQuery.data, selectedCaulkAllocationProductId]);

  if (!editor) {
    return null;
  }

  function handleClose() {
    setEditor(null);
    setError('');
  }

  return (
    <DialogSurface
      open={Boolean(editor)}
      onClose={handleClose}
      className="dialog-caulk-allocation"
      backdropClassName="dialog-backdrop-centered"
      titleId="caulk-allocation-dialog-title"
    >
      <div className="dialog-header">
        <h2 id="caulk-allocation-dialog-title">
          {editor.mode === 'add' ? 'Add Caulk Allocation' : 'Edit Caulk Allocation'}
        </h2>
        <button
          type="button"
          className="dialog-close"
          aria-label="Close caulk allocation dialog"
          onClick={handleClose}
        >
          X
        </button>
      </div>
      <div className="form-grid">
        {editor.mode === 'add' ? (
          <label className="field">
            <span className="field-label">Job Requirement</span>
            <select
              className="field-input"
              value={editor.requirementId}
              onChange={(event) => {
                const nextRequirementId = event.target.value;
                const requirement = nextRequirementId
                  ? caulkRequirements.find((entry) => entry.requirementId === nextRequirementId) || null
                  : null;
                const nextValues = requirement ? buildCaulkAllocationValuesForRequirement(requirement) : null;
                setEditor((current) =>
                  current
                    ? {
                        ...current,
                        requirementId: nextRequirementId,
                        productId: nextValues?.productId || current.productId,
                        allocatedTubes: nextValues?.allocatedTubes || current.allocatedTubes
                      }
                    : current
                );
                setError('');
              }}
            >
              <option value="">Ad-hoc allocation (no requirement link)</option>
              {caulkRequirements.map((entry) => (
                <option key={entry.requirementId} value={entry.requirementId}>
                  {buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)} | Required{' '}
                  {entry.requiredTubes} | Remaining {entry.remainingTubes}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="field">
          <span className="field-label">Caulk Product</span>
          <select
            className="field-input"
            value={editor.productId}
            onChange={(event) => {
              const nextProductId = event.target.value;
              setEditor((current) => (current ? { ...current, productId: nextProductId } : current));
              setError('');
            }}
            disabled={editor.lockProductWarehouse || (editor.mode === 'add' && Boolean(editor.requirementId))}
          >
            {caulkProducts.map((entry) => (
              <option key={entry.productId} value={entry.productId}>
                {buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)}
              </option>
            ))}
            {editor.productId && !caulkProductLabelById[editor.productId] ? (
              <option value={editor.productId}>{editor.productId}</option>
            ) : null}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Warehouse</span>
          <select
            className="field-input"
            value={editor.warehouse}
            onChange={(event) => {
              const nextWarehouse = event.target.value as Warehouse;
              setEditor((current) => (current ? { ...current, warehouse: nextWarehouse } : current));
              setError('');
            }}
            disabled={editor.lockProductWarehouse}
          >
            {warehouseOptions.map((warehouseCode) => (
              <option key={warehouseCode} value={warehouseCode}>
                {warehouseCode}
              </option>
            ))}
          </select>
        </label>

        <Input
          label="Allocated Tubes"
          value={editor.allocatedTubes}
          inputMode="numeric"
          pattern="[0-9]*"
          onChange={(event) => {
            const value = event.target.value.replace(/[^0-9]/g, '');
            setEditor((current) => (current ? { ...current, allocatedTubes: value } : current));
            setError('');
          }}
          hint={editor.lockProductWarehouse ? `Minimum ${editor.minAllocatedTubes} after checkout starts.` : undefined}
        />
        {selectedCaulkAllocationProductId ? (
          <section className="caulk-allocation-stock-section" aria-label="Available Caulk Stock">
            <div className="caulk-allocation-stock-header">
              <div>
                <h3>Available Stock</h3>
                {selectedCaulkAllocationProductLabel ? (
                  <p className="muted-text">{selectedCaulkAllocationProductLabel}</p>
                ) : null}
              </div>
            </div>
            {caulkAllocationStockQuery.isLoading || caulkAllocationStockQuery.isFetching ? (
              <p className="muted-text">Loading available stock...</p>
            ) : caulkAllocationStockQuery.isError ? (
              <p className="error-text">
                {caulkAllocationStockQuery.error instanceof Error
                  ? caulkAllocationStockQuery.error.message
                  : 'Available stock failed to load.'}
              </p>
            ) : !caulkAllocationStockRows.length ? (
              <p className="muted-text">No available stock was found for this caulk product.</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Warehouse</th>
                      <th>Available Tubes</th>
                      <th>Full Cases</th>
                      <th>Loose Tubes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {caulkAllocationStockRows.map((entry) => {
                      const isSelectedWarehouse = entry.warehouse === editor.warehouse;

                      return (
                        <tr
                          key={`${entry.warehouse}:${entry.productId}`}
                          className={isSelectedWarehouse ? 'caulk-stock-row-selected' : undefined}
                        >
                          <td>{entry.warehouse}</td>
                          <td>{entry.tubesOnHand}</td>
                          <td>{entry.casesOnHand}</td>
                          <td>{entry.looseTubes}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ) : null}

        <label className="field caulk-allocation-notes-field">
          <span className="field-label">Notes</span>
          <textarea
            className="field-input field-textarea caulk-allocation-notes-input"
            value={editor.notes}
            rows={3}
            onChange={(event) => {
              const value = event.target.value;
              setEditor((current) => (current ? { ...current, notes: value } : current));
              setError('');
            }}
          />
        </label>
      </div>

      {editor.lockProductWarehouse ? (
        <p className="muted-text">
          Guardrail active: once checkout starts, product and warehouse are locked and allocated tubes can only increase.
        </p>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
      <div className="dialog-actions dialog-actions-sticky-footer">
        <Button type="button" variant="ghost" onClick={handleClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" variant="primary" onClick={onSubmit} disabled={pending}>
          {pending ? 'Saving...' : editor.mode === 'add' ? 'Add Allocation' : 'Save Allocation'}
        </Button>
      </div>
    </DialogSurface>
  );
}
