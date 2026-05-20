import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { FilmOrderEntry, JobDetail, JobListEntry } from '../../../domain';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';
import { applyOptimisticJobUpdateToCaches } from './jobOptimisticUpdates';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
}

function buildSummary(overrides: Partial<JobListEntry> = {}): JobListEntry {
  return {
    jobId: '11111111-1111-4111-8111-111111111111',
    jobNumber: '1234',
    routeTarget: '/allocations/jobs/11111111-1111-4111-8111-111111111111',
    warehouse: 'IL1',
    workScope: 'Section 1',
    sections: 'Section 1',
    installDate: '2026-05-01',
    crewLeader: 'Crew A',
    status: 'FILM_ORDER',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isStagedForPickup: false,
    requiredFeet: 10,
    allocatedFeet: 0,
    remainingFeet: 10,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 1,
    allocationCount: 0,
    filmOrderCount: 0,
    hasOrderedAllocations: false,
    createdAt: '',
    updatedAt: '',
    notes: '',
    ...overrides
  };
}

function buildDetail(summary = buildSummary()): JobDetail {
  return {
    summary,
    requirements: [],
    allocations: [],
    usage: [],
    usageTimeline: [],
    caulkRequirements: [],
    caulkAllocations: [],
    caulkCheckouts: [],
    filmOrders: [],
    filmTransferAlerts: [],
    caulkTransferAlerts: []
  };
}

function buildFilmOrder(overrides: Partial<FilmOrderEntry> = {}): FilmOrderEntry {
  return {
    filmOrderId: 'FO-1',
    jobNumber: '1234',
    warehouse: 'IL1',
    manufacturer: '3M',
    filmName: 'Film',
    widthIn: 60,
    requestedFeet: 10,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: 10,
    installDate: '2026-05-01',
    crewLeader: 'Crew A',
    status: 'FILM_ORDER',
    sourceBoxId: '',
    origin: 'MANUAL',
    createdAt: '',
    createdBy: '',
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    linkedBoxes: [],
    ...overrides
  };
}

describe('optimistic job update identity', () => {
  it('updates canonical jobId detail without seeding same-number legacy detail caches', () => {
    const queryClient = createQueryClient();
    const detail = buildDetail();

    queryClient.setQueryData(inventoryKeys.jobById(detail.summary.jobId!), detail);

    applyOptimisticJobUpdateToCaches(queryClient, {
      jobId: detail.summary.jobId,
      jobNumber: detail.summary.jobNumber,
      workScope: 'Section 2',
      sections: 'Section 2',
      installDate: '2026-05-02',
      crewLeader: 'Crew B',
      requirements: [],
      caulkRequirements: []
    });

    expect(queryClient.getQueryData<JobDetail>(inventoryKeys.jobById(detail.summary.jobId!))?.summary).toEqual(
      expect.objectContaining({
        jobId: detail.summary.jobId,
        jobNumber: detail.summary.jobNumber,
        workScope: 'Section 2',
        sections: 'Section 2',
        installDate: '2026-05-02',
        crewLeader: 'Crew B'
      })
    );
    expect(queryClient.getQueryData(inventoryKeys.job(detail.summary.jobNumber))).toBeUndefined();
    expect(queryClient.getQueryData(inventoryKeys.allocationJob(detail.summary.jobNumber))).toBeUndefined();
  });

  it('preserves legacy jobNumber optimistic detail cache behavior', () => {
    const queryClient = createQueryClient();
    const detail = buildDetail();

    queryClient.setQueryData(inventoryKeys.job(detail.summary.jobNumber), detail);

    applyOptimisticJobUpdateToCaches(queryClient, {
      jobNumber: detail.summary.jobNumber,
      workScope: 'Section 2',
      sections: 'Section 2',
      installDate: '2026-05-02',
      crewLeader: 'Crew B',
      requirements: [],
      caulkRequirements: []
    });

    expect(queryClient.getQueryData<JobDetail>(inventoryKeys.job(detail.summary.jobNumber))?.summary).toEqual(
      expect.objectContaining({
        workScope: 'Section 2',
        installDate: '2026-05-02',
        crewLeader: 'Crew B'
      })
    );
  });

  it('patches film order schedules by jobId for canonical duplicate jobs', () => {
    const queryClient = createQueryClient();
    const siblingJobId = '22222222-2222-4222-8222-222222222222';

    queryClient.setQueryData(inventoryKeys.filmOrders, [
      buildFilmOrder({
        filmOrderId: 'FO-1',
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '1234'
      }),
      buildFilmOrder({ filmOrderId: 'FO-2', jobId: siblingJobId, jobNumber: '1234' }),
      buildFilmOrder({ filmOrderId: 'FO-LEGACY', jobNumber: '1234' })
    ]);

    applyOptimisticJobUpdateToCaches(queryClient, {
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '1234',
      installDate: '2026-05-02',
      crewLeader: 'Crew B',
      requirements: [],
      caulkRequirements: []
    });

    expect(queryClient.getQueryData<FilmOrderEntry[]>(inventoryKeys.filmOrders)).toEqual([
      expect.objectContaining({ filmOrderId: 'FO-1', installDate: '2026-05-02', crewLeader: 'Crew B' }),
      expect.objectContaining({ filmOrderId: 'FO-2', installDate: '2026-05-01', crewLeader: 'Crew A' }),
      expect.objectContaining({ filmOrderId: 'FO-LEGACY', installDate: '2026-05-01', crewLeader: 'Crew A' })
    ]);
  });

  it('preserves legacy jobNumber film order schedule patching when no jobId is supplied', () => {
    const queryClient = createQueryClient();

    queryClient.setQueryData(inventoryKeys.filmOrders, [
      buildFilmOrder({ filmOrderId: 'FO-1', jobNumber: '1234' }),
      buildFilmOrder({ filmOrderId: 'FO-2', jobNumber: '5678' })
    ]);

    applyOptimisticJobUpdateToCaches(queryClient, {
      jobNumber: '1234',
      installDate: '2026-05-02',
      crewLeader: 'Crew B',
      requirements: [],
      caulkRequirements: []
    });

    expect(queryClient.getQueryData<FilmOrderEntry[]>(inventoryKeys.filmOrders)).toEqual([
      expect.objectContaining({ filmOrderId: 'FO-1', installDate: '2026-05-02', crewLeader: 'Crew B' }),
      expect.objectContaining({ filmOrderId: 'FO-2', installDate: '2026-05-01', crewLeader: 'Crew A' })
    ]);
  });
});
