import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { inventoryKeys } from './inventoryQueryKeys';
import {
  beginDelayedOptimisticMutation,
  createOptimisticFilmOrderFromPayload,
  createOptimisticJobDetailFromCreatePayload,
  restoreSnapshots,
  upsertFilmOrdersCache
} from './inventoryMutationUtils';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false
      }
    }
  });
}

describe('inventoryMutationUtils', () => {
  it('applies delayed optimistic mutations immediately and can restore snapshots on failure', () => {
    const queryClient = createQueryClient();
    const apply = vi.fn(() => {
      queryClient.setQueryData(inventoryKeys.job('12345'), { state: 'after' });
    });
    const optimisticQueue = {
      begin: vi.fn()
    };

    queryClient.setQueryData(inventoryKeys.job('12345'), { state: 'before' });

    const context = beginDelayedOptimisticMutation(
      queryClient,
      optimisticQueue,
      'Saving 12345',
      [inventoryKeys.job('12345')],
      apply
    );

    expect(apply).toHaveBeenCalledOnce();
    expect(optimisticQueue.begin).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(inventoryKeys.job('12345'))).toEqual({ state: 'after' });

    restoreSnapshots(queryClient, context.snapshots);

    expect(queryClient.getQueryData(inventoryKeys.job('12345'))).toEqual({ state: 'before' });
  });

  it('builds optimistic job details with required film and caulk totals', () => {
    const detail = createOptimisticJobDetailFromCreatePayload(
      {
        jobNumber: '18798',
        warehouse: 'IL1',
        sections: '99',
        dueDate: '2026-03-30',
        crewLeader: 'Napo',
        requirements: [
          {
            manufacturer: '3M',
            filmName: 'Dusted Crystal',
            widthIn: 60,
            requiredFeet: 44
          }
        ],
        caulkRequirements: [
          {
            productId: 'dow-995',
            requiredTubes: 58
          }
        ]
      },
      [
        {
          productId: 'dow-995',
          manufacturerId: 'dow',
          manufacturer: 'DOW',
          productName: '995 Black',
          productCode: 'DOW-995',
          lookupKey: 'dow-995-black',
          tubesPerCase: 16,
          isActive: true,
          notes: '',
          updatedAt: '2026-03-23T00:00:00Z'
        }
      ]
    );

    expect(detail.summary.status).toBe('ALLOCATE');
    expect(detail.summary.requiredFeet).toBe(44);
    expect(detail.summary.remainingFeet).toBe(44);
    expect(detail.summary.requiredTubes).toBe(58);
    expect(detail.summary.remainingTubes).toBe(58);
    expect(detail.requirements).toHaveLength(1);
    expect(detail.caulkRequirements).toHaveLength(1);
    expect(detail.caulkRequirements[0].manufacturer).toBe('DOW');
    expect(detail.caulkRequirements[0].productName).toBe('995 Black');
    expect(detail.caulkRequirements[0].tubesPerCase).toBe(16);
  });

  it('creates and stores optimistic film orders for immediate UI updates', () => {
    const queryClient = createQueryClient();
    const optimisticFilmOrder = createOptimisticFilmOrderFromPayload({
      jobNumber: '18798',
      warehouse: 'IL1',
      manufacturer: '3M',
      filmName: 'Dusted Crystal',
      widthIn: 60,
      requestedFeet: 120
    });

    upsertFilmOrdersCache(queryClient, optimisticFilmOrder);

    expect(optimisticFilmOrder.filmOrderId.startsWith('pending-film-order-')).toBe(true);
    expect(optimisticFilmOrder.status).toBe('FILM_ORDER');
    expect(optimisticFilmOrder.remainingToOrderFeet).toBe(120);
    expect(queryClient.getQueryData(inventoryKeys.filmOrders)).toEqual([optimisticFilmOrder]);
  });
});
