// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OptimisticQueueProvider } from '../../../../components/OptimisticQueue';
import type { Box } from '../../../../domain';
import { inventoryKeys } from '../inventoryQueryKeys';
import { useReceiveOrderedBox, useUpsertBoxDealer } from './boxMutations';

const upsertBoxDealerMock = vi.fn();
const receiveOrderedBoxMock = vi.fn();

vi.mock('../../../../api/features/inventoryClient', async () => {
  const actual = await vi.importActual<typeof import('../../../../api/features/inventoryClient')>(
    '../../../../api/features/inventoryClient'
  );

  return {
    ...actual,
    receiveOrderedBox: (...args: unknown[]) => receiveOrderedBoxMock(...args),
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

function createWrapper(queryClient: QueryClient) {
  return ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>
      <OptimisticQueueProvider>{children}</OptimisticQueueProvider>
    </QueryClientProvider>
  );
}

function buildBox(overrides: Partial<Box> = {}): Box {
  return {
    boxId: 'IL1-OPT',
    warehouse: 'IL1',
    dealer: '',
    manufacturer: '3M',
    filmName: 'Ultra 70',
    widthIn: 48,
    initialFeet: 100,
    feetAvailable: 0,
    allocationPlanningFeet: 100,
    lotRun: '',
    status: 'ORDERED',
    orderDate: '2026-04-20',
    receivedDate: '',
    initialWeightLbs: null,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    filmKey: '3m-ultra-70',
    coreType: '',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    pricePerLf: null,
    purchaseCost: null,
    notes: '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: '',
    ...overrides
  };
}

describe('useUpsertBoxDealer', () => {
  afterEach(() => {
    upsertBoxDealerMock.mockReset();
    receiveOrderedBoxMock.mockReset();
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

    const { result } = renderHook(() => useUpsertBoxDealer(), { wrapper: createWrapper(queryClient) });
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

describe('useReceiveOrderedBox', () => {
  afterEach(() => {
    upsertBoxDealerMock.mockReset();
    receiveOrderedBoxMock.mockReset();
    vi.restoreAllMocks();
  });

  it('optimistically applies submitted core type and derived core weight', async () => {
    const queryClient = createQueryClient();
    const box = buildBox();
    const response = createDeferred<{ result: { box: Box; logId: string }; warnings: string[] }>();
    queryClient.setQueryData(inventoryKeys.box(box.boxId), box);
    receiveOrderedBoxMock.mockReturnValue(response.promise);

    const { result } = renderHook(() => useReceiveOrderedBox(), { wrapper: createWrapper(queryClient) });
    let mutationResult!: Promise<unknown>;

    act(() => {
      mutationResult = result.current.mutateAsync({
        boxId: box.boxId,
        coreType: 'Red plastic'
      });
    });

    await waitFor(() => {
      expect(queryClient.getQueryData<Box>(inventoryKeys.box(box.boxId))).toMatchObject({
        status: 'IN_STOCK',
        coreType: 'Red plastic',
        coreWeightLbs: 1.2333
      });
    });

    response.resolve({
      result: {
        box: {
          ...box,
          status: 'IN_STOCK',
          receivedDate: '2026-04-21',
          coreType: 'Red plastic',
          coreWeightLbs: 1.2333
        },
        logId: 'log-1'
      },
      warnings: []
    });

    await mutationResult;
  });
});
