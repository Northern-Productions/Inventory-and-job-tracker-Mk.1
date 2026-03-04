import { useDeferredValue } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { LoadingState } from '../../../components/LoadingState';
import type { Warehouse } from '../../../domain';
import { InventoryFilters } from '../components/InventoryFilters';
import { useOfflineInventorySearch } from '../hooks/useOfflineInventorySearch';
import { InventoryTable } from '../components/InventoryTable';
import { WarehouseToggle } from '../components/WarehouseToggle';
import type { InventoryFilterValues } from '../schemas/boxSchemas';

function readFilters(searchParams: URLSearchParams): InventoryFilterValues {
  const warehouse = (searchParams.get('warehouse') || 'IL') as Warehouse;

  return {
    warehouse: warehouse === 'MS' ? 'MS' : 'IL',
    q: searchParams.get('q') || '',
    status: (searchParams.get('status') || '') as InventoryFilterValues['status'],
    film: searchParams.get('film') || '',
    width: searchParams.get('width') || '',
    showRetired: false
  };
}

export default function InventoryHomePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const filters = readFilters(searchParams);
  const deferredFilters = useDeferredValue(filters);
  const boxesQuery = useOfflineInventorySearch(deferredFilters);

  const patchFilters = (next: Partial<InventoryFilterValues>) => {
    const merged = { ...filters, ...next };
    const nextParams = new URLSearchParams();

    nextParams.set('warehouse', merged.warehouse);

    if (merged.q) {
      nextParams.set('q', merged.q);
    }
    if (merged.status) {
      nextParams.set('status', merged.status);
    }
    if (merged.film) {
      nextParams.set('film', merged.film);
    }
    if (merged.width) {
      nextParams.set('width', merged.width);
    }
    setSearchParams(nextParams);
  };

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>Inventory</h2>
            <p className="muted-text">
              Search and manage boxes in Illinois and Mississippi separately.
            </p>
          </div>
          <div className="page-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={() => void boxesQuery.syncNow()}
              disabled={boxesQuery.isSyncing}
            >
              {boxesQuery.isSyncing ? 'Syncing...' : 'Sync Offline Copy'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => navigate('/inventory/scan')}>
              Scan QR
            </Button>
            <Button type="button" onClick={() => navigate('/inventory/add')}>
              Add Box
            </Button>
          </div>
        </div>
        <div className="toolbar-row">
          <WarehouseToggle
            value={filters.warehouse}
            onChange={(warehouse) => patchFilters({ warehouse })}
          />
          <span className="muted-text">
            {boxesQuery.isLoading && !boxesQuery.hasSnapshot
              ? 'Loading...'
              : `${boxesQuery.data.length} result(s)`}
          </span>
        </div>
        <div className="toolbar-row">
          <span className={boxesQuery.syncError ? 'error-text' : 'muted-text'}>
            {getOfflineInventoryStatusLabel(
              boxesQuery.isOffline,
              boxesQuery.isSyncing,
              boxesQuery.hasSnapshot,
              boxesQuery.lastSyncedAt
            )}
          </span>
          {boxesQuery.syncError ? (
            <span className="error-text">The latest sync failed. Using the last saved copy.</span>
          ) : null}
        </div>
        <InventoryFilters values={filters} onChange={patchFilters} />
      </section>

      <section className="panel">
        {boxesQuery.isLoading ? <LoadingState label="Loading inventory..." /> : null}
        {boxesQuery.isError ? (
          <div className="error-text">
            {boxesQuery.error instanceof Error
              ? boxesQuery.error.message
              : 'The inventory could not be loaded.'}
            <div className="page-actions">
              <Button type="button" variant="ghost" onClick={() => void boxesQuery.refetch()}>
                Retry
              </Button>
            </div>
          </div>
        ) : null}
        {!boxesQuery.isLoading && !boxesQuery.isError ? (
          <InventoryTable
            boxes={boxesQuery.data}
            onSelect={(boxId) => navigate(`/inventory/${encodeURIComponent(boxId)}`)}
          />
        ) : null}
      </section>
    </>
  );
}

function getOfflineInventoryStatusLabel(
  isOffline: boolean,
  isSyncing: boolean,
  hasSnapshot: boolean,
  lastSyncedAt: string
): string {
  if (isSyncing) {
    return hasSnapshot ? 'Refreshing the offline inventory copy...' : 'Building the offline inventory copy...';
  }

  if (isOffline) {
    return hasSnapshot
      ? `Offline mode using the saved inventory from ${formatSyncTimestamp(lastSyncedAt)}.`
      : 'Offline inventory is unavailable until the first successful sync.';
  }

  if (hasSnapshot) {
    return `Offline copy updated ${formatSyncTimestamp(lastSyncedAt)}.`;
  }

  return 'The offline inventory copy will be created after the first successful sync.';
}

function formatSyncTimestamp(value: string): string {
  if (!value) {
    return 'just now';
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}
