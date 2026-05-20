import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { AllocationJobSummary, JobDetail, JobListEntry } from '../../../domain';
import { inventoryKeys } from '../hooks/inventoryQueryKeys';
import {
  applyOptimisticJobScheduleSyncToCaches,
  syncJobDetailCaches,
  syncJobSummaryCachesFromDetail,
  upsertAllocationJobSummaryCaches,
  upsertJobListCaches,
  upsertJobsCalendarCaches
} from './jobCacheCollections';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
}

function buildJobSummary(jobId: string, workScope: string, crewLeader: string): JobListEntry {
  return {
    jobId,
    jobNumber: '1234',
    routeTarget: `/allocations/jobs/${jobId}`,
    warehouse: 'IL1',
    workScope,
    sections: workScope,
    installDate: '2026-05-01',
    crewLeader,
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
    notes: ''
  };
}

function buildAllocationSummary(jobId: string, workScope: string, crewLeader: string): AllocationJobSummary {
  return {
    jobId,
    jobNumber: '1234',
    workScope,
    sections: workScope,
    installDate: '2026-05-01',
    crewLeader,
    status: 'FILM_ORDER',
    activeAllocatedFeet: 0,
    fulfilledAllocatedFeet: 0,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    openFilmOrderCount: 0,
    boxCount: 0,
    hasOrderedAllocations: false
  };
}

function buildJobDetail(summary: JobListEntry): JobDetail {
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

describe('job cache identity', () => {
  it('prefers jobId over jobNumber when upserting list, calendar, and allocation summaries', () => {
    const queryClient = createQueryClient();
    const jobA = buildJobSummary('11111111-1111-4111-8111-111111111111', 'Section 1', 'Crew A');
    const jobB = buildJobSummary('22222222-2222-4222-8222-222222222222', 'Section 4', 'Crew B');
    const nextJobA = { ...jobA, crewLeader: 'Crew A Updated' };
    const jobsListKey = inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' });
    const calendarKey = inventoryKeys.jobsCalendarPeriod({
      view: 'week',
      anchorDate: '2026-05-01',
      lifecycleStatus: 'ACTIVE'
    });

    queryClient.setQueryData(jobsListKey, [jobA, jobB]);
    queryClient.setQueryData(calendarKey, [jobA, jobB]);
    queryClient.setQueryData(inventoryKeys.allocationJobs, [
      buildAllocationSummary(jobA.jobId!, 'Section 1', 'Crew A'),
      buildAllocationSummary(jobB.jobId!, 'Section 4', 'Crew B')
    ]);

    upsertJobListCaches(queryClient, nextJobA);
    upsertJobsCalendarCaches(queryClient, nextJobA);
    upsertAllocationJobSummaryCaches(
      queryClient,
      buildAllocationSummary(jobA.jobId!, 'Section 1', 'Crew A Updated')
    );

    expect(queryClient.getQueryData(jobsListKey)).toEqual([nextJobA, jobB]);
    expect(queryClient.getQueryData(calendarKey)).toEqual([nextJobA, jobB]);
    expect(queryClient.getQueryData(inventoryKeys.allocationJobs)).toEqual([
      buildAllocationSummary(jobA.jobId!, 'Section 1', 'Crew A Updated'),
      buildAllocationSummary(jobB.jobId!, 'Section 4', 'Crew B')
    ]);
  });

  it('falls back to jobNumber when replacing legacy cache entries without job ids', () => {
    const queryClient = createQueryClient();
    const jobA = buildJobSummary('11111111-1111-4111-8111-111111111111', 'Section 1', 'Crew A');
    const legacyJobA = { ...jobA, jobId: '' };
    const nextJobA = { ...jobA, crewLeader: 'Crew A Updated' };
    const jobsListKey = inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' });
    const calendarKey = inventoryKeys.jobsCalendarPeriod({
      view: 'week',
      anchorDate: '2026-05-01',
      lifecycleStatus: 'ACTIVE'
    });

    queryClient.setQueryData(jobsListKey, [legacyJobA]);
    queryClient.setQueryData(calendarKey, [legacyJobA]);
    queryClient.setQueryData(inventoryKeys.allocationJobs, [
      { ...buildAllocationSummary(jobA.jobId!, 'Section 1', 'Crew A'), jobId: '' }
    ]);

    upsertJobListCaches(queryClient, nextJobA);
    upsertJobsCalendarCaches(queryClient, nextJobA);
    upsertAllocationJobSummaryCaches(
      queryClient,
      buildAllocationSummary(jobA.jobId!, 'Section 1', 'Crew A Updated')
    );

    expect(queryClient.getQueryData(jobsListKey)).toEqual([nextJobA]);
    expect(queryClient.getQueryData(calendarKey)).toEqual([nextJobA]);
    expect(queryClient.getQueryData(inventoryKeys.allocationJobs)).toEqual([
      buildAllocationSummary(jobA.jobId!, 'Section 1', 'Crew A Updated')
    ]);
  });

  it('can hydrate summaries from jobId detail without populating legacy jobNumber detail caches', () => {
    const queryClient = createQueryClient();
    const summary = buildJobSummary('11111111-1111-4111-8111-111111111111', 'Section 1', 'Crew A');
    const jobsListKey = inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' });

    queryClient.setQueryData(jobsListKey, []);
    queryClient.setQueryData(inventoryKeys.allocationJobs, []);

    syncJobSummaryCachesFromDetail(queryClient, buildJobDetail(summary));

    expect(queryClient.getQueryData(inventoryKeys.job('1234'))).toBeUndefined();
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('1234'))).toBeUndefined();
    expect(queryClient.getQueryData(jobsListKey)).toEqual([summary]);
    expect(queryClient.getQueryData(inventoryKeys.allocationJobs)).toEqual([
      expect.objectContaining({
        jobId: summary.jobId,
        jobNumber: summary.jobNumber,
        crewLeader: summary.crewLeader,
        status: summary.status
      })
    ]);
  });

  it('can sync canonical jobId detail without seeding legacy jobNumber detail caches', () => {
    const queryClient = createQueryClient();
    const summary = buildJobSummary('11111111-1111-4111-8111-111111111111', 'Section 1', 'Crew A');
    const detail = buildJobDetail(summary);

    syncJobDetailCaches(queryClient, detail, {
      syncLegacyJobDetail: false,
      syncAllocationJobDetail: true
    });

    expect(queryClient.getQueryData(inventoryKeys.jobById(summary.jobId!))).toEqual(detail);
    expect(queryClient.getQueryData(inventoryKeys.job(summary.jobNumber))).toBeUndefined();
    expect(queryClient.getQueryData(inventoryKeys.allocationJob(summary.jobNumber))).toBeUndefined();
  });

  it('patches optimistic schedule caches by jobId without changing same-number sibling rows', () => {
    const queryClient = createQueryClient();
    const jobA = buildJobSummary('11111111-1111-4111-8111-111111111111', 'Section 1', 'Crew A');
    const jobB = buildJobSummary('22222222-2222-4222-8222-222222222222', 'Section 2', 'Crew B');
    const jobsListKey = inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' });
    const calendarKey = inventoryKeys.jobsCalendarPeriod({
      view: 'week',
      anchorDate: '2026-05-01',
      lifecycleStatus: 'ACTIVE'
    });
    const searchKey = inventoryKeys.jobsSearchResults({
      query: '1234',
      limit: 25,
      lifecycleStatus: 'ACTIVE'
    });

    queryClient.setQueryData(inventoryKeys.jobById(jobA.jobId!), buildJobDetail(jobA));
    queryClient.setQueryData(inventoryKeys.jobById(jobB.jobId!), buildJobDetail(jobB));
    queryClient.setQueryData(jobsListKey, [jobA, jobB]);
    queryClient.setQueryData(calendarKey, [jobA, jobB]);
    queryClient.setQueryData(searchKey, [jobA, jobB]);
    queryClient.setQueryData(inventoryKeys.allocationJobs, [
      buildAllocationSummary(jobA.jobId!, 'Section 1', 'Crew A'),
      buildAllocationSummary(jobB.jobId!, 'Section 2', 'Crew B')
    ]);
    queryClient.setQueryData(inventoryKeys.filmOrders, [
      {
        filmOrderId: 'FO-A',
        jobId: jobA.jobId,
        jobNumber: jobA.jobNumber,
        warehouse: 'IL1',
        manufacturer: '3M',
        filmName: 'Film',
        widthIn: 60,
        requestedFeet: 10,
        coveredFeet: 0,
        orderedFeet: 0,
        remainingToOrderFeet: 10,
        installDate: jobA.installDate,
        crewLeader: jobA.crewLeader,
        status: 'FILM_ORDER',
        sourceBoxId: '',
        origin: 'MANUAL',
        createdAt: '',
        createdBy: '',
        resolvedAt: '',
        resolvedBy: '',
        notes: '',
        linkedBoxes: []
      },
      {
        filmOrderId: 'FO-B',
        jobId: jobB.jobId,
        jobNumber: jobB.jobNumber,
        warehouse: 'IL1',
        manufacturer: '3M',
        filmName: 'Film',
        widthIn: 60,
        requestedFeet: 10,
        coveredFeet: 0,
        orderedFeet: 0,
        remainingToOrderFeet: 10,
        installDate: jobB.installDate,
        crewLeader: jobB.crewLeader,
        status: 'FILM_ORDER',
        sourceBoxId: '',
        origin: 'MANUAL',
        createdAt: '',
        createdBy: '',
        resolvedAt: '',
        resolvedBy: '',
        notes: '',
        linkedBoxes: []
      }
    ]);

    applyOptimisticJobScheduleSyncToCaches(queryClient, {
      jobId: jobA.jobId,
      jobNumber: jobA.jobNumber,
      installDate: '2026-05-03',
      crewLeader: 'Crew A Updated'
    });

    expect(queryClient.getQueryData<JobListEntry[]>(jobsListKey)).toEqual([
      expect.objectContaining({ jobId: jobA.jobId, installDate: '2026-05-03', crewLeader: 'Crew A Updated' }),
      jobB
    ]);
    expect(queryClient.getQueryData<JobListEntry[]>(calendarKey)).toEqual([
      expect.objectContaining({ jobId: jobA.jobId, installDate: '2026-05-03', crewLeader: 'Crew A Updated' }),
      jobB
    ]);
    expect(queryClient.getQueryData<JobListEntry[]>(searchKey)).toEqual([
      expect.objectContaining({ jobId: jobA.jobId, installDate: '2026-05-03', crewLeader: 'Crew A Updated' }),
      jobB
    ]);
    expect(queryClient.getQueryData(inventoryKeys.allocationJobs)).toEqual([
      expect.objectContaining({ jobId: jobA.jobId, installDate: '2026-05-03', crewLeader: 'Crew A Updated' }),
      buildAllocationSummary(jobB.jobId!, 'Section 2', 'Crew B')
    ]);
    expect(queryClient.getQueryData(inventoryKeys.job(jobA.jobNumber))).toBeUndefined();
    expect(queryClient.getQueryData(inventoryKeys.allocationJob(jobA.jobNumber))).toBeUndefined();
    expect(queryClient.getQueryData(inventoryKeys.filmOrders)).toEqual([
      expect.objectContaining({ filmOrderId: 'FO-A', installDate: '2026-05-03', crewLeader: 'Crew A Updated' }),
      expect.objectContaining({ filmOrderId: 'FO-B', installDate: jobB.installDate, crewLeader: jobB.crewLeader })
    ]);
  });
});
