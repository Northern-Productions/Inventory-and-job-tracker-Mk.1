import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { CaulkInventoryContent } from './CaulkInventoryContent';

const useWarehouseRegistryMock = vi.fn();
const listCaulkManufacturersMock = vi.fn();
const listCaulkStockMock = vi.fn();

vi.mock('../../inventory/hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => useWarehouseRegistryMock()
}));

vi.mock('../../../api/features/caulkClient', () => ({
  listCaulkManufacturers: () => listCaulkManufacturersMock(),
  listCaulkStock: (params: unknown) => listCaulkStockMock(params)
}));

const sampleManufacturers = [
  {
    manufacturerId: 'm1',
    name: '3M',
    lookupKey: '3m',
    isActive: true,
    updatedAt: '2026-03-21T00:00:00Z'
  }
];

const sampleStockRows = [
  {
    warehouse: 'IL1',
    productId: 'p1',
    manufacturerId: 'm1',
    manufacturer: '3M',
    productName: '995 White',
    productCode: '995-W',
    tubesPerCase: 16,
    tubesOnHand: 33,
    casesOnHand: 2,
    looseTubes: 1,
    updatedAt: '2026-03-21T00:00:00Z',
    updatedBy: 'tester'
  }
];

function renderCaulkInventory() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity
      }
    }
  });

  queryClient.setQueryData(['caulk', 'manufacturers'], sampleManufacturers);
  queryClient.setQueryData(['caulk', 'stock', 'ALL', '', ''], sampleStockRows);

  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <CaulkInventoryContent />
    </QueryClientProvider>
  );

  queryClient.clear();
  return html;
}

function tableHeaders(html: string) {
  return Array.from(html.matchAll(/<th>(.*?)<\/th>/g)).map((match) => match[1]);
}

describe('CaulkInventoryContent', () => {
  beforeEach(() => {
    useWarehouseRegistryMock.mockReturnValue({
      entries: [{ code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' }]
    });
    listCaulkManufacturersMock.mockResolvedValue(sampleManufacturers);
    listCaulkStockMock.mockResolvedValue(sampleStockRows);
  });

  it('shows stock-only caulk content and removes operational sections', () => {
    const html = renderCaulkInventory();

    expect(html).toContain('Caulk Inventory');
    expect(html).toContain('Stock');
    expect(html).not.toContain('Receive / Use / Adjust');
    expect(html).not.toContain('Transfer');
    expect(html).not.toContain('Product Setup');
    expect(html).not.toContain('Owner Manufacturer Management');
    expect(html).not.toContain('Transactions');
  });

  it('renders stock table headers in exact order without a code column', () => {
    const html = renderCaulkInventory();

    expect(tableHeaders(html)).toEqual([
      'WAREHOUSE',
      'MANUFACTURER',
      'PRODUCT',
      'TUBES',
      'CASES'
    ]);
    expect(html).not.toContain('<th>Code</th>');
    expect(html).not.toContain('<th>CODE</th>');
  });
});
