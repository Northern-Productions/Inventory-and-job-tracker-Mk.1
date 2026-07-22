import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { getWarehouseAssetAuditReport } from '../../../../api/features/reportsClient';
import { Button } from '../../../../components/Button';
import { DeferredLoadingState } from '../../../../components/DeferredLoadingState';
import { Input } from '../../../../components/Input';
import { Select } from '../../../../components/Select';
import type {
  WarehouseAssetAuditFilters,
  WarehouseAssetAuditResponse,
  WarehouseAssetAuditStatus
} from '../../../../domain';
import { useAuth } from '../../../auth/AuthContext';
import { useDefaultWarehouse } from '../../hooks/useDefaultWarehouse';
import { useWarehouseAssetAuditReport } from '../../hooks/useInventoryQueries';
import {
  WarehouseAssetAuditTable,
  WarehouseAssetAuditTotals,
  WarehouseAssetAuditWorksheet
} from './WarehouseAssetAuditWorksheet';

const PAGE_SIZE = 50;
const ALL_STATUSES: WarehouseAssetAuditStatus[] = ['IN_STOCK', 'CHECKED_OUT', 'TRANSFER'];

function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );
  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return isOnline;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  Object.values(value as Record<string, unknown>).forEach((entry) => deepFreeze(entry));
  return value;
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

function formatRefreshTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function ensureSelectedOption(
  options: Array<{ label: string; value: string }>,
  value: string,
  fallbackLabel = value
) {
  if (!value || options.some((entry) => entry.value === value)) {
    return options;
  }
  return [...options, { label: fallbackLabel, value }];
}

export function WarehouseAssetAuditReport() {
  const { accessContext } = useAuth();
  const defaultWarehouse = useDefaultWarehouse();
  const orgId = accessContext?.orgId || '';
  const isOnline = useOnlineStatus();
  const initializedDefaultWarehouse = useRef(false);
  const [filters, setFilters] = useState<WarehouseAssetAuditFilters>({
    warehouse: defaultWarehouse,
    ownerCompanyId: '',
    manufacturer: '',
    filmName: '',
    width: '',
    statuses: [...ALL_STATUSES],
    q: ''
  });
  const [page, setPage] = useState(1);
  const [printSnapshot, setPrintSnapshot] = useState<WarehouseAssetAuditResponse | null>(null);
  const [isPreparingPrint, setIsPreparingPrint] = useState(false);
  const [printError, setPrintError] = useState('');
  const query = useWarehouseAssetAuditReport(orgId, filters, { enabled: Boolean(orgId) && isOnline });
  const snapshot = query.data;

  useEffect(() => {
    if (initializedDefaultWarehouse.current || !defaultWarehouse) {
      return;
    }
    initializedDefaultWarehouse.current = true;
    setFilters((current) => ({ ...current, warehouse: current.warehouse || defaultWarehouse }));
  }, [defaultWarehouse]);

  useEffect(() => {
    setPage(1);
  }, [snapshot?.metadata.generatedAt]);

  const pageCount = Math.max(1, Math.ceil((snapshot?.rows.length || 0) / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visibleRows = useMemo(
    () => snapshot?.rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE) || [],
    [safePage, snapshot?.rows]
  );
  const warehouseOptions = ensureSelectedOption(
    [
      { label: 'All Warehouses', value: '' },
      ...(snapshot?.filterOptions.warehouses.map((entry) => ({
        label: entry.label,
        value: entry.value
      })) || [])
    ],
    filters.warehouse || '',
    filters.warehouse || ''
  );
  const ownerOptions = ensureSelectedOption(
    [
      { label: 'All Owners', value: '' },
      ...(snapshot?.filterOptions.owners || [])
    ],
    filters.ownerCompanyId || ''
  );
  const selectedStatuses = filters.statuses?.length ? filters.statuses : ALL_STATUSES;

  function patchFilters(next: Partial<WarehouseAssetAuditFilters>) {
    setPage(1);
    setPrintError('');
    setFilters((current) => ({ ...current, ...next }));
  }

  function toggleStatus(status: WarehouseAssetAuditStatus) {
    const current = selectedStatuses;
    if (current.includes(status) && current.length === 1) {
      return;
    }
    patchFilters({
      statuses: current.includes(status)
        ? current.filter((entry) => entry !== status)
        : ALL_STATUSES.filter((entry) => entry === status || current.includes(entry))
    });
  }

  async function handlePrint() {
    if (!isOnline || query.isLoading || query.isFetching || query.error || !snapshot) {
      return;
    }
    setIsPreparingPrint(true);
    setPrintError('');
    const requestedFilters: WarehouseAssetAuditFilters = {
      ...filters,
      statuses: [...selectedStatuses]
    };
    try {
      const liveResponse = await getWarehouseAssetAuditReport(requestedFilters);
      const immutableSnapshot = deepFreeze(structuredClone(liveResponse));
      flushSync(() => setPrintSnapshot(immutableSnapshot));
      document.body.classList.add('warehouse-asset-audit-printing');
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }
      await waitForPaint();
      const root = document.querySelector(
        '.warehouse-asset-audit-print-only-root [data-audit-print-snapshot]'
      );
      const renderedRows = root?.querySelectorAll('[data-audit-row-id]') || [];
      const renderedIds = new Set(Array.from(renderedRows, (row) => row.getAttribute('data-audit-row-id')));
      if (
        !root ||
        renderedRows.length !== immutableSnapshot.rows.length ||
        renderedIds.size !== immutableSnapshot.rows.length
      ) {
        throw new Error('The print worksheet did not render every matching box exactly once.');
      }
      window.print();
    } catch (error) {
      setPrintError(error instanceof Error ? error.message : 'The audit worksheet could not be prepared.');
    } finally {
      document.body.classList.remove('warehouse-asset-audit-printing');
      setIsPreparingPrint(false);
    }
  }

  const printDisabled =
    !isOnline || query.isLoading || query.isFetching || Boolean(query.error) || !snapshot || isPreparingPrint;

  const printPortal =
    typeof document !== 'undefined' && printSnapshot
      ? createPortal(
          <div className="warehouse-asset-audit-print-only-root" aria-hidden="true">
            <WarehouseAssetAuditWorksheet snapshot={printSnapshot} />
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <section className="panel warehouse-asset-audit-controls">
        <div className="panel-title-row">
          <div>
            <h2>Audit Filters</h2>
            <p className="muted-text">Current physical custody and on-hand asset value.</p>
          </div>
          <div className="page-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => void query.refetch()}
              disabled={!isOnline || query.isFetching || isPreparingPrint}
              loading={query.isFetching && !isPreparingPrint}
              loadingLabel="Refreshing..."
            >
              Refresh
            </Button>
            <Button
              type="button"
              onClick={() => void handlePrint()}
              disabled={printDisabled}
              loading={isPreparingPrint}
              loadingLabel="Preparing..."
            >
              Print Audit
            </Button>
          </div>
        </div>
        <div className="toolbar-grid reports-filters warehouse-asset-audit-filter-grid">
          <Select
            label="Warehouse"
            value={filters.warehouse || ''}
            onChange={(event) => patchFilters({ warehouse: event.target.value })}
            options={warehouseOptions}
            disabled={isPreparingPrint}
          />
          <Select
            label="Owner"
            value={filters.ownerCompanyId || ''}
            onChange={(event) => patchFilters({ ownerCompanyId: event.target.value })}
            options={ownerOptions}
            disabled={isPreparingPrint}
          />
          <Select
            label="Manufacturer"
            value={filters.manufacturer || ''}
            onChange={(event) => patchFilters({ manufacturer: event.target.value })}
            options={[
              { label: 'All Manufacturers', value: '' },
              ...(snapshot?.filterOptions.manufacturers.map((value) => ({ label: value, value })) || [])
            ]}
            disabled={isPreparingPrint}
          />
          <Select
            label="Film"
            value={filters.filmName || ''}
            onChange={(event) => patchFilters({ filmName: event.target.value })}
            options={[
              { label: 'All Films', value: '' },
              ...(snapshot?.filterOptions.filmNames.map((value) => ({ label: value, value })) || [])
            ]}
            disabled={isPreparingPrint}
          />
          <Select
            label="Width"
            value={filters.width || ''}
            onChange={(event) => patchFilters({ width: event.target.value })}
            options={[
              { label: 'All Widths', value: '' },
              ...(snapshot?.filterOptions.widths.map((value) => ({
                label: `${value}\"`,
                value: String(value)
              })) || [])
            ]}
            disabled={isPreparingPrint}
          />
          <Input
            label="Search"
            value={filters.q || ''}
            onChange={(event) => patchFilters({ q: event.target.value })}
            placeholder="Box ID, owner, film"
            disabled={isPreparingPrint}
          />
        </div>
        <fieldset className="warehouse-asset-audit-status-filter" disabled={isPreparingPrint}>
          <legend>Status</legend>
          {ALL_STATUSES.map((status) => {
            const label = snapshot?.filterOptions.statuses.find((entry) => entry.value === status)?.label || status;
            return (
              <label key={status}>
                <input
                  type="checkbox"
                  checked={selectedStatuses.includes(status)}
                  onChange={() => toggleStatus(status)}
                />
                <span>{label}</span>
              </label>
            );
          })}
        </fieldset>
        {!isOnline ? <p className="error-text">Connect to the internet to load or print this live audit.</p> : null}
        {printError ? <p className="error-text">{printError}</p> : null}
      </section>

      <section className="panel warehouse-asset-audit-results">
        <div className="panel-title-row">
          <div>
            <h2>Warehouse Asset Audit</h2>
            <p className="muted-text">
              {snapshot ? `Live data refreshed ${formatRefreshTime(snapshot.metadata.generatedAt)}.` : 'Loading live data.'}
            </p>
          </div>
          {snapshot ? <span className="muted-text">{snapshot.totals.matchingBoxes} box(es)</span> : null}
        </div>
        <DeferredLoadingState when={query.isLoading && !snapshot} label="Loading warehouse asset audit..." />
        {query.error ? <p className="error-text">{query.error.message}</p> : null}
        {snapshot && !query.error ? (
          <>
            {!snapshot.rows.length ? (
              <div className="empty-state">No boxes match the current audit filters.</div>
            ) : (
              <div className="table-wrap warehouse-asset-audit-screen-table">
                <WarehouseAssetAuditTable rows={visibleRows} />
              </div>
            )}
            {snapshot.rows.length > PAGE_SIZE ? (
              <div className="warehouse-asset-audit-pagination" aria-label="Audit result pages">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={safePage <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Previous
                </Button>
                <span>Page {safePage} of {pageCount}</span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={safePage >= pageCount}
                  onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                >
                  Next
                </Button>
              </div>
            ) : null}
            <WarehouseAssetAuditTotals snapshot={snapshot} className="warehouse-asset-audit-screen-totals" />
          </>
        ) : null}
      </section>
      {printPortal}
    </>
  );
}
