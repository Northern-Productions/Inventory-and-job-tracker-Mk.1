import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { Input, TextArea } from '../../../components/Input';
import { Select } from '../../../components/Select';
import { useToast } from '../../../components/Toast';
import {
  cancelCaulkTransfer,
  listCaulkStock,
  listPendingCaulkTransfers,
  listCaulkTransactions,
  mutateCaulkStock,
  receiveCaulkTransfer
} from '../../../api/features/caulkClient';
import { formatOwnerCompanyLabel, type Warehouse } from '../../../domain';
import { useAuth } from '../../auth/AuthContext';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';
import { formatMutationWarningDescription } from '../../../lib/mutationWarnings';
import {
  usePendingCancelCaulkTransferIds,
  useChangeCaulkStockOwner,
  useOwnerCompanies,
  usePendingReceiveCaulkTransferIds
} from '../../inventory/hooks/useInventoryQueries';
import { useWarehouseRegistry } from '../../inventory/hooks/useWarehouseRegistry';
import { formatWarehouseDisplayLabel } from '../../inventory/utils/warehouseOptions';
import {
  normalizeWholeNumberInput,
  toFullCasesFromTubes,
  toLooseTubesFromTubes,
  toTubesFromCasesAndLoose
} from '../utils/stockMath';

function formatDateLabel(value: string) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    return '--';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(parsed);
}

function formatCaulkJobLabel(job: {
  jobNumber?: string | null;
  jobWarehouse?: string | null;
  workScope?: string | null;
  sections?: string | null;
}) {
  if (!String(job.jobNumber || '').trim()) {
    return '';
  }

  return formatJobDisplayLabel({
    jobNumber: job.jobNumber,
    warehouse: job.jobWarehouse,
    workScope: job.workScope,
    sections: job.sections
  });
}

export default function CaulkStockDetailsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const auth = useAuth();
  const warehouseRegistry = useWarehouseRegistry();
  const { warehouse: rawWarehouse = '', productId: rawProductId = '', stockId: rawStockId = '' } = useParams();
  const routeStockId = String(rawStockId || '').trim();
  const routeWarehouse = String(rawWarehouse || '').trim() as Warehouse;
  const routeProductId = String(rawProductId || '').trim();
  const [casesInput, setCasesInput] = useState('');
  const [looseTubesInput, setLooseTubesInput] = useState('');
  const [notes, setNotes] = useState('');
  const [ownerCompanyId, setOwnerCompanyId] = useState('');
  const [ownershipNote, setOwnershipNote] = useState('');
  const [formError, setFormError] = useState('');
  const pendingReceiveCaulkTransferIds = usePendingReceiveCaulkTransferIds();
  const pendingCancelCaulkTransferIds = usePendingCancelCaulkTransferIds();
  const ownerCompaniesQuery = useOwnerCompanies({ enabled: auth.isAuthenticated, includeInactive: true });
  const changeOwnerMutation = useChangeCaulkStockOwner();

  const stockQuery = useQuery({
    queryKey: ['caulk', 'stock', 'detail', { stockId: routeStockId, warehouse: routeWarehouse, productId: routeProductId }],
    queryFn: () =>
      routeStockId
        ? listCaulkStock({ stockId: routeStockId })
        : listCaulkStock({ warehouse: routeWarehouse, productId: routeProductId }),
    enabled: Boolean(routeStockId || (routeWarehouse && routeProductId))
  });
  const stockEntry = (stockQuery.data || [])[0] || null;
  const warehouse = stockEntry?.warehouse || routeWarehouse;
  const productId = stockEntry?.productId || routeProductId;
  const transactionsQuery = useQuery({
    queryKey: ['caulk', 'transactions', warehouse, productId, stockEntry?.ownerCompanyId || '', 50],
    queryFn: () =>
      listCaulkTransactions({
        warehouse,
        productId,
        ownerCompanyId: stockEntry?.ownerCompanyId,
        limit: 50
      }),
    enabled: Boolean(stockEntry?.warehouse && stockEntry?.productId)
  });
  const pendingTransfersQuery = useQuery({
    queryKey: ['caulk', 'transfers', { warehouse, productId }],
    queryFn: () => listPendingCaulkTransfers({ warehouse, productId }),
    enabled: Boolean(stockEntry?.warehouse && stockEntry?.productId)
  });
  const tubesPerCase = stockEntry?.tubesPerCase || 16;
  const warehouseEntry = warehouseRegistry.entries.find((entry) => entry.code === warehouse);
  const warehouseLabel = warehouseEntry ? formatWarehouseDisplayLabel(warehouseEntry) : warehouse;
  const canEdit = auth.hasFeatureAccess('inventory', 'write');
  const canChangeOwner = auth.isOwner;
  const stockOwnerLabel = formatOwnerCompanyLabel({
    code: stockEntry?.ownerCompanyCode,
    displayName: stockEntry?.ownerCompanyDisplayName
  });

  useEffect(() => {
    if (!stockEntry) {
      return;
    }

    setCasesInput(String(toFullCasesFromTubes(stockEntry.tubesOnHand, stockEntry.tubesPerCase)));
    setLooseTubesInput(String(toLooseTubesFromTubes(stockEntry.tubesOnHand, stockEntry.tubesPerCase)));
    setOwnerCompanyId(stockEntry.ownerCompanyId || '');
    setOwnershipNote('');
  }, [stockEntry?.ownerCompanyId, stockEntry?.productId, stockEntry?.stockId, stockEntry?.tubesOnHand, stockEntry?.tubesPerCase, stockEntry?.warehouse]);

  const desiredTotalResult = useMemo(() => {
    const normalizedCases = normalizeWholeNumberInput(casesInput);
    if (normalizedCases.error) {
      return { desiredTotal: 0, error: normalizedCases.error };
    }

    const normalizedLooseTubes = normalizeWholeNumberInput(looseTubesInput);
    if (normalizedLooseTubes.error) {
      return { desiredTotal: 0, error: normalizedLooseTubes.error };
    }

    if (normalizedLooseTubes.value >= tubesPerCase) {
      return {
        desiredTotal: 0,
        error: `Loose tubes must be less than ${tubesPerCase} for this product.`
      };
    }

    return {
      desiredTotal: toTubesFromCasesAndLoose(
        normalizedCases.value,
        normalizedLooseTubes.value,
        tubesPerCase
      ),
      error: ''
    };
  }, [casesInput, looseTubesInput, tubesPerCase]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!stockEntry) {
        throw new Error('Caulk stock details are not available yet.');
      }

      if (desiredTotalResult.error) {
        throw new Error(desiredTotalResult.error);
      }

      const deltaTubes = desiredTotalResult.desiredTotal - stockEntry.tubesOnHand;
      if (deltaTubes === 0) {
        return null;
      }

      const adjustmentNotes = notes.trim();
      return mutateCaulkStock({
        action: 'ADJUST',
        stockId: stockEntry.stockId,
        productId: stockEntry.productId,
        warehouse: stockEntry.warehouse,
        ownerCompanyId: stockEntry.ownerCompanyId,
        deltaTubes,
        reason: adjustmentNotes || 'Inventory edit',
        notes: adjustmentNotes
      });
    },
    onSuccess: async (result) => {
      if (!stockEntry) {
        return;
      }

      if (!result) {
        toast.push({
          title: 'No changes to save',
          description: 'The caulk counts already match the values you entered.',
          variant: 'warning'
        });
        return;
      }

      setNotes('');
      setFormError('');
      setCasesInput(String(toFullCasesFromTubes(result.tubesOnHand, result.tubesPerCase)));
      setLooseTubesInput(String(toLooseTubesFromTubes(result.tubesOnHand, result.tubesPerCase)));

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['caulk', 'stock'] }),
        queryClient.invalidateQueries({ queryKey: ['caulk', 'transactions', stockEntry.warehouse, stockEntry.productId] })
      ]);

      toast.push({
        title: 'Caulk inventory updated',
        description: `${result.productName} now has ${result.tubesOnHand} tubes available in ${result.warehouse}.`,
        variant: 'success'
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'The caulk inventory could not be updated.';
      setFormError(message);
      toast.push({
        title: 'Unable to save caulk inventory',
        description: message,
        variant: 'error'
      });
    }
  });

  const receiveTransferMutation = useMutation({
    mutationFn: (transferId: string) => receiveCaulkTransfer({ transferId }),
    onSuccess: async ({ result, warnings }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['caulk', 'stock'] }),
        queryClient.invalidateQueries({ queryKey: ['caulk', 'transactions'] }),
        queryClient.invalidateQueries({ queryKey: ['caulk', 'transfers'] }),
        queryClient.invalidateQueries({ queryKey: ['inventory', 'job'] }),
        queryClient.invalidateQueries({ queryKey: ['inventory', 'allocation-job'] })
      ]);
      toast.push({
        title: `Received transfer ${result.transferId}`,
        description: formatMutationWarningDescription(
          warnings,
          'The transferred caulk is now available in this warehouse.',
          'receive-caulk-transfer'
        ),
        variant: 'success'
      });
    },
    onError: (error) => {
      toast.push({
        title: 'Unable to receive caulk transfer',
        description: error instanceof Error ? error.message : 'The transfer could not be received.',
        variant: 'error'
      });
    }
  });

  const cancelTransferMutation = useMutation({
    mutationFn: (transferId: string) => cancelCaulkTransfer({ transferId }),
    onSuccess: async ({ result, warnings }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['caulk', 'stock'] }),
        queryClient.invalidateQueries({ queryKey: ['caulk', 'transactions'] }),
        queryClient.invalidateQueries({ queryKey: ['caulk', 'transfers'] }),
        queryClient.invalidateQueries({ queryKey: ['inventory', 'job'] }),
        queryClient.invalidateQueries({ queryKey: ['inventory', 'allocation-job'] })
      ]);
      toast.push({
        title: `Cancelled transfer ${result.transferId}`,
        description: formatMutationWarningDescription(
          warnings,
          'The pending caulk transfer was cancelled.',
          'cancel-caulk-transfer'
        ),
        variant: 'success'
      });
    },
    onError: (error) => {
      toast.push({
        title: 'Unable to cancel caulk transfer',
        description: error instanceof Error ? error.message : 'The transfer could not be cancelled.',
        variant: 'error'
      });
    }
  });

  function handleSave() {
    setFormError('');
    void saveMutation.mutateAsync();
  }

  async function handleOwnerChange() {
    if (!stockEntry) {
      return;
    }

    if (!ownerCompanyId || ownerCompanyId === stockEntry.ownerCompanyId) {
      toast.push({
        title: 'No ownership change',
        description: 'Choose a different owner company before saving ownership.',
        variant: 'warning'
      });
      return;
    }
    const stockId = String(stockEntry.stockId || '').trim();
    if (!stockId) {
      toast.push({
        title: 'Unable to update caulk owner',
        description: 'This caulk row is missing its stock identifier. Refresh and try again.',
        variant: 'error'
      });
      return;
    }

    try {
      const nextOwnerCompanyId = ownerCompanyId;
      const sourceWarehouse = String(stockEntry.warehouse || '').trim() as Warehouse;
      const sourceProductId = stockEntry.productId;
      await changeOwnerMutation.mutateAsync({
        stockId,
        ownerCompanyId: nextOwnerCompanyId,
        note: ownershipNote.trim() || undefined
      });
      setOwnershipNote('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['caulk', 'stock'] }),
        queryClient.invalidateQueries({ queryKey: ['caulk', 'transactions'] })
      ]);
      const refreshedRows =
        sourceWarehouse && sourceProductId
          ? await listCaulkStock({ warehouse: sourceWarehouse, productId: sourceProductId })
          : [];
      const nextStockRow = refreshedRows.find((entry) => entry.ownerCompanyId === nextOwnerCompanyId);
      if (nextStockRow?.stockId && nextStockRow.stockId !== stockId) {
        navigate(`/caulk/stock/${encodeURIComponent(nextStockRow.stockId)}`, { replace: true });
      }
      toast.push({
        title: 'Caulk owner updated',
        description: `${stockEntry.productName} ownership was updated without changing stock counts.`,
        variant: 'success'
      });
    } catch (error) {
      toast.push({
        title: 'Unable to update caulk owner',
        description: error instanceof Error ? error.message : 'The caulk owner could not be updated.',
        variant: 'error'
      });
    }
  }

  function handleReceiveTransfer(transferId: string) {
    void receiveTransferMutation.mutateAsync(transferId);
  }

  function handleCancelTransfer(transferId: string) {
    void cancelTransferMutation.mutateAsync(transferId);
  }

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <span className="eyebrow">Consumables</span>
            <h2>Caulk Details</h2>
            <p className="muted-text">
              Review and edit the caulk inventory counts for this warehouse and product.
            </p>
          </div>
          <div className="detail-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={() => navigate(`/?inventoryView=caulk&warehouse=${encodeURIComponent(warehouse || routeWarehouse)}`)}
            >
              Back
            </Button>
          </div>
        </div>

        {!routeStockId && (!routeWarehouse || !routeProductId) ? (
          <p className="error-text">The caulk detail route is missing a warehouse or product identifier.</p>
        ) : null}
        {stockQuery.isError ? (
          <p className="error-text">
            {stockQuery.error instanceof Error ? stockQuery.error.message : 'Caulk stock details failed to load.'}
          </p>
        ) : null}
        <DeferredLoadingState
          when={stockQuery.isLoading && !stockEntry}
          label="Loading caulk stock details..."
        />

        {stockEntry ? (
          <>
            <div className="panel-title-row">
              <div>
                <h2>Inbound Transfers</h2>
                <p className="muted-text">
                  Receive incoming caulk for this warehouse and product before it can be checked out on a
                  job.
                </p>
              </div>
              <span className="muted-text">{(pendingTransfersQuery.data || []).length} pending</span>
            </div>
            {pendingTransfersQuery.isError ? (
              <p className="error-text">
                {pendingTransfersQuery.error instanceof Error
                  ? pendingTransfersQuery.error.message
                  : 'Pending caulk transfers failed to load.'}
              </p>
            ) : null}
            <DeferredLoadingState
              when={pendingTransfersQuery.isLoading && !pendingTransfersQuery.data}
              label="Loading inbound caulk transfers..."
            />
            {(pendingTransfersQuery.data || []).length ? (
              <div className="job-transfer-alert-list">
                {(pendingTransfersQuery.data || []).map((transfer) => {
                  const transferPending =
                    pendingReceiveCaulkTransferIds.has(transfer.transferId.toUpperCase()) ||
                    pendingCancelCaulkTransferIds.has(transfer.transferId.toUpperCase());
                  const transferJobLabel = formatCaulkJobLabel(transfer);

                  return (
                    <div key={transfer.transferId} className="job-transfer-alert-row">
                      <div className="job-transfer-alert-copy">
                        <strong>Job {transferJobLabel || '--'}</strong>
                        <p className="muted-text">
                          {transfer.sourceWarehouse} to {transfer.destinationWarehouse} | {transfer.pendingTubes}{' '}
                          tube{transfer.pendingTubes === 1 ? '' : 's'}
                        </p>
                        <p className="job-transfer-alert-meta">
                          Started {formatDateLabel(transfer.createdAt)}
                          {transfer.createdBy ? ` by ${transfer.createdBy}` : ''}
                        </p>
                      </div>
                      <div className="detail-actions">
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() => handleReceiveTransfer(transfer.transferId)}
                          disabled={!canEdit || transferPending}
                        >
                          Receive
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => handleCancelTransfer(transfer.transferId)}
                          disabled={!canEdit || transferPending}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state">No inbound caulk transfers are waiting on this warehouse.</div>
            )}

            <div className="stat-grid allocation-stat-grid">
              <div className="key-value">
                <dt>Warehouse</dt>
                <dd>{warehouseLabel}</dd>
              </div>
              <div className="key-value">
                <dt>Manufacturer</dt>
                <dd>{stockEntry.manufacturer}</dd>
              </div>
              <div className="key-value">
                <dt>Product</dt>
                <dd>{stockEntry.productName}</dd>
              </div>
              <div className="key-value">
                <dt>Product Code</dt>
                <dd>{stockEntry.productCode || '--'}</dd>
              </div>
              <div className="key-value">
                <dt>Owner</dt>
                <dd>
                  <span className="badge badge-muted" title="Owner company">
                    {stockOwnerLabel || '--'}
                  </span>
                  {stockEntry.ownerCompanyIsActive === false ? (
                    <span className="muted-text"> inactive</span>
                  ) : null}
                </dd>
              </div>
              <div className="key-value">
                <dt>Tubes / Case</dt>
                <dd>{stockEntry.tubesPerCase}</dd>
              </div>
              <div className="key-value">
                <dt>Tubes Available</dt>
                <dd>{stockEntry.tubesOnHand}</dd>
              </div>
              <div className="key-value">
                <dt>Full Cases</dt>
                <dd>{toFullCasesFromTubes(stockEntry.tubesOnHand, stockEntry.tubesPerCase)}</dd>
              </div>
              <div className="key-value">
                <dt>Loose Tubes</dt>
                <dd>{toLooseTubesFromTubes(stockEntry.tubesOnHand, stockEntry.tubesPerCase)}</dd>
              </div>
              <div className="key-value">
                <dt>Updated</dt>
                <dd>{formatDateLabel(stockEntry.updatedAt)}</dd>
              </div>
              <div className="key-value">
                <dt>Updated By</dt>
                <dd>{stockEntry.updatedBy || '--'}</dd>
              </div>
            </div>

            <div className="panel-title-row">
              <div>
                <h2>Ownership</h2>
                <p className="muted-text">
                  Ownership is accounting-only and does not change warehouse, counts, or allocation state.
                </p>
              </div>
            </div>
            <div className="form-grid">
              <Select
                label="Owner Company"
                value={ownerCompanyId}
                onChange={(event) => setOwnerCompanyId(event.target.value)}
                options={[
                  { value: '', label: 'Select owner company' },
                  ...(ownerCompaniesQuery.data || [])
                    .filter((entry) => entry.isActive || entry.ownerCompanyId === stockEntry.ownerCompanyId)
                    .map((entry) => ({
                      value: entry.ownerCompanyId,
                      label: `${formatOwnerCompanyLabel(entry)}${entry.isActive ? '' : ' (inactive)'}`
                    }))
                ]}
                disabled={!canChangeOwner || ownerCompaniesQuery.isLoading || changeOwnerMutation.isPending}
                hint={
                  canChangeOwner
                    ? 'Optional ownership-only change. Counts and material-flow state are preserved.'
                    : 'Only owner-role users can change existing caulk ownership.'
                }
              />
              {canChangeOwner && ownerCompanyId && ownerCompanyId !== stockEntry.ownerCompanyId ? (
                <Input
                  label="Ownership Note"
                  value={ownershipNote}
                  onChange={(event) => setOwnershipNote(event.target.value)}
                  placeholder="Optional reason for ownership change"
                  disabled={changeOwnerMutation.isPending}
                />
              ) : null}
            </div>
            {ownerCompaniesQuery.error ? <p className="error-text">Owner companies could not be loaded.</p> : null}
            {canChangeOwner ? (
              <div className="detail-actions">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void handleOwnerChange()}
                  disabled={
                    !stockEntry.stockId ||
                    !ownerCompanyId ||
                    ownerCompanyId === stockEntry.ownerCompanyId ||
                    changeOwnerMutation.isPending
                  }
                  loading={changeOwnerMutation.isPending}
                  loadingLabel="Saving owner..."
                >
                  Save Ownership
                </Button>
              </div>
            ) : null}

            <div className="panel-title-row">
              <div>
                <h2>Edit Inventory</h2>
                <p className="muted-text">
                  Set the exact number of full cases and loose tubes currently on hand.
                </p>
              </div>
            </div>
            <div className="form-grid">
              <Input
                label="Cases Available"
                inputMode="numeric"
                value={casesInput}
                onChange={(event) => setCasesInput(event.target.value.replace(/[^0-9]/g, ''))}
                disabled={!canEdit || saveMutation.isPending}
                error={formError && !casesInput.trim() ? 'Enter a value greater than or equal to zero.' : ''}
              />
              <Input
                label="Loose Tubes Available"
                inputMode="numeric"
                value={looseTubesInput}
                onChange={(event) => setLooseTubesInput(event.target.value.replace(/[^0-9]/g, ''))}
                hint={`Use 0 to ${Math.max(0, tubesPerCase - 1)} loose tubes.`}
                disabled={!canEdit || saveMutation.isPending}
              />
            </div>
            <TextArea
              label="Adjustment Notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              disabled={!canEdit || saveMutation.isPending}
              hint="Optional notes for the inventory adjustment history."
            />
            {desiredTotalResult.error ? <p className="error-text">{desiredTotalResult.error}</p> : null}
            {formError && !desiredTotalResult.error ? <p className="error-text">{formError}</p> : null}
            {!canEdit ? <p className="muted-text">You have read-only access to caulk inventory.</p> : null}
            <div className="detail-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={handleSave}
                disabled={!canEdit || !stockEntry || Boolean(desiredTotalResult.error)}
                loading={saveMutation.isPending}
                loadingLabel="Saving..."
              >
                Save Changes
              </Button>
            </div>
          </>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Recent Transactions</h2>
          <span className="muted-text">{(transactionsQuery.data || []).length} entries</span>
        </div>
        {transactionsQuery.isError ? (
          <p className="error-text">
            {transactionsQuery.error instanceof Error
              ? transactionsQuery.error.message
              : 'Caulk transaction history failed to load.'}
          </p>
        ) : null}
        <DeferredLoadingState
          when={transactionsQuery.isLoading && !transactionsQuery.data}
          label="Loading caulk transactions..."
        />
        {!transactionsQuery.isLoading ? (
          <div className="table-wrap">
            <table className="inventory-table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Delta Tubes</th>
                  <th>Resulting Tubes</th>
                  <th>Reason</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {(transactionsQuery.data || []).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted-text">
                      No transaction history has been recorded for this caulk stock yet.
                    </td>
                  </tr>
                ) : (
                  (transactionsQuery.data || []).map((entry) => {
                    const transactionJobLabel =
                      entry.jobId && entry.jobNumber ? formatCaulkJobLabel(entry) : '';

                    return (
                      <tr key={entry.transactionId}>
                        <td>{entry.action}</td>
                        <td>{entry.deltaTubes}</td>
                        <td>{entry.resultingTubesOnHand}</td>
                        <td>
                          {entry.reason || '--'}
                          {transactionJobLabel ? (
                            <div className="muted-text">Job {transactionJobLabel}</div>
                          ) : null}
                        </td>
                        <td>{formatDateLabel(entry.createdAt)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  );
}
