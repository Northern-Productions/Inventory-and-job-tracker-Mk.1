import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../components/Button';
import { DeferredLoadingState } from '../../../components/DeferredLoadingState';
import { Input } from '../../../components/Input';
import { Select } from '../../../components/Select';
import { useToast } from '../../../components/Toast';
import {
  listCaulkManufacturers,
  listCaulkStock,
  upsertCaulkProduct
} from '../../../api/features/caulkClient';
import { formatOwnerCompanyLabel, type Warehouse } from '../../../domain';
import { useAuth } from '../../auth/AuthContext';
import { useWarehouseRegistry } from '../../inventory/hooks/useWarehouseRegistry';
import { useOwnerCompanies } from '../../inventory/hooks/useInventoryQueries';
import {
  ALL_WAREHOUSES_OPTION_VALUE,
  getSafeWarehouseFilterValue,
  toWarehouseFilterSelectOptions,
  toWarehouseFilterOptionValue
} from '../../inventory/utils/warehouseOptions';
import { toFullCasesFromTubes } from '../utils/stockMath';
import { NewCaulkProductDialog } from './NewCaulkProductDialog';

interface CaulkInventoryContentProps {
  headerActions?: ReactNode;
  initialWarehouse?: Warehouse | '';
}

export function CaulkInventoryContent({ headerActions, initialWarehouse = '' }: CaulkInventoryContentProps) {
  const auth = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const warehouseRegistry = useWarehouseRegistry();
  const warehouseEntries = warehouseRegistry.entries;
  const warehouseScopeReady = warehouseRegistry.scopeReady !== false;
  const canWriteInventory = auth.hasFeatureAccess('inventory', 'write');
  const ownerCompaniesQuery = useOwnerCompanies({ enabled: auth.isAuthenticated });

  const [warehouseFilter, setWarehouseFilter] = useState<string>(() =>
    toWarehouseFilterOptionValue(initialWarehouse)
  );
  const [manufacturerFilter, setManufacturerFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isNewProductDialogOpen, setIsNewProductDialogOpen] = useState(false);
  const [newProductError, setNewProductError] = useState('');
  const safeWarehouse = warehouseScopeReady
    ? getSafeWarehouseFilterValue(
        warehouseEntries,
        warehouseFilter === ALL_WAREHOUSES_OPTION_VALUE ? '' : warehouseFilter
      )
    : '';
  const safeWarehouseFilter = toWarehouseFilterOptionValue(safeWarehouse);

  const manufacturersQuery = useQuery({
    queryKey: ['caulk', 'manufacturers'],
    queryFn: () => listCaulkManufacturers()
  });

  const stockQuery = useQuery({
    queryKey: ['caulk', 'stock', safeWarehouseFilter, manufacturerFilter, searchQuery],
    queryFn: () =>
      listCaulkStock({
        warehouse: safeWarehouseFilter,
        manufacturer: manufacturerFilter,
        q: searchQuery
      }),
    enabled: warehouseScopeReady
  });

  const manufacturers = manufacturersQuery.data || [];
  const stockRows = stockQuery.data || [];
  const selectedWarehouseForNewProduct =
    safeWarehouseFilter && safeWarehouseFilter !== ALL_WAREHOUSES_OPTION_VALUE ? (safeWarehouseFilter as Warehouse) : '';

  useEffect(() => {
    if (!warehouseScopeReady || warehouseFilter === safeWarehouseFilter) {
      return;
    }
    setWarehouseFilter(safeWarehouseFilter);
  }, [safeWarehouseFilter, warehouseFilter, warehouseScopeReady]);

  const manufacturerOptions = useMemo(() => {
    return manufacturers
      .map((entry) => entry.name)
      .filter((value, index, array) => value && array.indexOf(value) === index)
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
  }, [manufacturers]);

  const createProductMutation = useMutation({
    mutationFn: upsertCaulkProduct,
    onSuccess: async (result, variables) => {
      setIsNewProductDialogOpen(false);
      setNewProductError('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['caulk', 'stock'] }),
        queryClient.invalidateQueries({ queryKey: ['caulk', 'products'] })
      ]);
      toast.push({
        title: 'Caulk product saved',
        description: `${result.productName} is now listed for ${variables.warehouse}.`,
        variant: 'success'
      });
      navigate(`/?inventoryView=caulk&warehouse=${encodeURIComponent(variables.warehouse || '')}`);
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : 'The new caulk product could not be saved.';
      setNewProductError(message);
      toast.push({
        title: 'Unable to save caulk product',
        description: message,
        variant: 'error'
      });
    }
  });

  const isBusy = manufacturersQuery.isLoading || stockQuery.isLoading;
  const showCaulkInventoryLoading =
    isBusy && !manufacturersQuery.data && !stockQuery.data;

  function openNewProductDialog() {
    if (!manufacturers.length) {
      toast.push({
        title: 'No manufacturers available',
        description: 'Create or activate a caulk manufacturer before adding a new product.',
        variant: 'error'
      });
      return;
    }

    if (!warehouseEntries.length) {
      toast.push({
        title: 'No warehouses configured',
        description: 'Add a warehouse before creating a new caulk product.',
        variant: 'error'
      });
      return;
    }

    setNewProductError('');
    setIsNewProductDialogOpen(true);
  }

  return (
    <>
      <section className="panel">
        <div className="page-hero-topline">
          <span className="eyebrow">Consumables</span>
          {headerActions ? <div className="inventory-view-toggle-wrap">{headerActions}</div> : null}
        </div>
        <div className="page-hero-title-row">
          <div className="page-hero-copy">
            <h2>Caulk Inventory</h2>
            <p className="muted-text">Track consumable tubes by warehouse with full-case counting (16 tubes per case).</p>
          </div>
        </div>
        <div className="filters-grid">
          <Select
            label="Warehouse"
            value={safeWarehouseFilter}
            onChange={(event) => setWarehouseFilter(event.target.value)}
            options={toWarehouseFilterSelectOptions(warehouseEntries)}
          />
          <Select
            label="Manufacturer"
            value={manufacturerFilter}
            onChange={(event) => setManufacturerFilter(event.target.value)}
            options={[
              { value: '', label: 'All' },
              ...manufacturerOptions.map((name) => ({ value: name, label: name }))
            ]}
          />
          <Input
            label="Search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Product or code"
          />
        </div>
        {stockQuery.isError ? (
          <p className="error-text">
            {stockQuery.error instanceof Error ? stockQuery.error.message : 'Caulk stock failed to load.'}
          </p>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Stock</h2>
          {canWriteInventory ? (
            <Button type="button" variant="ghost" size="sm" onClick={openNewProductDialog}>
              New Product +
            </Button>
          ) : (
            <span className="muted-text">{stockRows.length} product rows</span>
          )}
        </div>
        <DeferredLoadingState when={showCaulkInventoryLoading} label="Loading caulk inventory..." />
        {!showCaulkInventoryLoading ? (
          <div className="table-wrap">
            <table className="inventory-table">
              <thead>
                <tr>
                  <th>WAREHOUSE</th>
                  <th>MANUFACTURER</th>
                  <th>PRODUCT</th>
                  <th>OWNER</th>
                  <th>TUBES</th>
                  <th>CASES</th>
                </tr>
              </thead>
              <tbody>
                {stockRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted-text">
                      No caulk rows matched the current filters.
                    </td>
                  </tr>
                ) : (
                  stockRows.map((entry) => (
                    <tr key={entry.stockId || `${entry.warehouse}:${entry.productId}:${entry.ownerCompanyId}`}>
                      <td>
                        <Link
                          className="caulk-stock-warehouse-link"
                          to={
                            entry.stockId
                              ? `/caulk/stock/${encodeURIComponent(entry.stockId)}`
                              : `/caulk/${encodeURIComponent(entry.warehouse)}/${encodeURIComponent(entry.productId)}`
                          }
                        >
                          {entry.warehouse}
                        </Link>
                      </td>
                      <td>{entry.manufacturer}</td>
                      <td>{entry.productName}</td>
                      <td>
                        <span className="badge badge-muted" title="Owner company">
                          {formatOwnerCompanyLabel({
                            code: entry.ownerCompanyCode,
                            displayName: entry.ownerCompanyDisplayName
                          }) || '--'}
                        </span>
                      </td>
                      <td>{entry.tubesOnHand}</td>
                      <td>{toFullCasesFromTubes(entry.tubesOnHand, entry.tubesPerCase)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <NewCaulkProductDialog
        open={isNewProductDialogOpen}
        pending={createProductMutation.isPending}
        error={newProductError}
        manufacturers={manufacturers}
        warehouseEntries={warehouseEntries}
        ownerCompanies={ownerCompaniesQuery.data}
        ownerCompaniesLoading={ownerCompaniesQuery.isLoading}
        ownerCompaniesError={ownerCompaniesQuery.error}
        lockedWarehouse={selectedWarehouseForNewProduct}
        onClose={() => {
          if (createProductMutation.isPending) {
            return;
          }
          setIsNewProductDialogOpen(false);
          setNewProductError('');
        }}
        onClearError={() => setNewProductError('')}
        onSubmit={(payload) => {
          setNewProductError('');
          createProductMutation.mutate(payload);
        }}
      />
    </>
  );
}
