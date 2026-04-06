import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { inventoryKeys } from './inventoryQueryKeys';
import {
  applyOptimisticAllocationAdditionToCaches,
  applyOptimisticAllocationRemovalToCaches,
  beginDelayedOptimisticMutation,
  computeOptimisticJobStatus,
  createOptimisticFilmOrderFromPayload,
  createOptimisticJobDetailAfterAllocationAddition,
  createOptimisticJobDetailAfterAllocationRemoval,
  createOptimisticJobDetailFromCreatePayload,
  removeJobPlanningCaches,
  restoreSnapshots,
  syncJobDetailCaches,
  syncJobSummaryCachesFromDetail,
  updateBoxCaches,
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

  it('removes deleted jobs from list, calendar, search, summary, detail, and film-order caches', () => {
    const queryClient = createQueryClient();
    const activeEntry = {
      jobNumber: '555555555',
      warehouse: 'IL1',
      sections: '1',
      dueDate: '2026-04-03',
      crewLeader: 'Crew',
      status: 'READY' as const,
      lifecycleStatus: 'ACTIVE' as const,
      isLaborOnly: false,
      isStagedForPickup: false,
      requiredFeet: 10,
      allocatedFeet: 10,
      remainingFeet: 0,
      requiredTubes: 0,
      allocatedTubes: 0,
      remainingTubes: 0,
      requirementCount: 1,
      allocationCount: 1,
      filmOrderCount: 1,
      createdAt: '2026-04-02T00:00:00Z',
      updatedAt: '2026-04-02T00:00:00Z',
      notes: ''
    };
    const completedEntry = {
      ...activeEntry,
      lifecycleStatus: 'COMPLETED' as const,
      status: 'COMPLETED' as const
    };

    queryClient.setQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }), [
      activeEntry
    ]);
    queryClient.setQueryData(
      inventoryKeys.jobsCalendarPeriod({
        view: 'week',
        anchorDate: '2026-03-29',
        lifecycleStatus: 'ACTIVE'
      }),
      [activeEntry]
    );
    queryClient.setQueryData(
      inventoryKeys.jobsCalendarPeriod({
        view: 'month',
        anchorDate: '2026-04-01',
        lifecycleStatus: 'ACTIVE'
      }),
      [activeEntry]
    );
    queryClient.setQueryData(
      inventoryKeys.jobsSearchResults({
        query: '555555555',
        limit: 1,
        lifecycleStatus: 'ACTIVE'
      }),
      [activeEntry]
    );
    queryClient.setQueryData(
      inventoryKeys.jobsSearchResults({
        query: '555555555',
        limit: 1,
        lifecycleStatus: 'COMPLETED'
      }),
      [completedEntry]
    );
    queryClient.setQueryData(inventoryKeys.allocationJobs, [
      {
        jobNumber: '555555555',
        jobDate: '2026-04-03',
        crewLeader: 'Crew',
        status: 'READY',
        activeAllocatedFeet: 10,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 1,
        boxCount: 1
      }
    ]);
    queryClient.setQueryData(inventoryKeys.job('555555555'), {
      summary: activeEntry,
      requirements: [],
      allocations: [],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    });
    queryClient.setQueryData(inventoryKeys.allocationJob('555555555'), {
      summary: {
        jobNumber: '555555555',
        jobDate: '2026-04-03',
        crewLeader: 'Crew',
        status: 'READY',
        activeAllocatedFeet: 10,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 1,
        boxCount: 1
      },
      allocations: [],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    });
    queryClient.setQueryData(inventoryKeys.filmOrders, [
      {
        filmOrderId: 'film-order-1',
        jobNumber: '555555555',
        warehouse: 'IL1',
        manufacturer: '3M',
        filmName: 'Ultra 70',
        widthIn: 48,
        requestedFeet: 10,
        coveredFeet: 0,
        orderedFeet: 0,
        remainingToOrderFeet: 10,
        jobDate: '2026-04-03',
        crewLeader: 'Crew',
        status: 'FILM_ORDER',
        sourceBoxId: '',
        createdAt: '2026-04-02T00:00:00Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        notes: '',
        linkedBoxes: []
      }
    ]);

    removeJobPlanningCaches(queryClient, '555555555');

    expect(
      queryClient.getQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }))
    ).toEqual([]);
    expect(
      queryClient.getQueryData(
        inventoryKeys.jobsCalendarPeriod({
          view: 'week',
          anchorDate: '2026-03-29',
          lifecycleStatus: 'ACTIVE'
        })
      )
    ).toEqual([]);
    expect(
      queryClient.getQueryData(
        inventoryKeys.jobsSearchResults({
          query: '555555555',
          limit: 1,
          lifecycleStatus: 'ACTIVE'
        })
      )
    ).toEqual([]);
    expect(queryClient.getQueryData(inventoryKeys.allocationJobs)).toEqual([]);
    expect(queryClient.getQueryData(inventoryKeys.job('555555555'))).toBeUndefined();
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('555555555'))).toBeUndefined();
    expect(queryClient.getQueryData(inventoryKeys.filmOrders)).toEqual([]);
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

  it('hydrates deliberately stale 18959 job summary collection caches from a fresh job detail read', () => {
    const queryClient = createQueryClient();
    const staleSummary = {
      jobNumber: '18959',
      warehouse: 'IL1',
      sections: '1',
      dueDate: '',
      crewLeader: '',
      status: 'ALLOCATE' as const,
      lifecycleStatus: 'ACTIVE' as const,
      isLaborOnly: false,
      isStagedForPickup: false,
      requiredFeet: 34,
      allocatedFeet: 12,
      remainingFeet: 22,
      requiredTubes: 0,
      allocatedTubes: 0,
      remainingTubes: 0,
      requirementCount: 3,
      allocationCount: 2,
      filmOrderCount: 0,
      createdAt: '2026-04-03T17:19:35.984Z',
      updatedAt: '2026-04-03T17:20:34.647Z',
      notes: ''
    };
    const freshDetail = {
      summary: {
        ...staleSummary,
        crewLeader: 'Crew',
        status: 'ALLOCATE' as const,
        allocatedFeet: 32,
        remainingFeet: 2,
        allocationCount: 3,
        updatedAt: '2026-04-06T07:03:32.372Z'
      },
      requirements: [
        {
          requirementId: 'req-72',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 72,
          requiredFeet: 12,
          allocatedFeet: 10,
          remainingFeet: 2
        },
        {
          requirementId: 'req-50',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 50,
          requiredFeet: 2,
          allocatedFeet: 2,
          remainingFeet: 0
        },
        {
          requirementId: 'req-fasara',
          manufacturer: '3M Fasara',
          filmName: 'Milano Milky White SH2MAML',
          widthIn: 50,
          requiredFeet: 20,
          allocatedFeet: 20,
          remainingFeet: 0
        }
      ],
      allocations: [
        {
          allocationId: 'alloc-1',
          boxId: 'IL1-6076',
          warehouse: 'IL1',
          manufacturer: '3M Fasara',
          filmName: 'Milano Milky White SH2MAML',
          widthIn: 60,
          allocatedFeet: 20,
          jobNumber: '18959',
          jobDate: '',
          crewLeader: 'Crew',
          status: 'ACTIVE' as const,
          createdAt: '2026-04-03T17:19:35.984Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          notes: '',
          filmOrderId: '',
          requirementId: 'req-fasara',
          allocationKind: 'REQUIREMENT' as const,
          boxStatus: 'IN_STOCK' as const,
          checkedOutOnThisJob: false
        },
        {
          allocationId: 'alloc-2',
          boxId: 'IL1-6502',
          warehouse: 'IL1',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 72,
          allocatedFeet: 2,
          jobNumber: '18959',
          jobDate: '',
          crewLeader: 'Crew',
          status: 'ACTIVE' as const,
          createdAt: '2026-04-06T07:03:24.227Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          notes: '',
          filmOrderId: '',
          requirementId: 'req-50',
          allocationKind: 'REQUIREMENT' as const,
          boxStatus: 'IN_STOCK' as const,
          checkedOutOnThisJob: false
        },
        {
          allocationId: 'alloc-3',
          boxId: 'IL1-6502',
          warehouse: 'IL1',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 72,
          allocatedFeet: 10,
          jobNumber: '18959',
          jobDate: '',
          crewLeader: 'Crew',
          status: 'ACTIVE' as const,
          createdAt: '2026-04-06T07:03:32.372Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          notes: '',
          filmOrderId: '',
          requirementId: 'req-72',
          allocationKind: 'REQUIREMENT' as const,
          boxStatus: 'IN_STOCK' as const,
          checkedOutOnThisJob: false
        }
      ],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    };

    queryClient.setQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }), [
      staleSummary
    ]);
    queryClient.setQueryData(
      inventoryKeys.jobsCalendarPeriod({
        view: 'week',
        anchorDate: '2026-04-05',
        lifecycleStatus: 'ACTIVE'
      }),
      [staleSummary]
    );
    queryClient.setQueryData(inventoryKeys.allocationJobs, [
      {
        jobNumber: '18959',
        jobDate: '',
        crewLeader: '',
        status: 'ALLOCATE',
        activeAllocatedFeet: 12,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 0,
        boxCount: 1
      }
    ]);
    queryClient.setQueryData(inventoryKeys.allocationJob('18959'), {
      summary: {
        jobNumber: '18959',
        jobDate: '',
        crewLeader: '',
        status: 'ALLOCATE',
        activeAllocatedFeet: 12,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 0,
        boxCount: 1
      },
      allocations: [],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    });

    syncJobSummaryCachesFromDetail(queryClient, freshDetail, { syncAllocationJobDetail: true });

    expect(queryClient.getQueryData(inventoryKeys.job('18959'))).toBeUndefined();
    expect(
      queryClient.getQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }))
    ).toEqual([freshDetail.summary]);
    expect(
      queryClient.getQueryData(
        inventoryKeys.jobsCalendarPeriod({
          view: 'week',
          anchorDate: '2026-04-05',
          lifecycleStatus: 'ACTIVE'
        })
      )
    ).toEqual([freshDetail.summary]);
    expect(queryClient.getQueryData(inventoryKeys.allocationJobs)).toEqual([
      {
        jobNumber: '18959',
        jobDate: '',
        crewLeader: 'Crew',
        status: 'ALLOCATE',
        activeAllocatedFeet: 32,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 0,
        boxCount: 2
      }
    ]);
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('18959'))).toMatchObject({
      summary: {
        jobNumber: '18959',
        crewLeader: 'Crew',
        status: 'ALLOCATE',
        activeAllocatedFeet: 32,
        boxCount: 2
      },
      caulkRequirements: [],
      filmOrders: []
    });
  });

  it('safely skips read-side job summary hydration when collection caches are absent', () => {
    const queryClient = createQueryClient();
    const detail = createOptimisticJobDetailFromCreatePayload({
      jobNumber: '19000',
      warehouse: 'IL1',
      sections: '1',
      dueDate: '2026-04-06',
      crewLeader: 'Crew',
      requirements: [
        {
          manufacturer: '3M',
          filmName: 'Dusted Crystal',
          widthIn: 48,
          requiredFeet: 8
        }
      ]
    });

    expect(() =>
      syncJobSummaryCachesFromDetail(queryClient, {
        ...detail,
        summary: {
          ...detail.summary,
          status: 'READY',
          allocatedFeet: 8,
          remainingFeet: 0
        },
        requirements: detail.requirements.map((entry) => ({
          ...entry,
          allocatedFeet: 8,
          remainingFeet: 0
        }))
      })
    ).not.toThrow();
    expect(queryClient.getQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }))).toBeUndefined();
    expect(queryClient.getQueryData(inventoryKeys.allocationJobs)).toBeUndefined();
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('19000'))).toBeUndefined();
  });

  it('recomputes requirement coverage after removing an allocation', () => {
    const detail = {
      summary: {
        jobNumber: '555',
        warehouse: 'IL1',
        sections: null,
        dueDate: '2026-04-02',
        crewLeader: 'Crew',
        status: 'READY' as const,
        lifecycleStatus: 'ACTIVE' as const,
        isLaborOnly: false,
        isStagedForPickup: false,
        requiredFeet: 20,
        allocatedFeet: 20,
        remainingFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        requirementCount: 1,
        allocationCount: 2,
        filmOrderCount: 0,
        createdAt: '2026-04-02T00:00:00Z',
        updatedAt: '2026-04-02T00:00:00Z',
        notes: ''
      },
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: '3M',
          filmName: 'Safety Shield',
          widthIn: 48,
          requiredFeet: 20,
          allocatedFeet: 20,
          remainingFeet: 0
        }
      ],
      allocations: [
        {
          allocationId: 'alloc-1',
          boxId: 'IL1-6552',
          warehouse: 'IL1',
          jobNumber: '555',
          jobDate: '2026-04-02',
          crewLeader: 'Crew',
          allocatedFeet: 11,
          allocationKind: 'REQUIREMENT' as const,
          status: 'ACTIVE' as const,
          createdAt: '2026-04-02T00:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M',
          filmName: 'Safety Shield',
          widthIn: 48,
          boxStatus: 'IN_STOCK' as const,
          checkedOutOnThisJob: false
        },
        {
          allocationId: 'alloc-2',
          boxId: 'IL1-5973',
          warehouse: 'IL1',
          jobNumber: '555',
          jobDate: '2026-04-02',
          crewLeader: 'Crew',
          allocatedFeet: 9,
          allocationKind: 'REQUIREMENT' as const,
          status: 'ACTIVE' as const,
          createdAt: '2026-04-02T00:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M',
          filmName: 'Safety Shield',
          widthIn: 48,
          boxStatus: 'IN_STOCK' as const,
          checkedOutOnThisJob: false
        }
      ],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    };

    const { detail: nextDetail, removedAllocation } = createOptimisticJobDetailAfterAllocationRemoval(
      detail,
      'alloc-1'
    );

    expect(removedAllocation?.boxId).toBe('IL1-6552');
    expect(nextDetail.allocations).toHaveLength(1);
    expect(nextDetail.summary.status).toBe('ALLOCATE');
    expect(nextDetail.summary.allocatedFeet).toBe(9);
    expect(nextDetail.summary.remainingFeet).toBe(11);
    expect(nextDetail.summary.allocationCount).toBe(1);
    expect(nextDetail.requirements).toEqual([
      {
        requirementId: 'req-1',
        manufacturer: '3M',
        filmName: 'Safety Shield',
        widthIn: 48,
        requiredFeet: 20,
        allocatedFeet: 9,
        remainingFeet: 11
      }
    ]);
  });

  it('preserves film-order status when a covered job becomes short again after allocation removal', () => {
    const detail = {
      summary: {
        jobNumber: '555',
        warehouse: 'IL1',
        sections: null,
        dueDate: '2026-04-02',
        crewLeader: 'Crew',
        status: 'READY' as const,
        lifecycleStatus: 'ACTIVE' as const,
        isLaborOnly: false,
        isStagedForPickup: false,
        requiredFeet: 20,
        allocatedFeet: 20,
        remainingFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        requirementCount: 1,
        allocationCount: 2,
        filmOrderCount: 1,
        createdAt: '2026-04-02T00:00:00Z',
        updatedAt: '2026-04-02T00:00:00Z',
        notes: ''
      },
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: '3M',
          filmName: 'Safety Shield',
          widthIn: 48,
          requiredFeet: 20,
          allocatedFeet: 20,
          remainingFeet: 0
        }
      ],
      allocations: [
        {
          allocationId: 'alloc-1',
          boxId: 'IL1-6552',
          warehouse: 'IL1',
          jobNumber: '555',
          jobDate: '2026-04-02',
          crewLeader: 'Crew',
          allocatedFeet: 11,
          allocationKind: 'REQUIREMENT' as const,
          status: 'ACTIVE' as const,
          createdAt: '2026-04-02T00:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M',
          filmName: 'Safety Shield',
          widthIn: 48,
          boxStatus: 'IN_STOCK' as const,
          checkedOutOnThisJob: false
        },
        {
          allocationId: 'alloc-2',
          boxId: 'IL1-5973',
          warehouse: 'IL1',
          jobNumber: '555',
          jobDate: '2026-04-02',
          crewLeader: 'Crew',
          allocatedFeet: 9,
          allocationKind: 'REQUIREMENT' as const,
          status: 'ACTIVE' as const,
          createdAt: '2026-04-02T00:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M',
          filmName: 'Safety Shield',
          widthIn: 48,
          boxStatus: 'IN_STOCK' as const,
          checkedOutOnThisJob: false
        }
      ],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: [
        {
          filmOrderId: 'film-order-1',
          jobNumber: '555',
          warehouse: 'IL1',
          manufacturer: '3M',
          filmName: 'Safety Shield',
          widthIn: 48,
          requestedFeet: 11,
          coveredFeet: 0,
          orderedFeet: 0,
          remainingToOrderFeet: 11,
          jobDate: '2026-04-02',
          crewLeader: 'Crew',
          status: 'FILM_ORDER' as const,
          sourceBoxId: '',
          createdAt: '2026-04-02T00:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          notes: '',
          linkedBoxes: []
        }
      ]
    };

    const { detail: nextDetail } = createOptimisticJobDetailAfterAllocationRemoval(detail, 'alloc-1');

    expect(nextDetail.summary.status).toBe('FILM_ORDER');
    expect(nextDetail.summary.remainingFeet).toBe(11);
  });

  it('keeps bound mixed-width allocations credited to their intended requirement lines', () => {
    const detail = {
      summary: {
        jobNumber: '29001',
        warehouse: 'IL1',
        sections: null,
        dueDate: '2026-04-03',
        crewLeader: 'Crew',
        status: 'ALLOCATE' as const,
        lifecycleStatus: 'ACTIVE' as const,
        isLaborOnly: false,
        isStagedForPickup: false,
        requiredFeet: 14,
        allocatedFeet: 12,
        remainingFeet: 2,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        requirementCount: 2,
        allocationCount: 2,
        filmOrderCount: 0,
        createdAt: '2026-04-03T00:00:00Z',
        updatedAt: '2026-04-03T00:00:00Z',
        notes: ''
      },
      requirements: [
        {
          requirementId: 'req-50',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 50,
          requiredFeet: 2,
          allocatedFeet: 2,
          remainingFeet: 0
        },
        {
          requirementId: 'req-72',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 72,
          requiredFeet: 12,
          allocatedFeet: 10,
          remainingFeet: 2
        }
      ],
      allocations: [
        {
          allocationId: 'alloc-50',
          boxId: 'IL1-6502',
          warehouse: 'IL1',
          jobNumber: '29001',
          jobDate: '2026-04-03',
          crewLeader: 'Crew',
          allocatedFeet: 2,
          requirementId: 'req-50',
          allocationKind: 'REQUIREMENT' as const,
          status: 'ACTIVE' as const,
          createdAt: '2026-04-03T17:20:03.817Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 72,
          boxStatus: 'IN_STOCK' as const,
          checkedOutOnThisJob: false
        },
        {
          allocationId: 'alloc-72',
          boxId: 'IL1-6502',
          warehouse: 'IL1',
          jobNumber: '29001',
          jobDate: '2026-04-03',
          crewLeader: 'Crew',
          allocatedFeet: 10,
          requirementId: 'req-72',
          allocationKind: 'REQUIREMENT' as const,
          status: 'ACTIVE' as const,
          createdAt: '2026-04-03T17:20:34.647Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 72,
          boxStatus: 'IN_STOCK' as const,
          checkedOutOnThisJob: false
        }
      ],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    };

    const { detail: nextDetail } = createOptimisticJobDetailAfterAllocationRemoval(detail, 'alloc-50');

    expect(nextDetail.summary.allocatedFeet).toBe(10);
    expect(nextDetail.summary.remainingFeet).toBe(4);
    expect(nextDetail.requirements).toEqual([
      {
        requirementId: 'req-50',
        manufacturer: '3M Solar',
        filmName: 'Affinity 15',
        widthIn: 50,
        requiredFeet: 2,
        allocatedFeet: 0,
        remainingFeet: 2
      },
      {
        requirementId: 'req-72',
        manufacturer: '3M Solar',
        filmName: 'Affinity 15',
        widthIn: 72,
        requiredFeet: 12,
        allocatedFeet: 10,
        remainingFeet: 2
      }
    ]);
  });

  it('recomputes mixed-width requirement coverage after adding a bound optimistic allocation', () => {
    const detail = {
      summary: {
        jobNumber: '29002',
        warehouse: 'IL1',
        sections: null,
        dueDate: '2026-04-03',
        crewLeader: 'Crew',
        status: 'ALLOCATE' as const,
        lifecycleStatus: 'ACTIVE' as const,
        isLaborOnly: false,
        isStagedForPickup: false,
        requiredFeet: 14,
        allocatedFeet: 10,
        remainingFeet: 4,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        requirementCount: 2,
        allocationCount: 1,
        filmOrderCount: 0,
        createdAt: '2026-04-03T00:00:00Z',
        updatedAt: '2026-04-03T00:00:00Z',
        notes: ''
      },
      requirements: [
        {
          requirementId: 'req-50',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 50,
          requiredFeet: 2,
          allocatedFeet: 0,
          remainingFeet: 2
        },
        {
          requirementId: 'req-72',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 72,
          requiredFeet: 12,
          allocatedFeet: 10,
          remainingFeet: 2
        }
      ],
      allocations: [
        {
          allocationId: 'alloc-72',
          boxId: 'IL1-6502',
          warehouse: 'IL1',
          jobNumber: '29002',
          jobDate: '2026-04-03',
          crewLeader: 'Crew',
          allocatedFeet: 10,
          requirementId: 'req-72',
          allocationKind: 'REQUIREMENT' as const,
          status: 'ACTIVE' as const,
          createdAt: '2026-04-03T17:20:34.647Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 72,
          boxStatus: 'IN_STOCK' as const,
          checkedOutOnThisJob: false
        }
      ],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    };

    const nextDetail = createOptimisticJobDetailAfterAllocationAddition(detail, [
      {
        allocationId: 'pending-alloc-50',
        boxId: 'IL1-6502',
        warehouse: 'IL1',
        jobNumber: '29002',
        jobDate: '2026-04-03',
        crewLeader: 'Crew',
        allocatedFeet: 2,
        requirementId: 'req-50',
        allocationKind: 'REQUIREMENT' as const,
        status: 'ACTIVE' as const,
        createdAt: '2026-04-03T17:22:00.000Z',
        createdBy: 'Pending...',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: '',
        notes: 'Pending server confirmation',
        manufacturer: '3M Solar',
        filmName: 'Affinity 15',
        widthIn: 72,
        boxStatus: 'IN_STOCK' as const,
        checkedOutOnThisJob: false
      }
    ]);

    expect(nextDetail.summary.status).toBe('ALLOCATE');
    expect(nextDetail.summary.allocatedFeet).toBe(12);
    expect(nextDetail.summary.remainingFeet).toBe(2);
    expect(nextDetail.summary.allocationCount).toBe(2);
    expect(nextDetail.requirements).toEqual([
      expect.objectContaining({
        requirementId: 'req-50',
        allocatedFeet: 2,
        remainingFeet: 0
      }),
      expect.objectContaining({
        requirementId: 'req-72',
        allocatedFeet: 10,
        remainingFeet: 2
      })
    ]);
  });

  it('keeps 18959-style wider-box requirement coverage at 32 allocated and 2 remaining instead of the old 12/22 undercount', () => {
    const detail = {
      summary: {
        jobNumber: '18959',
        warehouse: 'IL1',
        sections: '1',
        dueDate: '2026-04-03',
        crewLeader: 'Crew',
        status: 'ALLOCATE' as const,
        lifecycleStatus: 'ACTIVE' as const,
        isLaborOnly: false,
        isStagedForPickup: false,
        requiredFeet: 34,
        allocatedFeet: 30,
        remainingFeet: 4,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        requirementCount: 3,
        allocationCount: 2,
        filmOrderCount: 0,
        createdAt: '2026-04-03T00:00:00Z',
        updatedAt: '2026-04-03T00:00:00Z',
        notes: ''
      },
      requirements: [
        {
          requirementId: 'req-fasara',
          manufacturer: '3M Fasara',
          filmName: 'Milano Milky White SH2MAML',
          widthIn: 50,
          requiredFeet: 20,
          allocatedFeet: 20,
          remainingFeet: 0
        },
        {
          requirementId: 'req-50',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 50,
          requiredFeet: 2,
          allocatedFeet: 0,
          remainingFeet: 2
        },
        {
          requirementId: 'req-72',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 72,
          requiredFeet: 12,
          allocatedFeet: 10,
          remainingFeet: 2
        }
      ],
      allocations: [
        {
          allocationId: 'alloc-fasara',
          boxId: 'IL1-6076',
          warehouse: 'IL1',
          jobNumber: '18959',
          jobDate: '2026-04-03',
          crewLeader: 'Crew',
          allocatedFeet: 20,
          requirementId: 'req-fasara',
          allocationKind: 'REQUIREMENT' as const,
          status: 'ACTIVE' as const,
          createdAt: '2026-04-03T17:19:35.984Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M Fasara',
          filmName: 'Milano Milky White SH2MAML',
          widthIn: 60,
          boxStatus: 'IN_STOCK' as const,
          checkedOutOnThisJob: false
        },
        {
          allocationId: 'alloc-72',
          boxId: 'IL1-6502',
          warehouse: 'IL1',
          jobNumber: '18959',
          jobDate: '2026-04-03',
          crewLeader: 'Crew',
          allocatedFeet: 10,
          requirementId: 'req-72',
          allocationKind: 'REQUIREMENT' as const,
          status: 'ACTIVE' as const,
          createdAt: '2026-04-03T17:20:34.647Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 72,
          boxStatus: 'IN_STOCK' as const,
          checkedOutOnThisJob: false
        }
      ],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    };

    const nextDetail = createOptimisticJobDetailAfterAllocationAddition(detail, [
      {
        allocationId: 'pending-alloc-50',
        boxId: 'IL1-6502',
        warehouse: 'IL1',
        jobNumber: '18959',
        jobDate: '2026-04-03',
        crewLeader: 'Crew',
        allocatedFeet: 2,
        requirementId: 'req-50',
        allocationKind: 'REQUIREMENT' as const,
        status: 'ACTIVE' as const,
        createdAt: '2026-04-06T07:03:24.227Z',
        createdBy: 'Pending...',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: '',
        notes: 'Pending server confirmation',
        manufacturer: '3M Solar',
        filmName: 'Affinity 15',
        widthIn: 72,
        boxStatus: 'IN_STOCK' as const,
        checkedOutOnThisJob: false
      }
    ]);

    expect(nextDetail.summary.status).toBe('ALLOCATE');
    expect(nextDetail.summary.allocatedFeet).toBe(32);
    expect(nextDetail.summary.remainingFeet).toBe(2);
    expect(nextDetail.summary.allocatedFeet).not.toBe(12);
    expect(nextDetail.summary.remainingFeet).not.toBe(22);
    expect(nextDetail.requirements).toEqual([
      expect.objectContaining({
        requirementId: 'req-fasara',
        allocatedFeet: 20,
        remainingFeet: 0
      }),
      expect.objectContaining({
        requirementId: 'req-50',
        allocatedFeet: 2,
        remainingFeet: 0
      }),
      expect.objectContaining({
        requirementId: 'req-72',
        allocatedFeet: 10,
        remainingFeet: 2
      })
    ]);
  });

  it('applies optimistic cross-warehouse additions using cached search results', () => {
    const queryClient = createQueryClient();
    const detail = {
      summary: {
        jobNumber: '29003',
        warehouse: 'IL1',
        sections: null,
        dueDate: '2026-04-03',
        crewLeader: 'Crew',
        status: 'ALLOCATE' as const,
        lifecycleStatus: 'ACTIVE' as const,
        isLaborOnly: false,
        isStagedForPickup: false,
        requiredFeet: 14,
        allocatedFeet: 0,
        remainingFeet: 14,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        requirementCount: 2,
        allocationCount: 0,
        filmOrderCount: 0,
        createdAt: '2026-04-03T00:00:00Z',
        updatedAt: '2026-04-03T00:00:00Z',
        notes: ''
      },
      requirements: [
        {
          requirementId: 'req-50',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 50,
          requiredFeet: 2,
          allocatedFeet: 0,
          remainingFeet: 2
        },
        {
          requirementId: 'req-72',
          manufacturer: '3M Solar',
          filmName: 'Affinity 15',
          widthIn: 72,
          requiredFeet: 12,
          allocatedFeet: 0,
          remainingFeet: 12
        }
      ],
      allocations: [],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    };

    queryClient.setQueryData(inventoryKeys.job('29003'), detail);
    queryClient.setQueryData(inventoryKeys.allocationJob('29003'), {
      summary: {
        jobNumber: '29003',
        jobDate: '2026-04-03',
        crewLeader: 'Crew',
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
    queryClient.setQueryData(['inventory', 'search', 'IL1', 'Affinity 15', 'active'], [
      {
        boxId: 'IL1-6502',
        warehouse: 'IL1',
        manufacturer: '3M Solar',
        filmName: 'Affinity 15',
        widthIn: 72,
        initialFeet: 12,
        feetAvailable: 12,
        lotRun: '',
        status: 'IN_STOCK',
        orderDate: '2026-04-01',
        receivedDate: '2026-04-02',
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        filmKey: '3M SOLAR|AFFINITY 15',
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
        zeroedBy: ''
      }
    ]);

    const result = applyOptimisticAllocationAdditionToCaches(queryClient, {
      boxId: 'IL1-6502',
      jobNumber: '29003',
      requestedFeet: 12,
      requestedWidthIn: 72,
      requirementId: 'req-72',
      selectedSuggestionBoxIds: [],
      extraAllocations: [],
      crossWarehouse: true,
      jobWarehouse: 'IL1'
    });

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]).toMatchObject({
      boxId: 'IL1-6502',
      allocatedFeet: 12,
      requirementId: 'req-72'
    });
    expect(queryClient.getQueryData(inventoryKeys.job('29003'))).toMatchObject({
      summary: {
        allocatedFeet: 12,
        remainingFeet: 2,
        allocationCount: 1
      },
      requirements: [
        expect.objectContaining({
          requirementId: 'req-50',
          allocatedFeet: 0,
          remainingFeet: 2
        }),
        expect.objectContaining({
          requirementId: 'req-72',
          allocatedFeet: 12,
          remainingFeet: 0
        })
      ]
    });
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('29003'))).toMatchObject({
      summary: {
        activeAllocatedFeet: 12,
        boxCount: 1
      },
      allocations: [
        expect.objectContaining({
          boxId: 'IL1-6502',
          requirementId: 'req-72'
        })
      ]
    });
  });

  it('applies optimistic allocation removal across job, summary, box, and allocation caches', () => {
    const queryClient = createQueryClient();
    const detail = {
      summary: {
        jobNumber: '555',
        warehouse: 'IL1',
        sections: null,
        dueDate: '2026-04-02',
        crewLeader: 'Crew',
        status: 'READY' as const,
        lifecycleStatus: 'ACTIVE' as const,
        isLaborOnly: false,
        isStagedForPickup: false,
        requiredFeet: 20,
        allocatedFeet: 20,
        remainingFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        requirementCount: 1,
        allocationCount: 2,
        filmOrderCount: 0,
        createdAt: '2026-04-02T00:00:00Z',
        updatedAt: '2026-04-02T00:00:00Z',
        notes: ''
      },
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: '3M',
          filmName: 'Safety Shield',
          widthIn: 48,
          requiredFeet: 20,
          allocatedFeet: 20,
          remainingFeet: 0
        }
      ],
      allocations: [
        {
          allocationId: 'alloc-1',
          boxId: 'IL1-6552',
          warehouse: 'IL1',
          jobNumber: '555',
          jobDate: '2026-04-02',
          crewLeader: 'Crew',
          allocatedFeet: 11,
          allocationKind: 'REQUIREMENT' as const,
          status: 'ACTIVE' as const,
          createdAt: '2026-04-02T00:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M',
          filmName: 'Safety Shield',
          widthIn: 48,
          boxStatus: 'IN_STOCK' as const,
          checkedOutOnThisJob: false
        },
        {
          allocationId: 'alloc-2',
          boxId: 'IL1-5973',
          warehouse: 'IL1',
          jobNumber: '555',
          jobDate: '2026-04-02',
          crewLeader: 'Crew',
          allocatedFeet: 9,
          allocationKind: 'REQUIREMENT' as const,
          status: 'ACTIVE' as const,
          createdAt: '2026-04-02T00:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M',
          filmName: 'Safety Shield',
          widthIn: 48,
          boxStatus: 'IN_STOCK' as const,
          checkedOutOnThisJob: false
        }
      ],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    };

    queryClient.setQueryData(inventoryKeys.job('555'), detail);
    queryClient.setQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }), [
      detail.summary
    ]);
    queryClient.setQueryData(inventoryKeys.allocationJobs, [
      {
        jobNumber: '555',
        jobDate: '2026-04-02',
        crewLeader: 'Crew',
        status: 'READY',
        activeAllocatedFeet: 20,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 0,
        boxCount: 2
      }
    ]);
    queryClient.setQueryData(inventoryKeys.allocationJob('555'), {
      summary: {
        jobNumber: '555',
        jobDate: '2026-04-02',
        crewLeader: 'Crew',
        status: 'READY',
        activeAllocatedFeet: 20,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 0,
        boxCount: 2
      },
      allocations: detail.allocations,
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    });
    queryClient.setQueryData(inventoryKeys.box('IL1-6552'), {
      boxId: 'IL1-6552',
      warehouse: 'IL1',
      manufacturer: '3M',
      filmName: 'Safety Shield',
      widthIn: 48,
      initialFeet: 100,
      feetAvailable: 3,
      lotRun: '',
      status: 'IN_STOCK',
      orderDate: '2026-03-20',
      receivedDate: '2026-03-21',
      initialWeightLbs: null,
      lastRollWeightLbs: null,
      lastWeighedDate: '',
      filmKey: '3M|SAFETY SHIELD',
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
      zeroedBy: ''
    });
    queryClient.setQueryData(inventoryKeys.list({ warehouse: 'IL1' }), [
      queryClient.getQueryData(inventoryKeys.box('IL1-6552'))
    ]);
    queryClient.setQueryData(inventoryKeys.allocations('IL1-6552'), [
      {
        allocationId: 'alloc-1',
        boxId: 'IL1-6552',
        warehouse: 'IL1',
        jobNumber: '555',
        jobDate: '2026-04-02',
        crewLeader: 'Crew',
        allocatedFeet: 11,
        allocationKind: 'REQUIREMENT',
        status: 'ACTIVE',
        createdAt: '2026-04-02T00:00:00Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: '',
        notes: ''
      }
    ]);

    const result = applyOptimisticAllocationRemovalToCaches(queryClient, '555', 'alloc-1');

    expect(result).toEqual({ removedBoxId: 'IL1-6552' });
    expect(queryClient.getQueryData(inventoryKeys.job('555'))).toMatchObject({
      summary: {
        status: 'ALLOCATE',
        allocatedFeet: 9,
        remainingFeet: 11,
        allocationCount: 1
      },
      allocations: [
        expect.objectContaining({
          allocationId: 'alloc-2'
        })
      ],
      requirements: [
        expect.objectContaining({
          allocatedFeet: 9,
          remainingFeet: 11
        })
      ]
    });
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('555'))).toMatchObject({
      summary: {
        status: 'ALLOCATE',
        activeAllocatedFeet: 9,
        boxCount: 1
      },
      allocations: [
        expect.objectContaining({
          allocationId: 'alloc-2'
        })
      ]
    });
    expect(queryClient.getQueryData(inventoryKeys.box('IL1-6552'))).toMatchObject({
      feetAvailable: 14
    });
    expect(queryClient.getQueryData(inventoryKeys.allocations('IL1-6552'))).toEqual([]);
    expect(
      queryClient.getQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }))
    ).toEqual([
      expect.objectContaining({
        status: 'ALLOCATE',
        allocatedFeet: 9,
        remainingFeet: 11,
        allocationCount: 1
      })
    ]);
  });

  it('updates box caches with the server-returned reactivated zeroed box state', () => {
    const queryClient = createQueryClient();
    const zeroedBox = {
      boxId: 'IL1-6919',
      warehouse: 'IL1',
      manufacturer: '3M Fasara',
      filmName: 'Dusted Crystal',
      widthIn: 18,
      initialFeet: 20,
      feetAvailable: 0,
      lotRun: '',
      status: 'ZEROED' as const,
      orderDate: '2026-03-20',
      receivedDate: '2026-03-21',
      initialWeightLbs: 3.3,
      lastRollWeightLbs: 0,
      lastWeighedDate: '2026-03-30',
      filmKey: '3M FASARA|DUSTED CRYSTAL',
      coreType: 'Cardboard 1/8"',
      coreWeightLbs: 1.025,
      lfWeightLbsPerFt: 0.11375,
      pricePerLf: null,
      purchaseCost: null,
      notes: '',
      hasEverBeenCheckedOut: false,
      lastCheckoutJob: '',
      lastCheckoutDate: '',
      zeroedDate: '2026-04-02',
      zeroedReason: 'Auto-zeroed because Available Feet and Last Roll Weight reached 0.',
      zeroedBy: 'rob'
    };

    queryClient.setQueryData(inventoryKeys.box(zeroedBox.boxId), zeroedBox);
    queryClient.setQueryData(inventoryKeys.list({ warehouse: 'IL1' }), [zeroedBox]);

    updateBoxCaches(queryClient, zeroedBox.boxId, (current) => ({
      ...current,
      status: 'IN_STOCK',
      feetAvailable: 20,
      lastRollWeightLbs: 3.3,
      zeroedDate: '',
      zeroedReason: '',
      zeroedBy: ''
    }));

    expect(queryClient.getQueryData(inventoryKeys.box(zeroedBox.boxId))).toMatchObject({
      status: 'IN_STOCK',
      feetAvailable: 20,
      lastRollWeightLbs: 3.3,
      zeroedDate: '',
      zeroedReason: '',
      zeroedBy: ''
    });
    expect(queryClient.getQueryData(inventoryKeys.list({ warehouse: 'IL1' }))).toEqual([
      expect.objectContaining({
        boxId: 'IL1-6919',
        status: 'IN_STOCK',
        feetAvailable: 20,
        lastRollWeightLbs: 3.3,
        zeroedDate: '',
        zeroedReason: '',
        zeroedBy: ''
      })
    ]);
  });
});
