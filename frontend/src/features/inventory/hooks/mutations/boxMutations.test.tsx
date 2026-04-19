// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inventoryKeys } from '../inventoryQueryKeys';
import { useUpsertBoxDealer } from './boxMutations';

const upsertBoxDealerMock = vi.fn();

vi.mock('../../../../api/features/inventoryClient', async () => {
  const actual = await vi.importActual<typeof import('../../../../api/features/inventoryClient')>(
    '../../../../api/features/inventoryClient'
  );

  return {
    ...actual,
    upsertBoxDealer: (...args: unknown[]) => upsertBoxDealerMock(...args)
  };
});

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false
      },
      mutations: {
        retry: false
      }
    }
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

describe('useUpsertBoxDealer', () => {
  afterEach(() => {
    upsertBoxDealerMock.mockReset();
    vi.restoreAllMocks();
  });

  it('resolves mutateAsync without waiting for the dealer-list refetch to finish', async () => {
    const queryClient = createQueryClient();
    const invalidateDeferred = createDeferred<void>();

    upsertBoxDealerMock.mockResolvedValue({
      dealerId: 'dealer-accent',
      name: 'Accent',
      lookupKey: 'accent',
      updatedAt: '2026-04-19T02:30:00Z'
    });
    vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(
      () => invalidateDeferred.promise as ReturnType<QueryClient['invalidateQueries']>
    );

    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useUpsertBoxDealer(), { wrapper });
    const mutationResult = result.current.mutateAsync({ name: 'Accent' });
    const settled = await Promise.race([
      mutationResult.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 50))
    ]);

    expect(settled).toBe('resolved');
    expect(queryClient.getQueryData(inventoryKeys.boxDealers)).toEqual([
      {
        dealerId: 'dealer-accent',
        name: 'Accent',
        lookupKey: 'accent',
        updatedAt: '2026-04-19T02:30:00Z'
      }
    ]);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: inventoryKeys.boxDealers
    });

    invalidateDeferred.resolve();
    await mutationResult;
  });
});
