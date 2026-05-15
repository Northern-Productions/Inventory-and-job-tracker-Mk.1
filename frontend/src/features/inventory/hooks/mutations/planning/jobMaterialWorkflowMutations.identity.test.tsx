// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { JobDetail, JobListEntry } from '../../../../../domain';
import { inventoryKeys } from '../../inventoryQueryKeys';
import { useCheckoutAllJobMaterials } from './jobMaterialWorkflowMutations';

const checkoutAllJobMaterialsMock = vi.fn();

vi.mock('../../../../../api/features/jobsClient', () => ({
  checkoutAllJobMaterials: (...args: unknown[]) => checkoutAllJobMaterialsMock(...args),
  setJobStagedForPickup: vi.fn()
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
    status: 'READY',
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

describe('useCheckoutAllJobMaterials identity caches', () => {
  it('canonical checkout-all invalidates jobById and leaves same-number legacy detail caches alone', async () => {
    const queryClient = createQueryClient();
    const before = buildDetail();
    const after = buildDetail(buildSummary({ status: 'CHECKED_OUT' }));

    queryClient.setQueryData(inventoryKeys.jobById(before.summary.jobId!), before);
    queryClient.setQueryData(inventoryKeys.job(before.summary.jobNumber), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob(before.summary.jobNumber), {
      source: 'legacy-allocation-job'
    });
    checkoutAllJobMaterialsMock.mockResolvedValueOnce({ result: after, warnings: [] });

    const { result } = renderHook(() => useCheckoutAllJobMaterials(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobId: before.summary.jobId,
        jobNumber: before.summary.jobNumber
      });
    });

    expect(checkoutAllJobMaterialsMock).toHaveBeenCalledWith({
      jobId: before.summary.jobId,
      jobNumber: before.summary.jobNumber
    });
    expect(queryClient.getQueryData<JobDetail>(inventoryKeys.jobById(before.summary.jobId!))?.summary).toEqual(
      expect.objectContaining({ status: 'CHECKED_OUT' })
    );
    expect(queryClient.getQueryData(inventoryKeys.job(before.summary.jobNumber))).toEqual({
      source: 'legacy-job'
    });
    expect(queryClient.getQueryData(inventoryKeys.allocationJob(before.summary.jobNumber))).toEqual({
      source: 'legacy-allocation-job'
    });
  });

  it('legacy checkout-all keeps jobNumber cache behavior', async () => {
    const queryClient = createQueryClient();
    const before = buildDetail(buildSummary({ jobId: undefined }));
    const after = buildDetail(buildSummary({ jobId: undefined, status: 'CHECKED_OUT' }));

    queryClient.setQueryData(inventoryKeys.job(before.summary.jobNumber), before);
    checkoutAllJobMaterialsMock.mockResolvedValueOnce({ result: after, warnings: [] });

    const { result } = renderHook(() => useCheckoutAllJobMaterials(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobNumber: before.summary.jobNumber
      });
    });

    expect(queryClient.getQueryData<JobDetail>(inventoryKeys.job(before.summary.jobNumber))?.summary).toEqual(
      expect.objectContaining({ status: 'CHECKED_OUT' })
    );
  });
});
