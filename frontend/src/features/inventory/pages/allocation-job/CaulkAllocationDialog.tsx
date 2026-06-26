import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listCaulkStock } from '../../../../api/features/caulkClient';
import { Button } from '../../../../components/Button';
import { DialogSurface } from '../../../../components/DialogSurface';
import { Input } from '../../../../components/Input';
import type { CaulkJobAllocationEntry, CaulkProductEntry, JobCaulkRequirementLine, Warehouse } from '../../../../domain';
import {
  buildCaulkAllocationValuesForRequirement,
  getCaulkAllocationTransferPlan,
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
  const activeCaulkRequirements = useMemo(
    () => caulkRequirements.filter((entry) => entry.status !== 'COMPLETE'),
    [caulkRequirements]
  );

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

  const transferPlan = useMemo(
    () =>
      getCaulkAllocationTransferPlan({
        mode: editor?.mode || 'add',
        productId: selectedCaulkAllocationProductId,
        warehouse: editor?.warehouse || '',
        allocatedTubesInput: editor?.allocatedTubes || '',
        stockEntries: caulkAllocationStockRows,
        existingAllocation: selectedAllocationRow
      }),
    [
      caulkAllocationStockRows,
      editor?.allocatedTubes,
      editor?.mode,
      editor?.warehouse,
      selectedAllocationRow,
      selectedCaulkAllocationProductId
    ]
  );

  const requiresTransferAssist = transferPlan.shortageTubes > 0;
  const dialogMode = editor?.mode || 'add';
  const targetStockRows = useMemo(
    () =>
      caulkAllocationStockRows.filter(
        (entry) => entry.productId === selectedCaulkAllocationProductId && entry.warehouse === editor?.warehouse
      ),
    [caulkAllocationStockRows, editor?.warehouse, selectedCaulkAllocationProductId]
  );
  const selectedTargetStock = targetStockRows.find(
    (entry) => entry.stockId && entry.stockId === editor?.stockId
  );
  const selectedTransferStockIsEligible = transferPlan.eligibleSourceStock.some(
    (entry) => entry.stockId && entry.stockId === editor?.sourceStockId
  );
  const saveLabel = requiresTransferAssist
    ? dialogMode === 'add'
      ? 'Transfer + Add Allocation'
      : 'Transfer + Save Allocation'
    : dialogMode === 'add'
      ? 'Add Allocation'
      : 'Save Allocation';
  const saveDisabled = pending || (requiresTransferAssist && !selectedTransferStockIsEligible);

  useEffect(() => {
    if (!editor || !selectedCaulkAllocationProductId) {
      return;
    }

    const currentTargetStillValid = targetStockRows.some((entry) => entry.stockId === editor.stockId);
    if (targetStockRows.length === 1 && !currentTargetStillValid) {
      const onlyRow = targetStockRows[0];
      setEditor((current) =>
        current
          ? {
              ...current,
              stockId: onlyRow.stockId,
              ownerCompanyId: onlyRow.ownerCompanyId
            }
          : current
      );
      return;
    }

    if (targetStockRows.length !== 1 && editor.stockId && !currentTargetStillValid) {
      setEditor((current) =>
        current
          ? {
              ...current,
              stockId: '',
              ownerCompanyId: ''
            }
          : current
      );
    }
  }, [editor, selectedCaulkAllocationProductId, setEditor, targetStockRows]);

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
                  ? activeCaulkRequirements.find((entry) => entry.requirementId === nextRequirementId) || null
                  : null;
                const nextValues = requirement ? buildCaulkAllocationValuesForRequirement(requirement) : null;
                setEditor((current) =>
                  current
                    ? {
                        ...current,
                        requirementId: nextRequirementId,
                        productId: nextValues?.productId || current.productId,
                        stockId: '',
                        ownerCompanyId: '',
                        sourceStockId: '',
                        sourceOwnerCompanyId: '',
                        transferFromWarehouse: '',
                        allocatedTubes: nextValues?.allocatedTubes || current.allocatedTubes
                      }
                    : current
                );
                setError('');
              }}
            >
              <option value="">Ad-hoc allocation (no requirement link)</option>
              {activeCaulkRequirements.map((entry) => (
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
              setEditor((current) =>
                current
                  ? {
                      ...current,
                      productId: nextProductId,
                      stockId: '',
                      ownerCompanyId: '',
                      sourceStockId: '',
                      sourceOwnerCompanyId: '',
                      transferFromWarehouse: ''
                    }
                  : current
              );
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
              setEditor((current) =>
                current
                  ? {
                      ...current,
                      warehouse: nextWarehouse,
                      stockId: '',
                      ownerCompanyId: '',
                      sourceStockId: '',
                      sourceOwnerCompanyId: '',
                      transferFromWarehouse: ''
                    }
                  : current
              );
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
            setEditor((current) =>
              current
                ? {
                    ...current,
                    allocatedTubes: value,
                    sourceStockId: '',
                    sourceOwnerCompanyId: '',
                    transferFromWarehouse: ''
                  }
                : current
            );
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
            {requiresTransferAssist ? (
              <div className="caulk-allocation-shortage-card">
                <p className="caulk-allocation-shortage-copy">
                  {editor.warehouse} is short {transferPlan.shortageTubes} tube
                  {transferPlan.shortageTubes === 1 ? '' : 's'} for this allocation.
                </p>
                {transferPlan.eligibleSourceStock.length ? (
                  <label className="field caulk-allocation-transfer-field">
                    <span className="field-label">Transfer From Owner Row</span>
                    <select
                      className="field-input"
                      value={editor.sourceStockId}
                      onChange={(event) => {
                        const nextStockId = event.target.value;
                        const sourceRow =
                          transferPlan.eligibleSourceStock.find((entry) => entry.stockId === nextStockId) || null;
                        setEditor((current) =>
                          current
                            ? {
                                ...current,
                                sourceStockId: sourceRow?.stockId || '',
                                sourceOwnerCompanyId: sourceRow?.ownerCompanyId || '',
                                transferFromWarehouse: sourceRow?.warehouse || ''
                              }
                            : current
                        );
                        setError('');
                      }}
                    >
                      <option value="">Select source row</option>
                      {transferPlan.eligibleSourceStock.map((entry) => (
                        <option key={entry.stockId || `${entry.warehouse}:${entry.ownerCompanyId}`} value={entry.stockId}>
                          {entry.warehouse} / {entry.ownerCompanyCode || 'Owner'} ({entry.tubesOnHand} tubes available)
                        </option>
                      ))}
                    </select>
                    <span className="field-hint">
                      The shortage will start a pending transfer now. Receive it at {editor.warehouse} before
                      checkout or staging.
                    </span>
                  </label>
                ) : (
                  <p className="error-text">
                    No single warehouse currently has enough stock to cover this shortage.
                  </p>
                )}
              </div>
            ) : null}
            {targetStockRows.length > 1 ? (
              <label className="field">
                <span className="field-label">Use Owner Row</span>
                <select
                  className="field-input"
                  value={editor.stockId}
                  onChange={(event) => {
                    const nextStockId = event.target.value;
                    const targetRow = targetStockRows.find((entry) => entry.stockId === nextStockId) || null;
                    setEditor((current) =>
                      current
                        ? {
                            ...current,
                            stockId: targetRow?.stockId || '',
                            ownerCompanyId: targetRow?.ownerCompanyId || ''
                          }
                        : current
                    );
                    setError('');
                  }}
                >
                  <option value="">Select owner row</option>
                  {targetStockRows.map((entry) => (
                    <option key={entry.stockId || entry.ownerCompanyId} value={entry.stockId}>
                      {entry.ownerCompanyCode || 'Owner'} ({entry.tubesOnHand} tubes available)
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  Multiple owner rows exist in {editor.warehouse}; choose the exact row this mutation should reserve from.
                </span>
              </label>
            ) : selectedTargetStock ? (
              <p className="muted-text">
                Reserving from {selectedTargetStock.ownerCompanyCode || 'owner row'} in {editor.warehouse}.
              </p>
            ) : null}
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
                      <th>Owner</th>
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
                          key={entry.stockId || `${entry.warehouse}:${entry.productId}:${entry.ownerCompanyId}`}
                          className={isSelectedWarehouse ? 'caulk-stock-row-selected' : undefined}
                        >
                          <td>{entry.warehouse}</td>
                          <td>{entry.ownerCompanyCode || '--'}</td>
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
        <Button type="button" variant="primary" onClick={onSubmit} disabled={saveDisabled}>
          {pending ? 'Saving...' : saveLabel}
        </Button>
      </div>
    </DialogSurface>
  );
}
