// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useCaulkProducts } from './useInventoryQueries';

const listCaulkProductsMock = vi.fn();

vi.mock('../../../api/features/caulkClient', () => ({
  listCaulkProducts: (...args: unknown[]) => listCaulkProductsMock(...args)
}));

function TestProbe() {
  const query = useCaulkProducts();

  if (query.isLoading) {
    return <div>loading</div>;
  }

  return <div>{String(query.data?.length || 0)}</div>;
}

function renderProbe(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TestProbe />
    </QueryClientProvider>
  );
}

describe('useCaulkProducts', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    listCaulkProductsMock.mockReset();
    listCaulkProductsMock.mockResolvedValue([
      {
        productId: 'p1',
        manufacturerId: 'm1',
        manufacturer: 'DOW',
        productName: '790 Black',
        productCode: '790-BLK',
        lookupKey: 'dow-790-black',
        tubesPerCase: 12,
        isActive: true,
        notes: '',
        updatedAt: '2026-03-20T00:00:00Z'
      }
    ]);
  });

  it('reuses cached caulk products across immediate remounts', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false
        }
      }
    });

    const firstView = renderProbe(queryClient);

    await screen.findByText('1');
    expect(listCaulkProductsMock).toHaveBeenCalledTimes(1);

    firstView.unmount();
    renderProbe(queryClient);

    await waitFor(() => {
      expect(screen.getByText('1')).toBeTruthy();
    });
    expect(listCaulkProductsMock).toHaveBeenCalledTimes(1);

    queryClient.clear();
  });
});
