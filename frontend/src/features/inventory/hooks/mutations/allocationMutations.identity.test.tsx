// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllocationJobDetail, JobDetail, JobListEntry } from '../../../../domain';
import { inventoryKeys } from '../inventoryQueryKeys';
import { useRemoveJobBoxAllocations } from './allocationMutations';

const removeJobBoxAllocationsMock = vi.fn();

vi.mock('../../../../api/features/allocationsClient', () => ({
  addCaulkJobAllocation: vi.fn(),
  applyAllocationPlan: vi.fn(),
  checkinCaulkJobAllocation: vi.fn(),
  clearAllocationPlannerSuppression: vi.fn(),
  checkoutCaulkJobAllocation: vi.fn(),
  removeCaulkJobAllocation: vi.fn(),
  removeJobBoxAllocations: (...args: unknown[]) => removeJobBoxAllocationsMock(...args),
  updateCaulkJobAllocation: vi.fn()
}));

const JOB_ID = '11111111-1111-4111-8111-111111111111';

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
    jobId: JOB_ID,
    jobNumber: '1234',
    routeTarget: `/allocations/jobs/${JOB_ID}`,
    warehouse: 'IL1',
    workScope: 'Section 1',
    sections: 'Section 1',
    installDate: '2026-05-01',
    crewLeader: 'Crew A',
    status: 'READY',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isStagedForPickup: false,
    requiredFeet: 100,
    allocatedFeet: 60,
    allocatedWithInstallDateFeet: 60,
    allocatedWithoutInstallDateFeet: 0,
    remainingFeet: 40,
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

function buildDetail(): JobDetail {
  const allocation = {
    allocationId: 'alloc-1',
    boxId: 'IL1-100',
    warehouse: 'IL1' as const,
    jobNumber: '1234',
    installDate: '2026-05-01',
    crewLeader: 'Crew A',
    allocatedFeet: 60,
    coveredFeet: 60,
    requirementId: 'req-1',
    allocationKind: 'REQUIREMENT' as const,
    allocationSource: 'MANUAL' as const,
    status: 'ACTIVE' as const,
    createdAt: '',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    filmOrderId: '',
    notes: '',
    manufacturer: '3M',
    filmName: 'Night Vision 35',
    widthIn: 60,
    boxStatus: 'IN_STOCK' as const,
    checkedOutOnThisJob: false
  };

  return {
    summary: buildSummary(),
    requirements: [],
    allocations: [allocation],
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

function buildAllocationJobDetail(detail = buildDetail()): AllocationJobDetail {
  return {
    summary: {
      jobId: detail.summary.jobId,
      jobNumber: detail.summary.jobNumber,
      workScope: detail.summary.workScope,
      sections: detail.summary.sections,
      installDate: detail.summary.installDate,
      crewLeader: detail.summary.crewLeader,
      status: 'READY',
      activeAllocatedFeet: detail.summary.allocatedFeet,
      allocatedWithInstallDateFeet: detail.summary.allocatedWithInstallDateFeet,
      allocatedWithoutInstallDateFeet: detail.summary.allocatedWithoutInstallDateFeet,
      fulfilledAllocatedFeet: 0,
      requiredTubes: detail.summary.requiredTubes,
      allocatedTubes: detail.summary.allocatedTubes,
      remainingTubes: detail.summary.remainingTubes,
      openFilmOrderCount: 0,
      boxCount: 1,
      hasOrderedAllocations: false
    },
    requirements: [],
    allocations: detail.allocations,
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

describe('useRemoveJobBoxAllocations identity caches', () => {
  beforeEach(() => {
    removeJobBoxAllocationsMock.mockReset();
  });

  it('canonical remove invalidates jobById and avoids same-number legacy detail caches', async () => {
    const queryClient = createQueryClient();
    const detail = buildDetail();

    queryClient.setQueryData(inventoryKeys.jobById(JOB_ID), detail);
    queryClient.setQueryData(inventoryKeys.job('1234'), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), {
      source: 'legacy-allocation-job'
    });
    removeJobBoxAllocationsMock.mockResolvedValueOnce({
      result: {
        jobId: JOB_ID,
        jobNumber: '1234',
        allocationId: 'alloc-1',
        boxId: 'IL1-100',
        removedAllocationCount: 1,
        releasedFeet: 60
      },
      warnings: []
    });

    const { result } = renderHook(() => useRemoveJobBoxAllocations(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobId: JOB_ID,
        jobNumber: '1234',
        allocationId: 'alloc-1',
        reason: 'Remove selected row.'
      });
    });

    expect(removeJobBoxAllocationsMock).toHaveBeenCalledWith({
      jobId: JOB_ID,
      jobNumber: '1234',
      allocationId: 'alloc-1',
      reason: 'Remove selected row.'
    });
    expect(queryClient.getQueryState(inventoryKeys.jobById(JOB_ID))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(inventoryKeys.job('1234'))).toEqual({ source: 'legacy-job' });
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('1234'))).toEqual({
      source: 'legacy-allocation-job'
    });
  });

  it('legacy remove keeps jobNumber detail cache behavior', async () => {
    const queryClient = createQueryClient();
    const detail = buildDetail();

    queryClient.setQueryData(inventoryKeys.job('1234'), detail);
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), buildAllocationJobDetail(detail));
    removeJobBoxAllocationsMock.mockResolvedValueOnce({
      result: {
        jobNumber: '1234',
        allocationId: 'alloc-1',
        boxId: 'IL1-100',
        removedAllocationCount: 1,
        releasedFeet: 60
      },
      warnings: []
    });

    const { result } = renderHook(() => useRemoveJobBoxAllocations(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobNumber: '1234',
        allocationId: 'alloc-1',
        reason: 'Remove legacy row.'
      });
    });

    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(true);
  });
});
