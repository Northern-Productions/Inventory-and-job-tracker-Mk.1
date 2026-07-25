import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { normalizeManufacturerLookupKey } from '../../../lib/manufacturerCanonicalization';
import { filterOfflineBoxes } from '../../../lib/offlineInventory';
import { CaulkInventoryContent } from '../../caulk/components/CaulkInventoryContent';
import { InventoryFilters } from '../components/InventoryFilters';
import { useOfflineInventorySearch } from '../hooks/useOfflineInventorySearch';
import { useDefaultWarehouse } from '../hooks/useDefaultWarehouse';
import { useWarehouseRegistry } from '../hooks/useWarehouseRegistry';
import { useFilmCatalog } from '../hooks/useInventoryQueries';
import { InventoryTable } from '../components/InventoryTable';
import type { InventoryFilterValues } from '../schemas/boxSchemas';
import {
  canonicalizeManufacturerLabel,
  getManufacturerOptionsWithCatalog
} from '../utils/boxHelpers';
import { getInventorySearchSuggestions } from '../utils/inventorySearchSuggestions';
import { getActiveCustomWidth } from '../utils/widthFilters';
import {
  patchInventoryRouteState,
  readInventoryRouteState,
  writeInventoryRouteState,
  type InventoryView
} from '../utils/inventoryRouteState';
import { LIST_ROUTE_KINDS } from '../../navigation/navigationSession';
import { useManagedListScroll } from '../../navigation/NavigationCoordinator';

export default function InventoryHomePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const hasMountedRef = useRef(false);
  const defaultWarehouse = useDefaultWarehouse();
  const warehouseRegistry = useWarehouseRegistry();
  const warehouseRegistrySettled =
    warehouseRegistry.scopeReady === true && warehouseRegistry.isSuccess;
  const routeState = useMemo(
    () =>
      readInventoryRouteState(searchParams, {
        defaultWarehouse,
        warehouseEntries: warehouseRegistry.entries,
        warehouseRegistrySettled
      }),
    [
      defaultWarehouse,
      searchParams,
      warehouseRegistry.entries,
      warehouseRegistrySettled
    ]
  );
  const filters = routeState.filters;
  const [rememberedCustomWidth, setRememberedCustomWidth] = useState(() =>
    getActiveCustomWidth(filters.widths)
  );
  const inventoryView = routeState.inventoryView;
  const deferredFilters = useDeferredValue(filters);
  const boxesQuery = useOfflineInventorySearch(filters.warehouse, {
    enabled: warehouseRegistrySettled
  });
  const filteredBoxes = useMemo(
    () => filterOfflineBoxes(boxesQuery.snapshotBoxes, deferredFilters),
    [boxesQuery.snapshotBoxes, deferredFilters]
  );
  const searchSuggestions = useMemo(
    () => getInventorySearchSuggestions(boxesQuery.snapshotBoxes, filters),
    [boxesQuery.snapshotBoxes, filters]
  );
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
  const offlineStatusLabel = getOfflineInventoryStatusLabel(
    boxesQuery.isOffline,
    boxesQuery.isSyncing,
    boxesQuery.hasSnapshot,
    boxesQuery.lastSyncedAt
  );
  const canonicalSearchParams = useMemo(
    () => writeInventoryRouteState(routeState, { defaultWarehouse }),
    [defaultWarehouse, routeState]
  );
  const routeParsed = canonicalSearchParams.toString() === searchParams.toString();
  const inventoryScroll = useManagedListScroll({
    kind: LIST_ROUTE_KINDS.INVENTORY,
    routeParsed,
    authorizationResolved: warehouseRegistrySettled,
    dataReady:
      inventoryView === 'film' && !boxesQuery.isLoading && !boxesQuery.isError,
    layoutReady: inventoryView === 'film',
    expectedAnchorCount: inventoryView === 'film' ? filteredBoxes.length : 0
  });

  useEffect(() => {
    if (routeParsed) {
      return;
    }
    setSearchParams(canonicalSearchParams, { replace: true });
  }, [canonicalSearchParams, routeParsed, setSearchParams]);

  useEffect(() => {
    hasMountedRef.current = true;
  }, []);

  const setInventoryView = (nextView: InventoryView) => {
    setSearchParams(
      writeInventoryRouteState(
        patchInventoryRouteState(routeState, { inventoryView: nextView }),
        { defaultWarehouse }
      ),
      { replace: true }
    );
  };

  const patchFilters = (next: Partial<InventoryFilterValues>) => {
    setSearchParams(
      writeInventoryRouteState(
        patchInventoryRouteState(routeState, { filters: next }),
        { defaultWarehouse }
      ),
      { replace: true }
    );
  };

  const inventoryViewToggle = (
    <div className="inventory-view-toggle" role="group" aria-label="Inventory view">
      <button
        type="button"
        className={`inventory-view-toggle-button ${inventoryView === 'film' ? 'inventory-view-toggle-button-active' : ''}`.trim()}
        onClick={() => setInventoryView('film')}
        aria-pressed={inventoryView === 'film'}
      >
        Film Inventory
      </button>
      <button
        type="button"
        className={`inventory-view-toggle-button ${inventoryView === 'caulk' ? 'inventory-view-toggle-button-active' : ''}`.trim()}
        onClick={() => setInventoryView('caulk')}
        aria-pressed={inventoryView === 'caulk'}
      >
        Caulk Inventory
      </button>
    </div>
  );

  const filmInventoryContent = (
    <>
      <section className="panel inventory-filter-panel">
        <div className="page-hero-topline">
          <span className="eyebrow">Inventory Control</span>
          <div className="inventory-view-toggle-wrap">{inventoryViewToggle}</div>
        </div>
        <div className="page-hero-title-row">
          <div className="page-hero-copy">
            <h2>Inventory</h2>
            <p className="muted-text">
              Search and manage boxes across every warehouse.
            </p>
          </div>
        </div>
        <div className="page-hero-summary inventory-hero-summary">
          <div className="hero-metric">
            <div className="hero-metric-line inventory-summary-line">
              <span className="hero-metric-label">Results</span>
              <strong className="hero-metric-value inventory-summary-value">
                {boxesQuery.isLoading && !boxesQuery.hasSnapshot ? 'Loading' : filteredBoxes.length}
              </strong>
              <span className="hero-metric-detail hero-metric-inline-copy inventory-summary-copy">
                {boxesQuery.isLoading && !boxesQuery.hasSnapshot ? 'Building inventory view' : 'Matching boxes'}
              </span>
            </div>
          </div>
          <div className={`hero-metric hero-metric-wide ${boxesQuery.syncError ? 'hero-metric-error' : ''}`.trim()}>
            <div className="hero-metric-line inventory-summary-line">
              <span className="hero-metric-label">Offline Copy</span>
              <strong
                className="hero-metric-detail hero-metric-inline-copy inventory-summary-copy"
                title={offlineStatusLabel}
              >
                {offlineStatusLabel}
              </strong>
            </div>
            {boxesQuery.syncError ? (
              <span className="field-error">
                Latest sync failed. Using the last saved copy.
                {boxesQuery.syncError.message ? ` (${boxesQuery.syncError.message})` : ''}
              </span>
            ) : null}
          </div>
        </div>
        <InventoryFilters
          values={filters}
          manufacturerOptions={manufacturerOptions}
          searchSuggestions={searchSuggestions}
          rememberedCustomWidth={rememberedCustomWidth}
          onRememberedCustomWidthChange={setRememberedCustomWidth}
          onChange={patchFilters}
        />
      </section>

      <section className="panel inventory-results-panel">
        <div className="panel-title-row">
          <div>
            <h2>Matching Boxes</h2>
            <p className="muted-text">
              Open a box to update stock, review history, or print the QR label.
            </p>
          </div>
          {!boxesQuery.isLoading && !boxesQuery.isError ? (
            <span className="muted-text">{filteredBoxes.length} box(es)</span>
          ) : null}
        </div>
        <DeferredLoadingState when={boxesQuery.isLoading} label="Loading inventory..." />
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
            boxes={filteredBoxes}
            buildDetailRoute={(boxId) =>
              `/inventory/${encodeURIComponent(boxId)}`
            }
            getAnchorRef={inventoryScroll.getAnchorRef}
          />
        ) : null}
      </section>
    </>
  );

  const inventoryViewContent =
    inventoryView === 'caulk' ? (
      <CaulkInventoryContent headerActions={inventoryViewToggle} initialWarehouse={filters.warehouse} />
    ) : (
      filmInventoryContent
    );

  return (
    <div
      key={`inventory-view-${inventoryView}`}
      className={`${hasMountedRef.current ? 'route-content-animate' : ''}`.trim()}
    >
      {inventoryViewContent}
    </div>
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
