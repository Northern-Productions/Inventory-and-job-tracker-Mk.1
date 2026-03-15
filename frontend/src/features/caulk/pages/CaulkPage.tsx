import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Input';
import { LoadingState } from '../../../components/LoadingState';
import { Select } from '../../../components/Select';
import {
  listCaulkManufacturers,
  listCaulkProducts,
  listCaulkStock,
  listCaulkTransactions,
  mutateCaulkStock,
  ownerUpsertCaulkManufacturer,
  transferCaulkStock,
  upsertCaulkProduct
} from '../../../api/client';
import { useWarehouseRegistry } from '../../inventory/hooks/useWarehouseRegistry';
import { useAuth } from '../../auth/AuthContext';

type StockAction = 'RECEIVE' | 'USE' | 'ADJUST';

function formatDateTime(value: string) {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

export default function CaulkPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const warehouseRegistry = useWarehouseRegistry();
  const warehouseOptions = warehouseRegistry.entries;
  const defaultWarehouse = warehouseOptions[0]?.code || 'IL1';

  const [warehouseFilter, setWarehouseFilter] = useState<string>('ALL');
  const [manufacturerFilter, setManufacturerFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [transactionProductFilter, setTransactionProductFilter] = useState('');

  const [manufacturerName, setManufacturerName] = useState('');
  const [manufacturerActive, setManufacturerActive] = useState(true);

  const [productManufacturerId, setProductManufacturerId] = useState('');
  const [productName, setProductName] = useState('');
  const [productCode, setProductCode] = useState('');
  const [productTubesPerCase, setProductTubesPerCase] = useState('16');
  const [productNotes, setProductNotes] = useState('');

  const [stockAction, setStockAction] = useState<StockAction>('RECEIVE');
  const [stockWarehouse, setStockWarehouse] = useState(defaultWarehouse);
  const [stockProductId, setStockProductId] = useState('');
  const [stockCases, setStockCases] = useState('');
  const [stockTubes, setStockTubes] = useState('');
  const [stockReason, setStockReason] = useState('');
  const [stockNotes, setStockNotes] = useState('');

  const [transferWarehouseFrom, setTransferWarehouseFrom] = useState(defaultWarehouse);
  const [transferWarehouseTo, setTransferWarehouseTo] = useState(
    warehouseOptions[1]?.code || defaultWarehouse
  );
  const [transferProductId, setTransferProductId] = useState('');
  const [transferCases, setTransferCases] = useState('');
  const [transferTubes, setTransferTubes] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const [transferNotes, setTransferNotes] = useState('');

  const manufacturersQuery = useQuery({
    queryKey: ['caulk', 'manufacturers'],
    queryFn: () => listCaulkManufacturers()
  });
  const productsQuery = useQuery({
    queryKey: ['caulk', 'products'],
    queryFn: () => listCaulkProducts()
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
  const transactionsQuery = useQuery({
    queryKey: ['caulk', 'transactions', warehouseFilter, transactionProductFilter],
    queryFn: () =>
      listCaulkTransactions({
        warehouse: warehouseFilter,
        productId: transactionProductFilter,
        limit: 200
      })
  });

  const manufacturers = manufacturersQuery.data || [];
  const products = productsQuery.data || [];
  const stockRows = stockQuery.data || [];
  const transactionRows = transactionsQuery.data || [];

  const manufacturerOptions = useMemo(() => {
    return manufacturers
      .map((entry) => entry.name)
      .filter((value, index, array) => value && array.indexOf(value) === index)
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
  }, [manufacturers]);

  const productOptions = useMemo(() => {
    return products.map((entry) => ({
      value: entry.productId,
      label: `${entry.manufacturer} | ${entry.productName}${entry.productCode ? ` (${entry.productCode})` : ''}`
    }));
  }, [products]);

  const invalidateCaulkQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['caulk', 'manufacturers'] }),
      queryClient.invalidateQueries({ queryKey: ['caulk', 'products'] }),
      queryClient.invalidateQueries({ queryKey: ['caulk', 'stock'] }),
      queryClient.invalidateQueries({ queryKey: ['caulk', 'transactions'] })
    ]);
  };

  const ownerManufacturerMutation = useMutation({
    mutationFn: ownerUpsertCaulkManufacturer,
    onSuccess: async () => {
      setManufacturerName('');
      setManufacturerActive(true);
      await invalidateCaulkQueries();
    }
  });

  const upsertProductMutation = useMutation({
    mutationFn: upsertCaulkProduct,
    onSuccess: async () => {
      setProductName('');
      setProductCode('');
      setProductTubesPerCase('16');
      setProductNotes('');
      await invalidateCaulkQueries();
    }
  });

  const mutateStockMutation = useMutation({
    mutationFn: mutateCaulkStock,
    onSuccess: async () => {
      setStockCases('');
      setStockTubes('');
      setStockReason('');
      setStockNotes('');
      await invalidateCaulkQueries();
    }
  });

  const transferStockMutation = useMutation({
    mutationFn: transferCaulkStock,
    onSuccess: async () => {
      setTransferCases('');
      setTransferTubes('');
      setTransferReason('');
      setTransferNotes('');
      await invalidateCaulkQueries();
    }
  });

  const canWriteInventory = auth.hasFeatureAccess('inventory', 'write');
  const isBusy = manufacturersQuery.isLoading || productsQuery.isLoading || stockQuery.isLoading;

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>Caulk Inventory</h2>
            <p className="muted-text">Track consumable tubes by warehouse using cases + tubes.</p>
          </div>
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
                  <th>Warehouse</th>
                  <th>Manufacturer</th>
                  <th>Product</th>
                  <th>Code</th>
                  <th>Tubes/Case</th>
                  <th>Tubes On Hand</th>
                  <th>Cases</th>
                  <th>Loose</th>
                </tr>
              </thead>
              <tbody>
                {stockRows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="muted-text">
                      No caulk rows matched the current filters.
                    </td>
                  </tr>
                ) : (
                  stockRows.map((entry) => (
                    <tr key={`${entry.warehouse}:${entry.productId}`}>
                      <td>{entry.warehouse}</td>
                      <td>{entry.manufacturer}</td>
                      <td>{entry.productName}</td>
                      <td>{entry.productCode || '-'}</td>
                      <td>{entry.tubesPerCase}</td>
                      <td>{entry.tubesOnHand}</td>
                      <td>{entry.casesOnHand}</td>
                      <td>{entry.looseTubes}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Receive / Use / Adjust</h2>
          <span className="muted-text">Online-only in v1</span>
        </div>
        <div className="form-grid">
          <Select
            label="Action"
            value={stockAction}
            onChange={(event) => setStockAction(event.target.value as StockAction)}
            options={[
              { value: 'RECEIVE', label: 'Receive' },
              { value: 'USE', label: 'Use' },
              { value: 'ADJUST', label: 'Adjust' }
            ]}
          />
          <Select
            label="Warehouse"
            value={stockWarehouse}
            onChange={(event) => setStockWarehouse(event.target.value)}
            options={warehouseOptions.map((entry) => ({ value: entry.code, label: entry.name || entry.code }))}
          />
          <Select
            label="Product"
            value={stockProductId}
            onChange={(event) => setStockProductId(event.target.value)}
            options={[{ value: '', label: 'Select product' }, ...productOptions]}
          />
          <Input
            label="Cases"
            type="number"
            value={stockCases}
            onChange={(event) => setStockCases(event.target.value)}
            placeholder="0"
          />
          <Input
            label="Tubes"
            type="number"
            value={stockTubes}
            onChange={(event) => setStockTubes(event.target.value)}
            placeholder="0"
          />
          <Input
            label="Reason"
            value={stockReason}
            onChange={(event) => setStockReason(event.target.value)}
            placeholder={stockAction}
          />
          <Input
            label="Notes"
            value={stockNotes}
            onChange={(event) => setStockNotes(event.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="page-actions">
          <Button
            type="button"
            disabled={!canWriteInventory || !stockProductId || mutateStockMutation.isPending}
            onClick={() =>
              mutateStockMutation.mutate({
                action: stockAction,
                productId: stockProductId,
                warehouse: stockWarehouse,
                cases: stockCases === '' ? 0 : Number(stockCases),
                tubes: stockTubes === '' ? 0 : Number(stockTubes),
                reason: stockReason,
                notes: stockNotes
              })
            }
          >
            Save Stock Mutation
          </Button>
        </div>
        {mutateStockMutation.isError ? (
          <p className="error-text">
            {mutateStockMutation.error instanceof Error
              ? mutateStockMutation.error.message
              : 'Stock mutation failed.'}
          </p>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Transfer</h2>
          <span className="muted-text">Creates paired out/in ledger rows</span>
        </div>
        <div className="form-grid">
          <Select
            label="Product"
            value={transferProductId}
            onChange={(event) => setTransferProductId(event.target.value)}
            options={[{ value: '', label: 'Select product' }, ...productOptions]}
          />
          <Select
            label="From Warehouse"
            value={transferWarehouseFrom}
            onChange={(event) => setTransferWarehouseFrom(event.target.value)}
            options={warehouseOptions.map((entry) => ({ value: entry.code, label: entry.name || entry.code }))}
          />
          <Select
            label="To Warehouse"
            value={transferWarehouseTo}
            onChange={(event) => setTransferWarehouseTo(event.target.value)}
            options={warehouseOptions.map((entry) => ({ value: entry.code, label: entry.name || entry.code }))}
          />
          <Input
            label="Cases"
            type="number"
            value={transferCases}
            onChange={(event) => setTransferCases(event.target.value)}
            placeholder="0"
          />
          <Input
            label="Tubes"
            type="number"
            value={transferTubes}
            onChange={(event) => setTransferTubes(event.target.value)}
            placeholder="0"
          />
          <Input
            label="Reason"
            value={transferReason}
            onChange={(event) => setTransferReason(event.target.value)}
            placeholder="TRANSFER"
          />
          <Input
            label="Notes"
            value={transferNotes}
            onChange={(event) => setTransferNotes(event.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="page-actions">
          <Button
            type="button"
            disabled={
              !canWriteInventory ||
              !transferProductId ||
              !transferWarehouseFrom ||
              !transferWarehouseTo ||
              transferStockMutation.isPending
            }
            onClick={() =>
              transferStockMutation.mutate({
                productId: transferProductId,
                fromWarehouse: transferWarehouseFrom,
                toWarehouse: transferWarehouseTo,
                cases: transferCases === '' ? 0 : Number(transferCases),
                tubes: transferTubes === '' ? 0 : Number(transferTubes),
                reason: transferReason,
                notes: transferNotes
              })
            }
          >
            Transfer
          </Button>
        </div>
        {transferStockMutation.isError ? (
          <p className="error-text">
            {transferStockMutation.error instanceof Error
              ? transferStockMutation.error.message
              : 'Transfer failed.'}
          </p>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Product Setup</h2>
          <span className="muted-text">Create products before receiving stock.</span>
        </div>
        <div className="form-grid">
          <Select
            label="Manufacturer"
            value={productManufacturerId}
            onChange={(event) => setProductManufacturerId(event.target.value)}
            options={[
              { value: '', label: 'Select manufacturer' },
              ...manufacturers.map((entry) => ({
                value: entry.manufacturerId,
                label: entry.name
              }))
            ]}
          />
          <Input
            label="Product Name"
            value={productName}
            onChange={(event) => setProductName(event.target.value)}
            placeholder="Dow 995 White"
          />
          <Input
            label="Product Code"
            value={productCode}
            onChange={(event) => setProductCode(event.target.value)}
            placeholder="Optional code"
          />
          <Input
            label="Tubes Per Case"
            type="number"
            value={productTubesPerCase}
            onChange={(event) => setProductTubesPerCase(event.target.value)}
          />
          <Input
            label="Notes"
            value={productNotes}
            onChange={(event) => setProductNotes(event.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="page-actions">
          <Button
            type="button"
            disabled={
              !canWriteInventory ||
              !productManufacturerId ||
              !productName ||
              upsertProductMutation.isPending
            }
            onClick={() =>
              upsertProductMutation.mutate({
                manufacturerId: productManufacturerId,
                productName,
                productCode,
                tubesPerCase: Number(productTubesPerCase || 16),
                notes: productNotes
              })
            }
          >
            Save Product
          </Button>
        </div>
        {upsertProductMutation.isError ? (
          <p className="error-text">
            {upsertProductMutation.error instanceof Error
              ? upsertProductMutation.error.message
              : 'Product save failed.'}
          </p>
        ) : null}
      </section>

      {auth.isOwner ? (
        <section className="panel">
          <div className="panel-title-row">
            <h2>Owner Manufacturer Management</h2>
            <span className="muted-text">Only owners can add/rename/deactivate manufacturers.</span>
          </div>
          <div className="form-grid">
            <Input
              label="Manufacturer Name"
              value={manufacturerName}
              onChange={(event) => setManufacturerName(event.target.value)}
              placeholder="3M"
            />
            <Select
              label="Active"
              value={manufacturerActive ? 'true' : 'false'}
              onChange={(event) => setManufacturerActive(event.target.value === 'true')}
              options={[
                { value: 'true', label: 'Active' },
                { value: 'false', label: 'Inactive' }
              ]}
            />
          </div>
          <div className="page-actions">
            <Button
              type="button"
              disabled={!manufacturerName || ownerManufacturerMutation.isPending}
              onClick={() =>
                ownerManufacturerMutation.mutate({
                  name: manufacturerName,
                  isActive: manufacturerActive
                })
              }
            >
              Save Manufacturer
            </Button>
          </div>
          {ownerManufacturerMutation.isError ? (
            <p className="error-text">
              {ownerManufacturerMutation.error instanceof Error
                ? ownerManufacturerMutation.error.message
                : 'Manufacturer update failed.'}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-title-row">
          <h2>Transactions</h2>
          <span className="muted-text">Latest {transactionRows.length} entries</span>
        </div>
        <div className="filters-grid">
          <Select
            label="Product Filter"
            value={transactionProductFilter}
            onChange={(event) => setTransactionProductFilter(event.target.value)}
            options={[{ value: '', label: 'All products' }, ...productOptions]}
          />
        </div>
        {transactionsQuery.isLoading ? <LoadingState label="Loading transactions..." /> : null}
        {transactionsQuery.isError ? (
          <p className="error-text">
            {transactionsQuery.error instanceof Error
              ? transactionsQuery.error.message
              : 'Transactions failed to load.'}
          </p>
        ) : null}
        {!transactionsQuery.isLoading ? (
          <div className="table-wrap">
            <table className="inventory-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Warehouse</th>
                  <th>Product</th>
                  <th>Action</th>
                  <th>Delta Tubes</th>
                  <th>Result Tubes</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {transactionRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="muted-text">
                      No transactions found for the selected filters.
                    </td>
                  </tr>
                ) : (
                  transactionRows.map((entry) => (
                    <tr key={entry.transactionId}>
                      <td>{formatDateTime(entry.createdAt)}</td>
                      <td>{entry.warehouse}</td>
                      <td>
                        {entry.manufacturer} | {entry.productName}
                        {entry.productCode ? ` (${entry.productCode})` : ''}
                      </td>
                      <td>{entry.action}</td>
                      <td>{entry.deltaTubes}</td>
                      <td>{entry.resultingTubesOnHand}</td>
                      <td>{entry.reason || '-'}</td>
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
