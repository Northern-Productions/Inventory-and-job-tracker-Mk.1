import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { AllocationEntry, AllocationJobDetailEntry, FilmOrderEntry, JobDetail } from '../../../domain';
import { inventoryKeys } from './inventoryQueryKeys';
import {
  applyOptimisticAllocationAdditionToCaches,
  applyOptimisticAllocationRemovalToCaches,
  applyOptimisticFilmOrderDeletionToCaches,
  applyOptimisticJobScheduleSyncToCaches,
  beginDelayedOptimisticMutation,
  beginImmediateOptimisticMutation,
  computeOptimisticJobStatus,
  createOptimisticFilmOrderFromPayload,
  createOptimisticJobDetailAfterAllocationAddition,
  createOptimisticJobDetailAfterAllocationRemoval,
  createOptimisticJobDetailAfterFilmOrderDeletion,
  createOptimisticJobDetailFromCreatePayload,
  resolveOptimisticFilmOrderScheduleFromCaches,
  rollbackOptimisticAllocationRemovalInCaches,
  removeJobPlanningCaches,
  restoreSnapshots,
  syncJobDetailCaches,
  syncJobSummaryCachesFromDetail,
  updateBoxCaches,
  upsertJobsCalendarCaches,
  upsertFilmOrdersCache
} from './inventoryMutationUtils';

function withCoveredFeetEntries<T extends Array<{ allocatedFeet: number; coveredFeet?: number }>>(
  entries: T
): AllocationJobDetailEntry[] {
  return entries.map((entry) => ({
    ...entry,
    coveredFeet: Number(entry.coveredFeet ?? entry.allocatedFeet ?? 0)
  })) as AllocationJobDetailEntry[];
}

function withCoveredFeetDetail<T extends { allocations: Array<{ allocatedFeet: number; coveredFeet?: number }> }>(
  detail: T
) : JobDetail {
  return {
    ...detail,
    allocations: withCoveredFeetEntries(detail.allocations)
  } as unknown as JobDetail;
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false
      }
    }
  });
}

function buildFilmRequirementCoverageDetail(
  requirements: JobDetail['requirements']
): JobDetail {
  const requiredFeet = requirements.reduce((sum, entry) => sum + entry.requiredFeet, 0);

  return {
    summary: {
      jobNumber: '29050',
      warehouse: 'IL1',
      sections: null,
      dueDate: '2026-04-06',
      crewLeader: 'Crew',
      status: 'ALLOCATE',
      lifecycleStatus: 'ACTIVE',
      isLaborOnly: false,
      isStagedForPickup: false,
      requiredFeet,
      allocatedFeet: 0,
      remainingFeet: requiredFeet,
      requiredTubes: 0,
      allocatedTubes: 0,
      remainingTubes: 0,
      requirementCount: requirements.length,
      allocationCount: 0,
      filmOrderCount: 0,
      hasOrderedAllocations: false,
      createdAt: '2026-04-06T00:00:00Z',
      updatedAt: '2026-04-06T00:00:00Z',
      notes: ''
    },
    requirements,
    allocations: [],
    usage: [],
    usageTimeline: [],
    caulkRequirements: [],
    caulkAllocations: [],
    caulkCheckouts: [],
    filmOrders: []
  };
}

function buildFilmOrderEntry(overrides: Partial<FilmOrderEntry> = {}): FilmOrderEntry {
  return {
    filmOrderId: 'FO-1',
    jobNumber: '2941',
    warehouse: 'IL1',
    manufacturer: '3M Solar',
    filmName: 'Prestige 60',
    widthIn: 72,
    requestedFeet: 60,
    coveredFeet: 16,
    orderedFeet: 0,
    remainingToOrderFeet: 44,
    jobDate: '2026-04-13',
    crewLeader: 'Crew',
    status: 'FILM_ORDER',
    sourceBoxId: '',
    createdAt: '2026-04-06T00:00:00Z',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    linkedBoxes: [],
    ...overrides
  };
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

  it('can seed optimistic film orders with cached job scheduling metadata', () => {
    const optimisticFilmOrder = createOptimisticFilmOrderFromPayload(
      {
        jobNumber: '18798',
        warehouse: 'IL1',
        manufacturer: '3M',
        filmName: 'Dusted Crystal',
        widthIn: 60,
        requestedFeet: 120
      },
      {
        jobDate: '2026-04-13',
        crewLeader: 'Napo'
      }
    );

    expect(optimisticFilmOrder.jobDate).toBe('2026-04-13');
    expect(optimisticFilmOrder.crewLeader).toBe('Napo');
  });

  it('resolves optimistic film-order scheduling metadata from cached job sources', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }), [
      {
        jobNumber: '2941',
        warehouse: 'IL1',
        sections: null,
        dueDate: '2026-04-13',
        crewLeader: 'Napo',
        status: 'FILM_ORDER',
        lifecycleStatus: 'ACTIVE',
        isLaborOnly: false,
        isStagedForPickup: false,
        requiredFeet: 260,
        allocatedFeet: 93,
        remainingFeet: 167,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        requirementCount: 2,
        allocationCount: 2,
        filmOrderCount: 2,
        hasOrderedAllocations: false,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
        notes: ''
      }
    ]);

    expect(resolveOptimisticFilmOrderScheduleFromCaches(queryClient, '2941')).toEqual({
      jobDate: '2026-04-13',
      crewLeader: 'Napo'
    });
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
      hasOrderedAllocations: false,
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
      hasOrderedAllocations: false,
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
        boxCount: 1,
        hasOrderedAllocations: false
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
        boxCount: 1,
        hasOrderedAllocations: false
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
        boxCount: 0,
        hasOrderedAllocations: false
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
        boxCount: 0,
        hasOrderedAllocations: false
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
      hasOrderedAllocations: false,
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
        boxCount: 1,
        hasOrderedAllocations: false
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
        boxCount: 1,
        hasOrderedAllocations: false
      },
      allocations: [],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    });

    syncJobSummaryCachesFromDetail(queryClient, withCoveredFeetDetail(freshDetail), {
      syncAllocationJobDetail: true
    });

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
        boxCount: 2,
        hasOrderedAllocations: false
      }
    ]);
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('18959'))).toMatchObject({
      summary: {
        jobNumber: '18959',
        crewLeader: 'Crew',
        status: 'ALLOCATE',
        activeAllocatedFeet: 32,
        boxCount: 2,
        hasOrderedAllocations: false
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
        hasOrderedAllocations: false,
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
      withCoveredFeetDetail(detail),
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
        hasOrderedAllocations: false,
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

    const { detail: nextDetail } = createOptimisticJobDetailAfterAllocationRemoval(
      withCoveredFeetDetail(detail),
      'alloc-1'
    );

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
        hasOrderedAllocations: false,
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

    const { detail: nextDetail } = createOptimisticJobDetailAfterAllocationRemoval(
      withCoveredFeetDetail(detail),
      'alloc-50'
    );

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
        hasOrderedAllocations: false,
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

    const nextDetail = createOptimisticJobDetailAfterAllocationAddition(
      withCoveredFeetDetail(detail),
      withCoveredFeetEntries([
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
      ])
    );

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

  it('credits bound exterior allocations to non-exterior requirements when the family matches', () => {
    const detail = buildFilmRequirementCoverageDetail([
      {
        requirementId: 'req-ext',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60 Exterior',
        widthIn: 60,
        requiredFeet: 30,
        allocatedFeet: 0,
        remainingFeet: 30
      },
      {
        requirementId: 'req-int',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        requiredFeet: 50,
        allocatedFeet: 0,
        remainingFeet: 50
      }
    ]);

    const nextDetail = createOptimisticJobDetailAfterAllocationAddition(detail, withCoveredFeetEntries([
      {
        allocationId: 'alloc-ext-to-int',
        boxId: 'IL1-EXT',
        warehouse: 'IL1',
        jobNumber: '29050',
        jobDate: '2026-04-06',
        crewLeader: 'Crew',
        allocatedFeet: 20,
        coveredFeet: 20,
        requirementId: 'req-int',
        allocationKind: 'REQUIREMENT',
        status: 'ACTIVE',
        createdAt: '2026-04-06T12:00:00Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: '',
        notes: '',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60 Exterior',
        widthIn: 60,
        boxStatus: 'IN_STOCK',
        checkedOutOnThisJob: false
      }
    ]));

    expect(nextDetail.requirements).toEqual([
      {
        requirementId: 'req-ext',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60 Exterior',
        widthIn: 60,
        requiredFeet: 30,
        allocatedFeet: 0,
        remainingFeet: 30
      },
      {
        requirementId: 'req-int',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        requiredFeet: 50,
        allocatedFeet: 20,
        remainingFeet: 30
      }
    ]);
  });

  it('does not let bound interior allocations satisfy exterior-only requirements', () => {
    const detail = buildFilmRequirementCoverageDetail([
      {
        requirementId: 'req-ext',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60 Exterior',
        widthIn: 60,
        requiredFeet: 30,
        allocatedFeet: 0,
        remainingFeet: 30
      },
      {
        requirementId: 'req-int',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        requiredFeet: 50,
        allocatedFeet: 0,
        remainingFeet: 50
      }
    ]);

    const nextDetail = createOptimisticJobDetailAfterAllocationAddition(detail, withCoveredFeetEntries([
      {
        allocationId: 'alloc-int-to-ext',
        boxId: 'IL1-INT',
        warehouse: 'IL1',
        jobNumber: '29050',
        jobDate: '2026-04-06',
        crewLeader: 'Crew',
        allocatedFeet: 20,
        coveredFeet: 20,
        requirementId: 'req-ext',
        allocationKind: 'REQUIREMENT',
        status: 'ACTIVE',
        createdAt: '2026-04-06T12:00:00Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: '',
        notes: '',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        boxStatus: 'IN_STOCK',
        checkedOutOnThisJob: false
      }
    ]));

    expect(nextDetail.requirements).toEqual([
      {
        requirementId: 'req-ext',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60 Exterior',
        widthIn: 60,
        requiredFeet: 30,
        allocatedFeet: 0,
        remainingFeet: 30
      },
      {
        requirementId: 'req-int',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        requiredFeet: 50,
        allocatedFeet: 20,
        remainingFeet: 30
      }
    ]);
  });

  it('reserves pooled exterior coverage for exterior requirements before interior ones', () => {
    const detail = buildFilmRequirementCoverageDetail([
      {
        requirementId: 'req-ext',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60 Exterior',
        widthIn: 60,
        requiredFeet: 30,
        allocatedFeet: 0,
        remainingFeet: 30
      },
      {
        requirementId: 'req-int',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        requiredFeet: 50,
        allocatedFeet: 0,
        remainingFeet: 50
      }
    ]);

    const nextDetail = createOptimisticJobDetailAfterAllocationAddition(detail, withCoveredFeetEntries([
      {
        allocationId: 'alloc-pooled-ext',
        boxId: 'IL1-EXT',
        warehouse: 'IL1',
        jobNumber: '29050',
        jobDate: '2026-04-06',
        crewLeader: 'Crew',
        allocatedFeet: 50,
        coveredFeet: 50,
        requirementId: '',
        allocationKind: 'REQUIREMENT',
        status: 'ACTIVE',
        createdAt: '2026-04-06T12:00:00Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: '',
        notes: '',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60 Exterior',
        widthIn: 60,
        boxStatus: 'IN_STOCK',
        checkedOutOnThisJob: false
      }
    ]));

    expect(nextDetail.requirements).toEqual([
      {
        requirementId: 'req-ext',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60 Exterior',
        widthIn: 60,
        requiredFeet: 30,
        allocatedFeet: 30,
        remainingFeet: 0
      },
      {
        requirementId: 'req-int',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        requiredFeet: 50,
        allocatedFeet: 20,
        remainingFeet: 30
      }
    ]);
  });

  it('keeps pooled descriptive RN07 coverage on the exact descriptive requirement before the broader shorthand requirement', () => {
    const detail = buildFilmRequirementCoverageDetail([
      {
        requirementId: 'req-base',
        manufacturer: 'Llumar',
        filmName: 'RN 07',
        widthIn: 48,
        requiredFeet: 20,
        allocatedFeet: 0,
        remainingFeet: 20
      },
      {
        requirementId: 'req-desc',
        manufacturer: 'Llumar',
        filmName: 'RN 07 Refl. One Way Mirror',
        widthIn: 48,
        requiredFeet: 20,
        allocatedFeet: 0,
        remainingFeet: 20
      }
    ]);

    const nextDetail = createOptimisticJobDetailAfterAllocationAddition(detail, withCoveredFeetEntries([
      {
        allocationId: 'alloc-pooled-rn07-desc',
        boxId: 'IL1-RN07-REFL',
        warehouse: 'IL1',
        jobNumber: '29050',
        jobDate: '2026-04-06',
        crewLeader: 'Crew',
        allocatedFeet: 10,
        coveredFeet: 10,
        requirementId: '',
        allocationKind: 'REQUIREMENT',
        status: 'ACTIVE',
        createdAt: '2026-04-06T12:00:00Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: '',
        notes: '',
        manufacturer: 'Llumar',
        filmName: 'RN 07 Refl. One Way Mirror',
        widthIn: 48,
        boxStatus: 'IN_STOCK',
        checkedOutOnThisJob: false
      }
    ]));

    expect(nextDetail.requirements).toEqual([
      {
        requirementId: 'req-base',
        manufacturer: 'Llumar',
        filmName: 'RN 07',
        widthIn: 48,
        requiredFeet: 20,
        allocatedFeet: 0,
        remainingFeet: 20
      },
      {
        requirementId: 'req-desc',
        manufacturer: 'Llumar',
        filmName: 'RN 07 Refl. One Way Mirror',
        widthIn: 48,
        requiredFeet: 20,
        allocatedFeet: 10,
        remainingFeet: 10
      }
    ]);
  });

  it('treats an explicit requirement-bound RN07 family allocation as authoritative coverage for that requirement', () => {
    const detail = buildFilmRequirementCoverageDetail([
      {
        requirementId: 'req-base',
        manufacturer: 'Llumar',
        filmName: 'RN 07',
        widthIn: 48,
        requiredFeet: 15,
        allocatedFeet: 10,
        remainingFeet: 5
      }
    ]);

    const nextDetail = createOptimisticJobDetailAfterAllocationAddition(detail, withCoveredFeetEntries([
      {
        allocationId: 'alloc-rn07-base',
        boxId: 'IL1-6769',
        warehouse: 'IL1',
        jobNumber: '17170',
        jobDate: '2026-04-15',
        crewLeader: 'Danny',
        allocatedFeet: 10,
        coveredFeet: 10,
        requirementId: 'req-base',
        allocationKind: 'REQUIREMENT',
        status: 'ACTIVE',
        createdAt: '2026-04-07T16:00:00Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: '',
        notes: '',
        manufacturer: 'Llumar',
        filmName: 'RN 07',
        widthIn: 48,
        boxStatus: 'IN_STOCK',
        checkedOutOnThisJob: false
      },
      {
        allocationId: 'alloc-rn07-desc',
        boxId: 'IL1-6915',
        warehouse: 'IL1',
        jobNumber: '17170',
        jobDate: '2026-04-15',
        crewLeader: 'Danny',
        allocatedFeet: 5,
        coveredFeet: 5,
        requirementId: 'req-base',
        allocationKind: 'REQUIREMENT',
        status: 'ACTIVE',
        createdAt: '2026-04-07T16:00:05Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: '',
        notes: '',
        manufacturer: 'Llumar',
        filmName: 'RN 07 Refl. One Way Mirror',
        widthIn: 48,
        boxStatus: 'IN_STOCK',
        checkedOutOnThisJob: false
      }
    ]));

    expect(nextDetail.summary.allocatedFeet).toBe(15);
    expect(nextDetail.summary.remainingFeet).toBe(0);
    expect(nextDetail.requirements).toEqual([
      {
        requirementId: 'req-base',
        manufacturer: 'Llumar',
        filmName: 'RN 07',
        widthIn: 48,
        requiredFeet: 15,
        allocatedFeet: 15,
        remainingFeet: 0
      }
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
        hasOrderedAllocations: false,
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

    const nextDetail = createOptimisticJobDetailAfterAllocationAddition(
      withCoveredFeetDetail(detail),
      withCoveredFeetEntries([
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
      ])
    );

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

  it('uses covered feet for optimistic 72-to-36 requirement allocations while only consuming physical stock', () => {
    const queryClient = createQueryClient();
    const detail = {
      summary: {
        jobNumber: '4803',
        warehouse: 'MS1',
        sections: '1',
        dueDate: '2026-04-06',
        crewLeader: 'Crew',
        status: 'ALLOCATE' as const,
        lifecycleStatus: 'ACTIVE' as const,
        isLaborOnly: false,
        isStagedForPickup: false,
        requiredFeet: 20,
        allocatedFeet: 0,
        remainingFeet: 20,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        requirementCount: 1,
        allocationCount: 0,
        filmOrderCount: 0,
        hasOrderedAllocations: false,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
        notes: ''
      },
      requirements: [
        {
          requirementId: 'req-36',
          manufacturer: 'SOLYX',
          filmName: 'Whiteout SXWF-WO',
          widthIn: 36,
          requiredFeet: 20,
          allocatedFeet: 0,
          remainingFeet: 20
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

    queryClient.setQueryData(inventoryKeys.job('4803'), detail);
    queryClient.setQueryData(inventoryKeys.allocationJob('4803'), {
      summary: {
        jobNumber: '4803',
        jobDate: '2026-04-06',
        crewLeader: 'Crew',
        status: 'ALLOCATE',
        activeAllocatedFeet: 0,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 0,
        boxCount: 0,
        hasOrderedAllocations: false
      },
      allocations: [],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    });
    queryClient.setQueryData(inventoryKeys.box('MS1-3608'), {
      boxId: 'MS1-3608',
      warehouse: 'MS1',
      manufacturer: 'SOLYX',
      filmName: 'Whiteout SXWF-WO',
      widthIn: 72,
      initialFeet: 10,
      feetAvailable: 10,
      lotRun: '',
      status: 'IN_STOCK',
      orderDate: '2026-04-01',
      receivedDate: '2026-04-02',
      initialWeightLbs: null,
      lastRollWeightLbs: null,
      lastWeighedDate: '',
      filmKey: 'SOLYX|WHITEOUT SXWF-WO',
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

    const result = applyOptimisticAllocationAdditionToCaches(queryClient, {
      boxId: 'MS1-3608',
      jobNumber: '4803',
      requestedFeet: 20,
      requestedWidthIn: 36,
      requirementId: 'req-36',
      selectedSuggestionBoxIds: [],
      extraAllocations: [],
      crossWarehouse: false,
      jobWarehouse: 'MS1'
    });

    expect(result.allocations).toMatchObject([
      {
        boxId: 'MS1-3608',
        allocatedFeet: 10,
        coveredFeet: 20,
        requirementId: 'req-36'
      }
    ]);
    expect(queryClient.getQueryData(inventoryKeys.job('4803'))).toMatchObject({
      summary: {
        allocatedFeet: 20,
        remainingFeet: 0,
        allocationCount: 1
      },
      requirements: [
        expect.objectContaining({
          requirementId: 'req-36',
          allocatedFeet: 20,
          remainingFeet: 0
        })
      ],
      allocations: [
        expect.objectContaining({
          allocatedFeet: 10,
          coveredFeet: 20
        })
      ]
    });
    expect(queryClient.getQueryData(inventoryKeys.box('MS1-3608'))).toMatchObject({
      feetAvailable: 0
    });
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
        hasOrderedAllocations: false,
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
        boxCount: 0,
        hasOrderedAllocations: false
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
        boxCount: 1,
        hasOrderedAllocations: false
      },
      allocations: [
        expect.objectContaining({
          boxId: 'IL1-6502',
          requirementId: 'req-72'
        })
      ]
    });
  });

  it('reduces available feet inside job-allocate search caches after an optimistic allocation', () => {
    const queryClient = createQueryClient();
    const jobAllocateSearchKey = [
      'inventory',
      'search',
      'job-allocate',
      'MS1',
      'Avery Dennison',
      'Natura 15',
      'active'
    ] as const;

    queryClient.setQueryData(jobAllocateSearchKey, [
      {
        boxId: 'MS1-965',
        warehouse: 'MS1',
        manufacturer: 'Avery Dennison',
        filmName: 'Natura 15',
        widthIn: 72,
        initialFeet: 100,
        feetAvailable: 100,
        lotRun: '',
        status: 'IN_STOCK',
        orderDate: '2026-04-01',
        receivedDate: '2026-04-02',
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        filmKey: 'AVERY DENNISON|NATURA 15',
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
      },
      {
        boxId: 'MS1-966',
        warehouse: 'MS1',
        manufacturer: 'Avery Dennison',
        filmName: 'Natura 15',
        widthIn: 72,
        initialFeet: 100,
        feetAvailable: 100,
        lotRun: '',
        status: 'IN_STOCK',
        orderDate: '2026-04-01',
        receivedDate: '2026-04-02',
        initialWeightLbs: null,
        lastRollWeightLbs: null,
        lastWeighedDate: '',
        filmKey: 'AVERY DENNISON|NATURA 15',
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
      boxId: 'MS1-965',
      jobNumber: '18764',
      requestedFeet: 100,
      requestedWidthIn: 72,
      requirementId: 'req-72',
      selectedSuggestionBoxIds: [],
      extraAllocations: [],
      crossWarehouse: false,
      jobWarehouse: 'MS1'
    });

    expect(result.allocations).toMatchObject([
      {
        boxId: 'MS1-965',
        allocatedFeet: 100,
        coveredFeet: 100,
        requirementId: 'req-72'
      }
    ]);
    expect(queryClient.getQueryData(jobAllocateSearchKey)).toMatchObject([
      {
        boxId: 'MS1-965',
        feetAvailable: 0
      },
      {
        boxId: 'MS1-966',
        feetAvailable: 100
      }
    ]);
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
        hasOrderedAllocations: false,
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
        boxCount: 2,
        hasOrderedAllocations: false
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
        boxCount: 2,
        hasOrderedAllocations: false
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

    expect(result).toMatchObject({
      removedBoxId: 'IL1-6552',
      rollback: {
        jobNumber: '555',
        allocation: expect.objectContaining({
          allocationId: 'alloc-1',
          boxId: 'IL1-6552'
        })
      }
    });
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
        boxCount: 1,
        hasOrderedAllocations: false
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

  it('keeps ordered box on-hand feet at 0 while optimistic allocations update planning feet and ordered flags', () => {
    const queryClient = createQueryClient();
    const detail = buildFilmRequirementCoverageDetail([
      {
        requirementId: 'req-ordered',
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        requiredFeet: 40,
        allocatedFeet: 0,
        remainingFeet: 40
      }
    ]);
    const orderedBox = {
      boxId: 'IL1-ORDERED',
      warehouse: 'IL1',
      manufacturer: '3M Solar',
      filmName: 'Prestige 60',
      widthIn: 60,
      initialFeet: 80,
      feetAvailable: 0,
      allocationPlanningFeet: 80,
      lotRun: '',
      status: 'ORDERED' as const,
      orderDate: '2026-04-06',
      receivedDate: '',
      initialWeightLbs: null,
      lastRollWeightLbs: null,
      lastWeighedDate: '',
      filmKey: '3M SOLAR|PRESTIGE 60',
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
    };

    queryClient.setQueryData(inventoryKeys.job('29050'), detail);
    queryClient.setQueryData(inventoryKeys.allocationJob('29050'), {
      summary: {
        jobNumber: '29050',
        jobDate: '2026-04-06',
        crewLeader: 'Crew',
        status: 'ALLOCATE',
        activeAllocatedFeet: 0,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 0,
        boxCount: 0,
        hasOrderedAllocations: false
      },
      allocations: [],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: []
    });
    queryClient.setQueryData(inventoryKeys.box('IL1-ORDERED'), orderedBox);
    queryClient.setQueryData(inventoryKeys.allocations('IL1-ORDERED'), []);

    const addition = applyOptimisticAllocationAdditionToCaches(queryClient, {
      boxId: 'IL1-ORDERED',
      jobNumber: '29050',
      requestedFeet: 40,
      requestedWidthIn: 60,
      requirementId: 'req-ordered',
      selectedSuggestionBoxIds: [],
      extraAllocations: []
    });

    expect(addition.allocations).toHaveLength(1);
    expect(queryClient.getQueryData(inventoryKeys.box('IL1-ORDERED'))).toMatchObject({
      feetAvailable: 0,
      allocationPlanningFeet: 40,
      status: 'ORDERED'
    });
    expect(queryClient.getQueryData(inventoryKeys.job('29050'))).toMatchObject({
      summary: {
        allocatedFeet: 40,
        remainingFeet: 0,
        hasOrderedAllocations: true
      },
      allocations: [
        expect.objectContaining({
          boxId: 'IL1-ORDERED',
          boxStatus: 'ORDERED'
        })
      ]
    });
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('29050'))).toMatchObject({
      summary: {
        activeAllocatedFeet: 40,
        hasOrderedAllocations: true
      }
    });

    applyOptimisticAllocationRemovalToCaches(queryClient, '29050', addition.allocations[0].allocationId);

    expect(queryClient.getQueryData(inventoryKeys.box('IL1-ORDERED'))).toMatchObject({
      feetAvailable: 0,
      allocationPlanningFeet: 80,
      status: 'ORDERED'
    });
    expect(queryClient.getQueryData(inventoryKeys.job('29050'))).toMatchObject({
      summary: {
        allocatedFeet: 0,
        remainingFeet: 40,
        hasOrderedAllocations: false
      }
    });
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('29050'))).toMatchObject({
      summary: {
        activeAllocatedFeet: 0,
        hasOrderedAllocations: false
      }
    });
  });

  it('restores only the failed allocation when optimistic removals overlap', () => {
    const queryClient = createQueryClient();
    const detail = withCoveredFeetDetail({
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
        hasOrderedAllocations: false,
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
          coveredFeet: 11,
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
          coveredFeet: 9,
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
    });

    queryClient.setQueryData(inventoryKeys.job('555'), detail);
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
        boxCount: 2,
        hasOrderedAllocations: false
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
    queryClient.setQueryData(inventoryKeys.box('IL1-5973'), {
      boxId: 'IL1-5973',
      warehouse: 'IL1',
      manufacturer: '3M',
      filmName: 'Safety Shield',
      widthIn: 48,
      initialFeet: 100,
      feetAvailable: 5,
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
    queryClient.setQueryData(inventoryKeys.allocations('IL1-6552'), [
      {
        allocationId: 'alloc-1',
        boxId: 'IL1-6552',
        warehouse: 'IL1',
        jobNumber: '555',
        jobDate: '2026-04-02',
        crewLeader: 'Crew',
        allocatedFeet: 11,
        coveredFeet: 11,
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
    queryClient.setQueryData(inventoryKeys.allocations('IL1-5973'), [
      {
        allocationId: 'alloc-2',
        boxId: 'IL1-5973',
        warehouse: 'IL1',
        jobNumber: '555',
        jobDate: '2026-04-02',
        crewLeader: 'Crew',
        allocatedFeet: 9,
        coveredFeet: 9,
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

    const firstRemoval = applyOptimisticAllocationRemovalToCaches(queryClient, '555', 'alloc-1');
    const secondRemoval = applyOptimisticAllocationRemovalToCaches(queryClient, '555', 'alloc-2');

    rollbackOptimisticAllocationRemovalInCaches(queryClient, secondRemoval.rollback);

    expect(queryClient.getQueryData<JobDetail>(inventoryKeys.job('555'))).toMatchObject({
      summary: {
        allocatedFeet: 9,
        remainingFeet: 11,
        allocationCount: 1
      },
      allocations: [
        expect.objectContaining({
          allocationId: 'alloc-2'
        })
      ]
    });
    expect(queryClient.getQueryData<JobDetail>(inventoryKeys.job('555'))?.allocations).toHaveLength(1);
    expect(
      queryClient.getQueryData<AllocationEntry[]>(inventoryKeys.allocations('IL1-6552'))
    ).toEqual([]);
    expect(
      queryClient.getQueryData<AllocationEntry[]>(inventoryKeys.allocations('IL1-5973'))
    ).toEqual([
      expect.objectContaining({
        allocationId: 'alloc-2'
      })
    ]);
    expect(queryClient.getQueryData(inventoryKeys.box('IL1-6552'))).toMatchObject({
      feetAvailable: 14
    });
    expect(queryClient.getQueryData(inventoryKeys.box('IL1-5973'))).toMatchObject({
      feetAvailable: 5
    });
    expect(firstRemoval.rollback?.allocation.allocationId).toBe('alloc-1');
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

  it('recomputes job status immediately when deleting the last unresolved film order', () => {
    const detail: JobDetail = {
      summary: {
        jobNumber: '2941',
        warehouse: 'IL1',
        sections: null,
        dueDate: '2026-04-13',
        crewLeader: 'Crew',
        status: 'FILM_ORDER',
        lifecycleStatus: 'ACTIVE',
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
        hasOrderedAllocations: false,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
        notes: ''
      },
      requirements: [
        {
          requirementId: 'req-1',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60',
          widthIn: 72,
          requiredFeet: 10,
          allocatedFeet: 10,
          remainingFeet: 0
        }
      ],
      allocations: [
        {
          allocationId: 'alloc-ready-1',
          boxId: 'IL1-5000',
          warehouse: 'IL1',
          jobNumber: '2941',
          jobDate: '2026-04-13',
          crewLeader: 'Crew',
          allocatedFeet: 10,
          coveredFeet: 10,
          requirementId: 'req-1',
          allocationKind: 'REQUIREMENT',
          status: 'ACTIVE',
          createdAt: '2026-04-06T00:00:00Z',
          createdBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          filmOrderId: '',
          notes: '',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60',
          widthIn: 72,
          boxStatus: 'IN_STOCK',
          checkedOutOnThisJob: false
        }
      ],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: [buildFilmOrderEntry()]
    };

    const result = createOptimisticJobDetailAfterFilmOrderDeletion(detail, {
      filmOrderId: 'FO-1',
      reason: 'Deleted from test',
      resolvedAt: '2026-04-06T12:30:00Z'
    });

    expect(result.removed).toBe(true);
    expect(result.detail.summary.status).toBe('READY');
    expect(result.detail.summary.filmOrderCount).toBe(0);
    expect(result.detail.filmOrders).toEqual([]);
    expect(result.detail.allocations).toHaveLength(1);
  });

  it('applies optimistic film-order deletion across film, job, allocation, and box caches', () => {
    const queryClient = createQueryClient();
    const filmOrder = buildFilmOrderEntry();
    const allocation = {
      allocationId: 'alloc-fo-1',
      boxId: 'IL1-6396',
      warehouse: 'IL1',
      jobNumber: '2941',
      jobDate: '2026-04-13',
      crewLeader: 'Crew',
      allocatedFeet: 16,
      coveredFeet: 16,
      requirementId: 'req-72',
      allocationKind: 'REQUIREMENT' as const,
      status: 'ACTIVE' as const,
      createdAt: '2026-04-06T00:00:00Z',
      createdBy: 'tester',
      resolvedAt: '',
      resolvedBy: '',
      filmOrderId: 'FO-1',
      notes: '',
      manufacturer: '3M Solar',
      filmName: 'Prestige 60 Exterior',
      widthIn: 72,
      boxStatus: 'IN_STOCK' as const,
      checkedOutOnThisJob: false
    };
    const jobDetail: JobDetail = {
      summary: {
        jobNumber: '2941',
        warehouse: 'IL1',
        sections: null,
        dueDate: '2026-04-13',
        crewLeader: 'Crew',
        status: 'FILM_ORDER',
        lifecycleStatus: 'ACTIVE',
        isLaborOnly: false,
        isStagedForPickup: false,
        requiredFeet: 60,
        allocatedFeet: 16,
        remainingFeet: 44,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        requirementCount: 1,
        allocationCount: 1,
        filmOrderCount: 1,
        hasOrderedAllocations: false,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
        notes: ''
      },
      requirements: [
        {
          requirementId: 'req-72',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60',
          widthIn: 72,
          requiredFeet: 60,
          allocatedFeet: 16,
          remainingFeet: 44
        }
      ],
      allocations: [allocation],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: [filmOrder]
    };

    queryClient.setQueryData(inventoryKeys.filmOrders, [filmOrder]);
    queryClient.setQueryData(inventoryKeys.job('2941'), jobDetail);
    queryClient.setQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }), [
      jobDetail.summary
    ]);
    queryClient.setQueryData(inventoryKeys.allocationJobs, [
      {
        jobNumber: '2941',
        jobDate: '2026-04-13',
        crewLeader: 'Crew',
        status: 'FILM_ORDER',
        activeAllocatedFeet: 16,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 1,
        boxCount: 1,
        hasOrderedAllocations: false
      }
    ]);
    queryClient.setQueryData(inventoryKeys.allocationJob('2941'), {
      summary: {
        jobNumber: '2941',
        jobDate: '2026-04-13',
        crewLeader: 'Crew',
        status: 'FILM_ORDER',
        activeAllocatedFeet: 16,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 1,
        boxCount: 1,
        hasOrderedAllocations: false
      },
      allocations: [allocation],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: [filmOrder]
    });
    queryClient.setQueryData(inventoryKeys.box('IL1-6396'), {
      boxId: 'IL1-6396',
      warehouse: 'IL1',
      manufacturer: '3M Solar',
      filmName: 'Prestige 60 Exterior',
      widthIn: 72,
      initialFeet: 20,
      feetAvailable: 4,
      lotRun: '',
      status: 'IN_STOCK',
      orderDate: '2026-04-01',
      receivedDate: '2026-04-02',
      initialWeightLbs: null,
      lastRollWeightLbs: null,
      lastWeighedDate: '',
      filmKey: '3M SOLAR|PRESTIGE 60 EXTERIOR',
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
      queryClient.getQueryData(inventoryKeys.box('IL1-6396'))
    ]);
    queryClient.setQueryData(inventoryKeys.allocations('IL1-6396'), [
      {
        allocationId: 'alloc-fo-1',
        boxId: 'IL1-6396',
        warehouse: 'IL1',
        jobNumber: '2941',
        jobDate: '2026-04-13',
        crewLeader: 'Crew',
        allocatedFeet: 16,
        status: 'ACTIVE',
        createdAt: '2026-04-06T00:00:00Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: 'FO-1',
        notes: ''
      }
    ]);

    const result = applyOptimisticFilmOrderDeletionToCaches(queryClient, {
      filmOrderId: 'FO-1',
      jobNumber: '2941',
      reason: 'Deleted from Film Orders',
      resolvedAt: '2026-04-06T12:30:00Z'
    });

    expect(result).toEqual({
      removedJobNumbers: ['2941'],
      releasedBoxIds: ['IL1-6396']
    });
    expect(queryClient.getQueryData(inventoryKeys.filmOrders)).toEqual([]);
    expect(queryClient.getQueryData(inventoryKeys.job('2941'))).toMatchObject({
      summary: {
        status: 'ALLOCATE',
        allocatedFeet: 0,
        remainingFeet: 60,
        allocationCount: 0,
        filmOrderCount: 0
      },
      allocations: [],
      filmOrders: [],
      requirements: [
        expect.objectContaining({
          requirementId: 'req-72',
          allocatedFeet: 0,
          remainingFeet: 60
        })
      ]
    });
    expect(queryClient.getQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }))).toEqual([
      expect.objectContaining({
        jobNumber: '2941',
        status: 'ALLOCATE',
        filmOrderCount: 0,
        hasOrderedAllocations: false,
        allocatedFeet: 0,
        remainingFeet: 60
      })
    ]);
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('2941'))).toMatchObject({
      summary: {
        status: 'ALLOCATE',
        activeAllocatedFeet: 0,
        openFilmOrderCount: 0,
        boxCount: 0,
        hasOrderedAllocations: false
      },
      allocations: [],
      filmOrders: []
    });
    expect(queryClient.getQueryData(inventoryKeys.allocationJobs)).toEqual([
      expect.objectContaining({
        jobNumber: '2941',
        status: 'ALLOCATE',
        activeAllocatedFeet: 0,
        openFilmOrderCount: 0,
        boxCount: 0,
        hasOrderedAllocations: false
      })
    ]);
    expect(queryClient.getQueryData(inventoryKeys.box('IL1-6396'))).toMatchObject({
      feetAvailable: 20
    });
    expect(queryClient.getQueryData(inventoryKeys.allocations('IL1-6396'))).toEqual([
      expect.objectContaining({
        allocationId: 'alloc-fo-1',
        status: 'CANCELLED',
        resolvedBy: 'Pending...',
        notes: 'Deleted from Film Orders'
      })
    ]);
  });

  it('falls back to summary-only cache updates when detail queries are not loaded', () => {
    const queryClient = createQueryClient();
    const filmOrder = buildFilmOrderEntry();

    queryClient.setQueryData(inventoryKeys.filmOrders, [filmOrder]);
    queryClient.setQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }), [
      {
        jobNumber: '2941',
        warehouse: 'IL1',
        sections: null,
        dueDate: '2026-04-13',
        crewLeader: 'Crew',
        status: 'FILM_ORDER' as const,
        lifecycleStatus: 'ACTIVE' as const,
        isLaborOnly: false,
        isStagedForPickup: false,
        requiredFeet: 60,
        allocatedFeet: 16,
        remainingFeet: 44,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        requirementCount: 1,
        allocationCount: 1,
        filmOrderCount: 1,
        hasOrderedAllocations: false,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
        notes: ''
      }
    ]);
    queryClient.setQueryData(inventoryKeys.allocationJobs, [
      {
        jobNumber: '2941',
        jobDate: '2026-04-13',
        crewLeader: 'Crew',
        status: 'FILM_ORDER',
        activeAllocatedFeet: 16,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 1,
        boxCount: 1,
        hasOrderedAllocations: false
      }
    ]);

    applyOptimisticFilmOrderDeletionToCaches(queryClient, {
      filmOrderId: 'FO-1',
      jobNumber: '2941',
      resolvedAt: '2026-04-06T12:30:00Z'
    });

    expect(queryClient.getQueryData(inventoryKeys.filmOrders)).toEqual([]);
    expect(queryClient.getQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }))).toEqual([
      expect.objectContaining({
        jobNumber: '2941',
        filmOrderCount: 0,
        hasOrderedAllocations: false,
        updatedAt: '2026-04-06T12:30:00Z'
      })
    ]);
    expect(queryClient.getQueryData(inventoryKeys.allocationJobs)).toEqual([
      expect.objectContaining({
        jobNumber: '2941',
        openFilmOrderCount: 0
      })
    ]);
  });

  it('restores film-order deletion snapshots together on rollback', () => {
    const queryClient = createQueryClient();
    const filmOrder = buildFilmOrderEntry();
    const allocation = {
      allocationId: 'alloc-fo-1',
      boxId: 'IL1-6396',
      warehouse: 'IL1',
      jobNumber: '2941',
      jobDate: '2026-04-13',
      crewLeader: 'Crew',
      allocatedFeet: 16,
      coveredFeet: 16,
      requirementId: 'req-72',
      allocationKind: 'REQUIREMENT' as const,
      status: 'ACTIVE' as const,
      createdAt: '2026-04-06T00:00:00Z',
      createdBy: 'tester',
      resolvedAt: '',
      resolvedBy: '',
      filmOrderId: 'FO-1',
      notes: '',
      manufacturer: '3M Solar',
      filmName: 'Prestige 60 Exterior',
      widthIn: 72,
      boxStatus: 'IN_STOCK' as const,
      checkedOutOnThisJob: false
    };
    const jobDetail: JobDetail = {
      summary: {
        jobNumber: '2941',
        warehouse: 'IL1',
        sections: null,
        dueDate: '2026-04-13',
        crewLeader: 'Crew',
        status: 'FILM_ORDER',
        lifecycleStatus: 'ACTIVE',
        isLaborOnly: false,
        isStagedForPickup: false,
        requiredFeet: 60,
        allocatedFeet: 16,
        remainingFeet: 44,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        requirementCount: 1,
        allocationCount: 1,
        filmOrderCount: 1,
        hasOrderedAllocations: false,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
        notes: ''
      },
      requirements: [
        {
          requirementId: 'req-72',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60',
          widthIn: 72,
          requiredFeet: 60,
          allocatedFeet: 16,
          remainingFeet: 44
        }
      ],
      allocations: [allocation],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: [filmOrder]
    };

    queryClient.setQueryData(inventoryKeys.filmOrders, [filmOrder]);
    queryClient.setQueryData(inventoryKeys.job('2941'), jobDetail);
    queryClient.setQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }), [
      jobDetail.summary
    ]);
    queryClient.setQueryData(inventoryKeys.allocationJob('2941'), {
      summary: {
        jobNumber: '2941',
        jobDate: '2026-04-13',
        crewLeader: 'Crew',
        status: 'FILM_ORDER',
        activeAllocatedFeet: 16,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 1,
        boxCount: 1,
        hasOrderedAllocations: false
      },
      allocations: [allocation],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: [filmOrder]
    });
    queryClient.setQueryData(inventoryKeys.allocationJobs, [
      {
        jobNumber: '2941',
        jobDate: '2026-04-13',
        crewLeader: 'Crew',
        status: 'FILM_ORDER',
        activeAllocatedFeet: 16,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 1,
        boxCount: 1,
        hasOrderedAllocations: false
      }
    ]);
    queryClient.setQueryData(inventoryKeys.box('IL1-6396'), {
      boxId: 'IL1-6396',
      warehouse: 'IL1',
      manufacturer: '3M Solar',
      filmName: 'Prestige 60 Exterior',
      widthIn: 72,
      initialFeet: 20,
      feetAvailable: 4,
      lotRun: '',
      status: 'IN_STOCK',
      orderDate: '2026-04-01',
      receivedDate: '2026-04-02',
      initialWeightLbs: null,
      lastRollWeightLbs: null,
      lastWeighedDate: '',
      filmKey: '3M SOLAR|PRESTIGE 60 EXTERIOR',
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
      queryClient.getQueryData(inventoryKeys.box('IL1-6396'))
    ]);
    queryClient.setQueryData(inventoryKeys.allocations('IL1-6396'), [
      {
        allocationId: 'alloc-fo-1',
        boxId: 'IL1-6396',
        warehouse: 'IL1',
        jobNumber: '2941',
        jobDate: '2026-04-13',
        crewLeader: 'Crew',
        allocatedFeet: 16,
        status: 'ACTIVE',
        createdAt: '2026-04-06T00:00:00Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: 'FO-1',
        notes: ''
      }
    ]);

    const context = beginImmediateOptimisticMutation(
      queryClient,
      [
        inventoryKeys.filmOrders,
        inventoryKeys.jobs,
        inventoryKeys.jobRoot,
        inventoryKeys.allocationJobs,
        inventoryKeys.allocationJobRoot,
        inventoryKeys.boxRoot,
        inventoryKeys.listRoot,
        inventoryKeys.allocationsRoot
      ],
      () =>
        applyOptimisticFilmOrderDeletionToCaches(queryClient, {
          filmOrderId: 'FO-1',
          jobNumber: '2941',
          reason: 'Deleted from Film Orders',
          resolvedAt: '2026-04-06T12:30:00Z'
        })
    );

    restoreSnapshots(queryClient, context.snapshots);

    expect(queryClient.getQueryData(inventoryKeys.filmOrders)).toEqual([filmOrder]);
    expect(queryClient.getQueryData(inventoryKeys.job('2941'))).toEqual(jobDetail);
    expect(queryClient.getQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }))).toEqual([
      jobDetail.summary
    ]);
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('2941'))).toMatchObject({
      summary: {
        status: 'FILM_ORDER',
        activeAllocatedFeet: 16,
        openFilmOrderCount: 1,
        boxCount: 1,
        hasOrderedAllocations: false
      },
      allocations: [expect.objectContaining({ allocationId: 'alloc-fo-1', status: 'ACTIVE' })],
      filmOrders: [filmOrder]
    });
    expect(queryClient.getQueryData(inventoryKeys.allocationJobs)).toEqual([
      expect.objectContaining({
        jobNumber: '2941',
        status: 'FILM_ORDER',
        activeAllocatedFeet: 16,
        openFilmOrderCount: 1,
        boxCount: 1,
        hasOrderedAllocations: false
      })
    ]);
    expect(queryClient.getQueryData(inventoryKeys.box('IL1-6396'))).toMatchObject({
      feetAvailable: 4
    });
    expect(queryClient.getQueryData(inventoryKeys.allocations('IL1-6396'))).toEqual([
      expect.objectContaining({
        allocationId: 'alloc-fo-1',
        status: 'ACTIVE',
        filmOrderId: 'FO-1'
      })
    ]);
  });

  it('syncs an edited install date into linked unresolved film-order caches immediately', () => {
    const queryClient = createQueryClient();
    const openFilmOrder = buildFilmOrderEntry({
      filmOrderId: 'FO-OPEN',
      jobDate: '',
      crewLeader: 'Old Crew',
      status: 'FILM_ORDER'
    });
    const resolvedFilmOrder = buildFilmOrderEntry({
      filmOrderId: 'FO-DONE',
      jobDate: '2026-04-01',
      crewLeader: 'Old Crew',
      status: 'FULFILLED',
      resolvedAt: '2026-04-02T00:00:00Z'
    });
    const jobDetail: JobDetail = {
      summary: {
        jobNumber: '2941',
        warehouse: 'IL1',
        sections: null,
        dueDate: '',
        crewLeader: 'Old Crew',
        status: 'FILM_ORDER',
        lifecycleStatus: 'ACTIVE',
        isLaborOnly: false,
        isStagedForPickup: false,
        requiredFeet: 60,
        allocatedFeet: 16,
        remainingFeet: 44,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        requirementCount: 1,
        allocationCount: 1,
        filmOrderCount: 2,
        hasOrderedAllocations: false,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
        notes: ''
      },
      requirements: [
        {
          requirementId: 'req-72',
          manufacturer: '3M Solar',
          filmName: 'Prestige 60',
          widthIn: 72,
          requiredFeet: 60,
          allocatedFeet: 16,
          remainingFeet: 44
        }
      ],
      allocations: [],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: [openFilmOrder, resolvedFilmOrder]
    };

    queryClient.setQueryData(inventoryKeys.job('2941'), jobDetail);
    queryClient.setQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }), [
      jobDetail.summary
    ]);
    queryClient.setQueryData(
      inventoryKeys.jobsSearchResults({ query: '2941', limit: 5, lifecycleStatus: 'ACTIVE' }),
      [jobDetail.summary]
    );
    queryClient.setQueryData(inventoryKeys.allocationJobs, [
      {
        jobNumber: '2941',
        jobDate: '',
        crewLeader: 'Old Crew',
        status: 'FILM_ORDER',
        activeAllocatedFeet: 16,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 1,
        boxCount: 1,
        hasOrderedAllocations: false
      }
    ]);
    queryClient.setQueryData(inventoryKeys.allocationJob('2941'), {
      summary: {
        jobNumber: '2941',
        jobDate: '',
        crewLeader: 'Old Crew',
        status: 'FILM_ORDER',
        activeAllocatedFeet: 16,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 1,
        boxCount: 1,
        hasOrderedAllocations: false
      },
      allocations: [],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: [openFilmOrder, resolvedFilmOrder]
    });
    queryClient.setQueryData(inventoryKeys.filmOrders, [openFilmOrder, resolvedFilmOrder]);

    applyOptimisticJobScheduleSyncToCaches(queryClient, {
      jobNumber: '2941',
      dueDate: '2026-04-13'
    });

    expect(queryClient.getQueryData<JobDetail>(inventoryKeys.job('2941'))).toMatchObject({
      summary: {
        dueDate: '2026-04-13'
      },
      filmOrders: [
        expect.objectContaining({
          filmOrderId: 'FO-OPEN',
          jobDate: '2026-04-13'
        }),
        expect.objectContaining({
          filmOrderId: 'FO-DONE',
          jobDate: '2026-04-01'
        })
      ]
    });
    expect(queryClient.getQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }))).toEqual([
      expect.objectContaining({
        jobNumber: '2941',
        dueDate: '2026-04-13'
      })
    ]);
    expect(
      queryClient.getQueryData(
        inventoryKeys.jobsSearchResults({ query: '2941', limit: 5, lifecycleStatus: 'ACTIVE' })
      )
    ).toEqual([
      expect.objectContaining({
        jobNumber: '2941',
        dueDate: '2026-04-13'
      })
    ]);
    expect(queryClient.getQueryData(inventoryKeys.allocationJobs)).toEqual([
      expect.objectContaining({
        jobNumber: '2941',
        jobDate: '2026-04-13'
      })
    ]);
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('2941'))).toMatchObject({
      summary: {
        jobDate: '2026-04-13'
      },
      filmOrders: [
        expect.objectContaining({
          filmOrderId: 'FO-OPEN',
          jobDate: '2026-04-13'
        }),
        expect.objectContaining({
          filmOrderId: 'FO-DONE',
          jobDate: '2026-04-01'
        })
      ]
    });
    expect(queryClient.getQueryData(inventoryKeys.filmOrders)).toEqual([
      expect.objectContaining({
        filmOrderId: 'FO-OPEN',
        jobDate: '2026-04-13'
      }),
      expect.objectContaining({
        filmOrderId: 'FO-DONE',
        jobDate: '2026-04-01'
      })
    ]);
  });

  it('clears the install date from unresolved linked film orders immediately when the job date is removed', () => {
    const queryClient = createQueryClient();
    const openFilmOrder = buildFilmOrderEntry({
      filmOrderId: 'FO-OPEN',
      jobDate: '2026-04-13'
    });
    const resolvedFilmOrder = buildFilmOrderEntry({
      filmOrderId: 'FO-DONE',
      jobDate: '2026-04-01',
      status: 'CANCELLED',
      resolvedAt: '2026-04-02T00:00:00Z'
    });

    queryClient.setQueryData(inventoryKeys.job('2941'), {
      summary: {
        jobNumber: '2941',
        warehouse: 'IL1',
        sections: null,
        dueDate: '2026-04-13',
        crewLeader: 'Crew',
        status: 'FILM_ORDER',
        lifecycleStatus: 'ACTIVE',
        isLaborOnly: false,
        isStagedForPickup: false,
        requiredFeet: 60,
        allocatedFeet: 0,
        remainingFeet: 60,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        requirementCount: 1,
        allocationCount: 0,
        filmOrderCount: 2,
        hasOrderedAllocations: false,
        createdAt: '2026-04-06T00:00:00Z',
        updatedAt: '2026-04-06T00:00:00Z',
        notes: ''
      },
      requirements: [],
      allocations: [],
      usage: [],
      usageTimeline: [],
      caulkRequirements: [],
      caulkAllocations: [],
      caulkCheckouts: [],
      filmOrders: [openFilmOrder, resolvedFilmOrder]
    });
    queryClient.setQueryData(inventoryKeys.allocationJobs, [
      {
        jobNumber: '2941',
        jobDate: '2026-04-13',
        crewLeader: 'Crew',
        status: 'FILM_ORDER',
        activeAllocatedFeet: 0,
        fulfilledAllocatedFeet: 0,
        requiredTubes: 0,
        allocatedTubes: 0,
        remainingTubes: 0,
        openFilmOrderCount: 1,
        boxCount: 0,
        hasOrderedAllocations: false
      }
    ]);
    queryClient.setQueryData(inventoryKeys.filmOrders, [openFilmOrder, resolvedFilmOrder]);

    applyOptimisticJobScheduleSyncToCaches(queryClient, {
      jobNumber: '2941',
      dueDate: ''
    });

    expect(queryClient.getQueryData<JobDetail>(inventoryKeys.job('2941'))).toMatchObject({
      summary: {
        dueDate: ''
      },
      filmOrders: [
        expect.objectContaining({
          filmOrderId: 'FO-OPEN',
          jobDate: ''
        }),
        expect.objectContaining({
          filmOrderId: 'FO-DONE',
          jobDate: '2026-04-01'
        })
      ]
    });
    expect(queryClient.getQueryData(inventoryKeys.allocationJobs)).toEqual([
      expect.objectContaining({
        jobNumber: '2941',
        jobDate: ''
      })
    ]);
    expect(queryClient.getQueryData(inventoryKeys.filmOrders)).toEqual([
      expect.objectContaining({
        filmOrderId: 'FO-OPEN',
        jobDate: ''
      }),
      expect.objectContaining({
        filmOrderId: 'FO-DONE',
        jobDate: '2026-04-01'
      })
    ]);
  });
});
