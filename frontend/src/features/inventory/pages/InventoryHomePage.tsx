import { useDeferredValue, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { LoadingState } from '../../../components/LoadingState';
import { normalizeManufacturerLookupKey } from '../../../lib/manufacturerCanonicalization';
import { InventoryFilters } from '../components/InventoryFilters';
import { useOfflineInventorySearch } from '../hooks/useOfflineInventorySearch';
import { useFilmCatalog } from '../hooks/useInventoryQueries';
import { InventoryTable } from '../components/InventoryTable';
import type { InventoryFilterValues } from '../schemas/boxSchemas';
import {
  canonicalizeManufacturerLabel,
  getManufacturerOptionsWithCatalog
} from '../utils/boxHelpers';
import {
  parseWarehouseFilterValue,
  toWarehouseFilterOptionValue
} from '../utils/warehouseOptions';

function readFilters(searchParams: URLSearchParams): InventoryFilterValues {
  return {
    warehouse: parseWarehouseFilterValue(searchParams.get('warehouse')),
    manufacturer: canonicalizeManufacturerLabel(searchParams.get('manufacturer') || ''),
    q: searchParams.get('q') || '',
    status: (searchParams.get('status') || '') as InventoryFilterValues['status'],
    film: '',
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
  const filmCatalogQuery = useFilmCatalog();
  const manufacturerOptions = useMemo(() => {
    const optionsByKey = new Map<string, string>();
    const knownManufacturerOptions = getManufacturerOptionsWithCatalog(filmCatalogQuery.data);
    const addOption = (value: string) => {
      const label = canonicalizeManufacturerLabel(value);
      if (!label) {
        return;
      }

      const key = normalizeManufacturerLookupKey(label);
      if (!optionsByKey.has(key)) {
        optionsByKey.set(key, label);
      }
    };

    for (let index = 0; index < knownManufacturerOptions.length; index += 1) {
      addOption(knownManufacturerOptions[index]);
    }

    addOption(filters.manufacturer);

    return Array.from(optionsByKey.values()).sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: 'base' })
    );
  }, [filmCatalogQuery.data, filters.manufacturer]);

  useEffect(() => {
    if (searchParams.get('warehouse')) {
      return;
    }

    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('warehouse', toWarehouseFilterOptionValue(filters.warehouse));
    setSearchParams(nextParams, { replace: true });
  }, [filters.warehouse, searchParams, setSearchParams]);

  const patchFilters = (next: Partial<InventoryFilterValues>) => {
    const merged = { ...filters, ...next, film: '' };
    const nextParams = new URLSearchParams();

    nextParams.set('warehouse', toWarehouseFilterOptionValue(merged.warehouse));

    if (merged.q) {
      nextParams.set('q', merged.q);
    }
    if (merged.manufacturer) {
      nextParams.set('manufacturer', merged.manufacturer);
    }
    if (merged.status) {
      nextParams.set('status', merged.status);
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
              Search and manage boxes across every warehouse.
            </p>
          </div>
        </div>
        <div className="toolbar-row">
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
            <span className="error-text">
              The latest sync failed. Using the last saved copy.
              {boxesQuery.syncError.message ? ` (${boxesQuery.syncError.message})` : ''}
            </span>
          ) : null}
        </div>
        <InventoryFilters
          values={filters}
          manufacturerOptions={manufacturerOptions}
          onChange={patchFilters}
        />
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
