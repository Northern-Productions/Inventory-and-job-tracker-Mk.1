import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WarehouseSelectField } from './WarehouseSelectField';

const useAuthMock = vi.fn();
const useWarehouseRegistryMock = vi.fn();

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => useAuthMock()
}));

vi.mock('../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => useWarehouseRegistryMock(),
  warehouseRegistryQueryKey: ['warehouses']
}));

vi.mock('../../../api/client', () => ({
  addWarehouse: vi.fn()
}));

function renderWarehouseField(props: Partial<ComponentProps<typeof WarehouseSelectField>> = {}) {
  const queryClient = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <WarehouseSelectField
        value="IL1"
        onChange={() => {}}
        {...props}
      />
    </QueryClientProvider>
  );
  queryClient.clear();
  return html;
}

function optionLabels(html: string) {
  return Array.from(html.matchAll(/<option[^>]*>(.*?)<\/option>/g)).map((match) => match[1]);
}

describe('WarehouseSelectField', () => {
  beforeEach(() => {
    useWarehouseRegistryMock.mockReturnValue({
      entries: [
        { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
        { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
      ]
    });
  });

  it('shows owner add option as the final entry for filter dropdowns', () => {
    useAuthMock.mockReturnValue({ isOwner: true });

    const html = renderWarehouseField({
      value: '',
      allowAll: true
    });

    expect(optionLabels(html)).toEqual([
      'All',
      'Wauconda IL1',
      'Ridgeland MS1',
      'Add New Warehouse...'
    ]);
  });

  it('hides owner add option for non-owners', () => {
    useAuthMock.mockReturnValue({ isOwner: false });

    const html = renderWarehouseField({
      value: '',
      allowAll: true
    });

    expect(optionLabels(html)).toEqual([
      'All',
      'Wauconda IL1',
      'Ridgeland MS1'
    ]);
    expect(html).not.toContain('Add New Warehouse...');
  });
});
