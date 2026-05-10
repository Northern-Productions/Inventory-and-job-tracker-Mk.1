// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { JobDetail, JobListEntry } from '../../../../../domain';
import { inventoryKeys } from '../../inventoryQueryKeys';
import { useUpdateJob } from './jobLifecycleMutations';

const updateJobMock = vi.fn();

vi.mock('../../../../../api/features/jobsClient', () => ({
  cancelJob: vi.fn(),
  completeJob: vi.fn(),
  createJob: vi.fn(),
  deleteJob: vi.fn(),
  reopenJob: vi.fn(),
  updateJob: (...args: unknown[]) => updateJobMock(...args)
}));

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
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

describe('useUpdateJob identity caches', () => {
  it('canonical update syncs jobById and leaves legacy detail caches alone', async () => {
    const queryClient = createQueryClient();
    const before = buildDetail();
    const after = buildDetail(
      buildSummary({
        workScope: 'Section 2',
        sections: 'Section 2',
        installDate: '2026-05-02',
        crewLeader: 'Crew B'
      })
    );

    queryClient.setQueryData(inventoryKeys.jobById(before.summary.jobId!), before);
    queryClient.setQueryData(inventoryKeys.job(before.summary.jobNumber), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob(before.summary.jobNumber), {
      source: 'legacy-allocation-job'
    });
    updateJobMock.mockResolvedValueOnce({ result: after, warnings: [] });

    const { result } = renderHook(() => useUpdateJob(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobId: before.summary.jobId,
        jobNumber: before.summary.jobNumber,
        workScope: 'Section 2',
        sections: 'Section 2',
        installDate: '2026-05-02',
        crewLeader: 'Crew B',
        requirements: [],
        caulkRequirements: []
      });
    });

    expect(queryClient.getQueryData<JobDetail>(inventoryKeys.jobById(before.summary.jobId!))?.summary).toEqual(
      expect.objectContaining({ workScope: 'Section 2', crewLeader: 'Crew B' })
    );
    expect(queryClient.getQueryData(inventoryKeys.job(before.summary.jobNumber))).toEqual({
      source: 'legacy-job'
    });
    expect(queryClient.getQueryData(inventoryKeys.allocationJob(before.summary.jobNumber))).toEqual({
      source: 'legacy-allocation-job'
    });
  });
});
