import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { inventoryKeys } from './inventoryQueryKeys';
import {
  beginDelayedOptimisticMutation,
  computeOptimisticJobStatus,
  createOptimisticFilmOrderFromPayload,
  createOptimisticJobDetailFromCreatePayload,
  restoreSnapshots,
  syncJobDetailCaches,
  upsertJobsCalendarCaches,
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

  it('only treats zero-material optimistic jobs as ready when labor-only is explicit', () => {
    expect(computeOptimisticJobStatus(0, 0)).toBe('ALLOCATE');
    expect(computeOptimisticJobStatus(0, 0, 0, true)).toBe('READY');

    const detail = createOptimisticJobDetailFromCreatePayload({
      jobNumber: '4644',
      warehouse: 'IL1',
      sections: '1',
      dueDate: '2026-03-31',
      crewLeader: 'Napo',
      requirements: [],
      caulkRequirements: [],
      isLaborOnly: true
    });

    expect(detail.summary.isLaborOnly).toBe(true);
    expect(detail.summary.isStagedForPickup).toBe(true);
    expect(detail.summary.status).toBe('READY');
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

  it('updates matching calendar caches with the latest job summary', () => {
    const queryClient = createQueryClient();
    const existingEntry = {
      jobNumber: '18798',
      warehouse: 'IL1',
      sections: '99',
      dueDate: '2026-03-30',
      crewLeader: 'Napo',
      status: 'ALLOCATE' as const,
      lifecycleStatus: 'ACTIVE' as const,
      isLaborOnly: false,
      isStagedForPickup: false,
      requiredFeet: 0,
      allocatedFeet: 0,
      remainingFeet: 0,
      requiredTubes: 44,
      allocatedTubes: 0,
      remainingTubes: 44,
      requirementCount: 0,
      allocationCount: 0,
      filmOrderCount: 0,
      createdAt: '2026-03-23T00:00:00Z',
      updatedAt: '2026-03-23T00:00:00Z',
      notes: ''
    };

    queryClient.setQueryData(
      inventoryKeys.jobsCalendarPeriod({
        view: 'week',
        anchorDate: '2026-03-29',
        lifecycleStatus: 'ACTIVE'
      }),
      [existingEntry]
    );

    upsertJobsCalendarCaches(queryClient, {
      ...existingEntry,
      status: 'READY',
      isStagedForPickup: true,
      allocatedTubes: 44,
      remainingTubes: 0,
      updatedAt: '2026-03-27T12:23:01Z'
    });

    expect(
      queryClient.getQueryData(
        inventoryKeys.jobsCalendarPeriod({
          view: 'week',
          anchorDate: '2026-03-29',
          lifecycleStatus: 'ACTIVE'
        })
      )
    ).toEqual([
      {
        ...existingEntry,
        status: 'READY',
        isStagedForPickup: true,
        allocatedTubes: 44,
        remainingTubes: 0,
        updatedAt: '2026-03-27T12:23:01Z'
      }
    ]);
  });

  it('syncs job detail summaries into job and allocation caches', () => {
    const queryClient = createQueryClient();
    const detail = createOptimisticJobDetailFromCreatePayload(
      {
        jobNumber: '18798',
        warehouse: 'IL1',
        sections: '99',
        dueDate: '2026-03-30',
        crewLeader: 'Napo',
        requirements: [],
        caulkRequirements: [
          {
            productId: 'dow-995',
            requiredTubes: 44
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

    queryClient.setQueryData(inventoryKeys.allocationJob('18798'), {
      summary: {
        jobNumber: '18798',
        jobDate: '',
        crewLeader: '',
        status: 'ALLOCATE',
        activeAllocatedFeet: 0,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 0,
        boxCount: 0
      },
      allocations: [],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    });
    queryClient.setQueryData(inventoryKeys.allocationJobs, []);

    syncJobDetailCaches(queryClient, {
      ...detail,
      summary: {
        ...detail.summary,
        status: 'READY',
        allocatedTubes: 44,
        remainingTubes: 0
      },
      caulkRequirements: detail.caulkRequirements.map((entry) => ({
        ...entry,
        allocatedTubes: 44,
        remainingTubes: 0
      }))
    }, { syncAllocationJobDetail: true });

    expect(queryClient.getQueryData(inventoryKeys.job('18798'))).toMatchObject({
      summary: {
        jobNumber: '18798',
        status: 'READY',
        allocatedTubes: 44,
        remainingTubes: 0
      }
    });
    expect(queryClient.getQueryData(inventoryKeys.allocationJobs)).toEqual([
      {
        jobNumber: '18798',
        jobDate: '2026-03-30',
        crewLeader: 'Napo',
        status: 'READY',
        activeAllocatedFeet: 0,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 44,
        allocatedTubes: 44,
        remainingTubes: 0,
        openFilmOrderCount: 0,
        boxCount: 0
      }
    ]);
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('18798'))).toMatchObject({
      summary: {
        jobDate: '2026-03-30',
        crewLeader: 'Napo',
        status: 'READY',
        requiredTubes: 44,
        allocatedTubes: 44,
        remainingTubes: 0
      },
      caulkRequirements: [
        expect.objectContaining({
          allocatedTubes: 44,
          remainingTubes: 0
        })
      ]
    });
  });
});
