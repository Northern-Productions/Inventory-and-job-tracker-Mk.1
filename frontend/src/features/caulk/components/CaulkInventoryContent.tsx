import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input } from '../../../components/Input';
import { LoadingState } from '../../../components/LoadingState';
import { Select } from '../../../components/Select';
import {
  listCaulkManufacturers,
  listCaulkStock
} from '../../../api/features/caulkClient';
import { useWarehouseRegistry } from '../../inventory/hooks/useWarehouseRegistry';

const CAULK_TUBES_PER_CASE = 16;

function toFullCasesFromTubes(totalTubes: number) {
  const normalized = Number.isFinite(totalTubes) ? Math.max(0, Math.trunc(totalTubes)) : 0;
  return Math.floor(normalized / CAULK_TUBES_PER_CASE);
}

interface CaulkInventoryContentProps {
  headerActions?: ReactNode;
}

export function CaulkInventoryContent({ headerActions }: CaulkInventoryContentProps) {
  const warehouseRegistry = useWarehouseRegistry();
  const warehouseOptions = warehouseRegistry.entries;

  const [warehouseFilter, setWarehouseFilter] = useState<string>('ALL');
  const [manufacturerFilter, setManufacturerFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const manufacturersQuery = useQuery({
    queryKey: ['caulk', 'manufacturers'],
    queryFn: () => listCaulkManufacturers()
  });

  const stockQuery = useQuery({
    queryKey: ['caulk', 'stock', warehouseFilter, manufacturerFilter, searchQuery],
    queryFn: () =>
      listCaulkStock({
        warehouse: warehouseFilter,
        manufacturer: manufacturerFilter,
        q: searchQuery
      })
  });

  const manufacturers = manufacturersQuery.data || [];
  const stockRows = stockQuery.data || [];

  const manufacturerOptions = useMemo(() => {
    return manufacturers
      .map((entry) => entry.name)
      .filter((value, index, array) => value && array.indexOf(value) === index)
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
  }, [manufacturers]);

  const isBusy = manufacturersQuery.isLoading || stockQuery.isLoading;

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>Caulk Inventory</h2>
            <p className="muted-text">Track consumable tubes by warehouse with full-case counting (16 tubes per case).</p>
          </div>
          {headerActions ? <div className="inventory-view-toggle-wrap">{headerActions}</div> : null}
        </div>
        <div className="filters-grid">
          <Select
            label="Warehouse"
            value={warehouseFilter}
            onChange={(event) => setWarehouseFilter(event.target.value)}
            options={[
              { value: 'ALL', label: 'All' },
              ...warehouseOptions.map((entry) => ({
                value: entry.code,
                label: entry.name || entry.code
              }))
            ]}
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
          <span className="muted-text">{stockRows.length} product rows</span>
        </div>
        {isBusy ? <LoadingState label="Loading caulk inventory..." /> : null}
        {!isBusy ? (
          <div className="table-wrap">
            <table className="inventory-table">
              <thead>
                <tr>
                  <th>WAREHOUSE</th>
                  <th>MANUFACTURER</th>
                  <th>PRODUCT</th>
                  <th>TUBES</th>
                  <th>CASES</th>
                </tr>
              </thead>
              <tbody>
                {stockRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted-text">
                      No caulk rows matched the current filters.
                    </td>
                  </tr>
                ) : (
                  stockRows.map((entry) => (
                    <tr key={`${entry.warehouse}:${entry.productId}`}>
                      <td>{entry.warehouse}</td>
                      <td>{entry.manufacturer}</td>
                      <td>{entry.productName}</td>
                      <td>{entry.tubesOnHand}</td>
                      <td>{toFullCasesFromTubes(entry.tubesOnHand)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  );
}
