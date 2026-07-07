// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WarehouseEntry } from '../../../domain';
import { useWarehouseRegistry } from './useWarehouseRegistry';

const listWarehousesMock = vi.fn<() => Promise<WarehouseEntry[]>>();

vi.mock('../../../api/features/warehouseClient', () => ({
  listWarehouses: () => listWarehousesMock()
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false
      }
    }
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  return {
    Wrapper,
    queryClient
  };
}

describe('useWarehouseRegistry', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses current-org warehouse rows without injecting internal IL1/MS1 defaults', async () => {
    listWarehousesMock.mockResolvedValue([
      { code: 'MI1', name: 'Auburn Hills', boxIdPrefix: 'MI1' }
    ]);
    const { Wrapper, queryClient } = createWrapper();

    const { result } = renderHook(() => useWarehouseRegistry(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.code)).toEqual(['MI1']);
    });
    expect(result.current.entries[0]?.name).toBe('Auburn Hills');
    queryClient.clear();
  });

  it('returns safe empty entries for an org with no warehouses', async () => {
    listWarehousesMock.mockResolvedValue([]);
    const { Wrapper, queryClient } = createWrapper();

    const { result } = renderHook(() => useWarehouseRegistry(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.entries).toEqual([]);
    });
    queryClient.clear();
  });

  it('still displays existing internal warehouse rows when the org returns them', async () => {
    listWarehousesMock.mockResolvedValue([
      { code: 'MO1', name: 'St. Louis MO1', boxIdPrefix: 'MO1' },
      { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' },
      { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' }
    ]);
    const { Wrapper, queryClient } = createWrapper();

    const { result } = renderHook(() => useWarehouseRegistry(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.code)).toEqual(['IL1', 'MS1', 'MO1']);
    });
    queryClient.clear();
  });
});
