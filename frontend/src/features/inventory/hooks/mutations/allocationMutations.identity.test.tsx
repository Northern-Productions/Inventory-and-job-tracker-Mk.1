// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AllocationJobDetail, JobDetail, JobListEntry } from '../../../../domain';
import { inventoryKeys } from '../inventoryQueryKeys';
import {
  useClearAllocationPlannerSuppression,
  useAllocateBox,
  useAddCaulkJobAllocation,
  useRemoveCaulkJobAllocation,
  useRemoveJobBoxAllocations,
  useUpdateCaulkJobAllocation
} from './allocationMutations';

const applyAllocationPlanMock = vi.fn();
const addCaulkJobAllocationMock = vi.fn();
const removeCaulkJobAllocationMock = vi.fn();
const removeJobBoxAllocationsMock = vi.fn();
const clearAllocationPlannerSuppressionMock = vi.fn();
const updateCaulkJobAllocationMock = vi.fn();

vi.mock('../../../../api/features/allocationsClient', () => ({
  addCaulkJobAllocation: (...args: unknown[]) => addCaulkJobAllocationMock(...args),
  applyAllocationPlan: (...args: unknown[]) => applyAllocationPlanMock(...args),
  checkinCaulkJobAllocation: vi.fn(),
  clearAllocationPlannerSuppression: (...args: unknown[]) =>
    clearAllocationPlannerSuppressionMock(...args),
  checkoutCaulkJobAllocation: vi.fn(),
  removeCaulkJobAllocation: (...args: unknown[]) => removeCaulkJobAllocationMock(...args),
  removeJobBoxAllocations: (...args: unknown[]) => removeJobBoxAllocationsMock(...args),
  updateCaulkJobAllocation: (...args: unknown[]) => updateCaulkJobAllocationMock(...args)
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

describe('useAllocateBox identity caches', () => {
  beforeEach(() => {
    applyAllocationPlanMock.mockReset();
    removeJobBoxAllocationsMock.mockReset();
    clearAllocationPlannerSuppressionMock.mockReset();
  });

  it('canonical apply sends jobId and avoids same-number legacy detail caches', async () => {
    const queryClient = createQueryClient();
    const detail = buildDetail();

    queryClient.setQueryData(inventoryKeys.jobById(JOB_ID), detail);
    queryClient.setQueryData(inventoryKeys.job('1234'), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), {
      source: 'legacy-allocation-job'
    });
    applyAllocationPlanMock.mockResolvedValueOnce({
      result: {
        allocations: [
          {
            allocationId: 'alloc-2',
            boxId: 'IL1-200',
            allocatedFeet: 10,
            coveredFeet: 10
          }
        ],
        filmOrder: null,
        remainingUncoveredFeet: 0
      },
      warnings: []
    });

    const { result } = renderHook(() => useAllocateBox(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobId: JOB_ID,
        jobNumber: '1234',
        boxId: 'IL1-200',
        requestedFeet: 10,
        requestedWidthIn: 48,
        requirementId: 'req-1',
        selectedSuggestionBoxIds: [],
        extraAllocations: []
      });
    });

    expect(applyAllocationPlanMock).toHaveBeenCalledWith({
      jobId: JOB_ID,
      jobNumber: '1234',
      boxId: 'IL1-200',
      requestedFeet: 10,
      requestedWidthIn: 48,
      requirementId: 'req-1',
      selectedSuggestionBoxIds: [],
      extraAllocations: []
    });
    expect(queryClient.getQueryState(inventoryKeys.jobById(JOB_ID))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(inventoryKeys.job('1234'))).toEqual({ source: 'legacy-job' });
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('1234'))).toEqual({
      source: 'legacy-allocation-job'
    });
  });

  it('legacy apply remains jobNumber cache scoped', async () => {
    const queryClient = createQueryClient();
    const detail = buildDetail();

    queryClient.setQueryData(inventoryKeys.job('1234'), detail);
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), buildAllocationJobDetail(detail));
    applyAllocationPlanMock.mockResolvedValueOnce({
      result: {
        allocations: [],
        filmOrder: null,
        remainingUncoveredFeet: 0
      },
      warnings: []
    });

    const { result } = renderHook(() => useAllocateBox(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobNumber: '1234',
        boxId: 'IL1-200',
        requestedFeet: 10,
        requestedWidthIn: 48,
        requirementId: 'req-1',
        selectedSuggestionBoxIds: [],
        extraAllocations: []
      });
    });

    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(true);
  });
});

describe('useRemoveJobBoxAllocations identity caches', () => {
  beforeEach(() => {
    removeJobBoxAllocationsMock.mockReset();
    clearAllocationPlannerSuppressionMock.mockReset();
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

describe('useAddCaulkJobAllocation identity caches', () => {
  beforeEach(() => {
    addCaulkJobAllocationMock.mockReset();
  });

  it('canonical add sends jobId, invalidates jobById, and avoids same-number legacy detail caches', async () => {
    const queryClient = createQueryClient();
    const detail = buildDetail();

    queryClient.setQueryData(inventoryKeys.jobById(JOB_ID), detail);
    queryClient.setQueryData(inventoryKeys.job('1234'), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), {
      source: 'legacy-allocation-job'
    });
    addCaulkJobAllocationMock.mockResolvedValueOnce({
      result: {
        jobId: JOB_ID,
        jobNumber: '1234',
        caulkAllocationId: 'caulk-1',
        warnings: []
      },
      warnings: []
    });

    const { result } = renderHook(() => useAddCaulkJobAllocation(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobId: JOB_ID,
        jobNumber: '1234',
        requirementId: 'caulk-req-1',
        productId: 'caulk-product-1',
        warehouse: 'IL1',
        allocatedTubes: 6
      });
    });

    expect(addCaulkJobAllocationMock).toHaveBeenCalledWith({
      jobId: JOB_ID,
      jobNumber: '1234',
      requirementId: 'caulk-req-1',
      productId: 'caulk-product-1',
      warehouse: 'IL1',
      allocatedTubes: 6
    });
    expect(queryClient.getQueryState(inventoryKeys.jobById(JOB_ID))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(inventoryKeys.job('1234'))).toEqual({ source: 'legacy-job' });
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('1234'))).toEqual({
      source: 'legacy-allocation-job'
    });
  });

  it('legacy add keeps jobNumber optimistic detail behavior', async () => {
    const queryClient = createQueryClient();
    const detail = buildDetail();

    queryClient.setQueryData(inventoryKeys.job('1234'), detail);
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), buildAllocationJobDetail(detail));
    addCaulkJobAllocationMock.mockResolvedValueOnce({
      result: {
        jobNumber: '1234',
        caulkAllocationId: 'caulk-1',
        warnings: []
      },
      warnings: []
    });

    const { result } = renderHook(() => useAddCaulkJobAllocation(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobNumber: '1234',
        productId: 'caulk-product-1',
        warehouse: 'IL1',
        allocatedTubes: 6
      });
    });

    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(true);
  });
});

describe('useRemoveCaulkJobAllocation identity caches', () => {
  beforeEach(() => {
    removeCaulkJobAllocationMock.mockReset();
  });

  function buildDetailWithCaulkAllocation(): JobDetail {
    return {
      ...buildDetail(),
      caulkAllocations: [
        {
          caulkAllocationId: 'caulk-1',
          requirementId: 'caulk-req-1',
          productId: 'caulk-product-1',
          manufacturerId: 'caulk-manufacturer-1',
          manufacturer: 'Caulk Co',
          productName: 'Clear Sealant',
          productCode: 'CS-1',
          tubesPerCase: 12,
          warehouse: 'IL1',
          allocatedTubes: 6,
          reservedTubesRemaining: 6,
          checkedOutTubesTotal: 0,
          returnedUnusedTubesTotal: 0,
          usedTubesTotal: 0,
          overageTubesTotal: 0,
          outstandingCheckoutTubes: 0,
          openCheckoutCount: 0,
          status: 'ACTIVE',
          allocationSource: 'MANUAL',
          createdAt: '',
          createdBy: 'tester',
          updatedAt: '',
          updatedBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          notes: '',
          pendingTransfer: null
        }
      ]
    };
  }

  it('row-derived remove invalidates jobById and avoids same-number legacy detail caches when jobId returns', async () => {
    const queryClient = createQueryClient();
    const detail = buildDetailWithCaulkAllocation();

    queryClient.setQueryData(inventoryKeys.jobById(JOB_ID), detail);
    queryClient.setQueryData(inventoryKeys.job('1234'), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), {
      source: 'legacy-allocation-job'
    });
    removeCaulkJobAllocationMock.mockResolvedValueOnce({
      result: {
        jobId: JOB_ID,
        jobNumber: '1234',
        caulkAllocationId: 'caulk-1',
        releasedReservedTubes: 6,
        warnings: []
      },
      warnings: []
    });

    const { result } = renderHook(() => useRemoveCaulkJobAllocation(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        caulkAllocationId: 'caulk-1',
        reason: 'Remove selected caulk row.'
      });
    });

    expect(removeCaulkJobAllocationMock).toHaveBeenCalledWith({
      caulkAllocationId: 'caulk-1',
      reason: 'Remove selected caulk row.'
    });
    expect(queryClient.getQueryState(inventoryKeys.jobById(JOB_ID))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(inventoryKeys.job('1234'))).toEqual({ source: 'legacy-job' });
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('1234'))).toEqual({
      source: 'legacy-allocation-job'
    });
  });

  it('legacy remove keeps jobNumber detail cache behavior when no jobId returns', async () => {
    const queryClient = createQueryClient();
    const detail = buildDetailWithCaulkAllocation();

    queryClient.setQueryData(inventoryKeys.job('1234'), detail);
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), buildAllocationJobDetail(detail));
    removeCaulkJobAllocationMock.mockResolvedValueOnce({
      result: {
        jobNumber: '1234',
        caulkAllocationId: 'caulk-1',
        releasedReservedTubes: 6,
        warnings: []
      },
      warnings: []
    });

    const { result } = renderHook(() => useRemoveCaulkJobAllocation(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        caulkAllocationId: 'caulk-1',
        reason: 'Remove legacy caulk row.'
      });
    });

    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(true);
  });
});

describe('useUpdateCaulkJobAllocation identity caches', () => {
  beforeEach(() => {
    updateCaulkJobAllocationMock.mockReset();
  });

  it('row-derived update invalidates jobById and avoids same-number legacy detail caches when jobId returns', async () => {
    const queryClient = createQueryClient();
    const detail: JobDetail = {
      ...buildDetail(),
      caulkAllocations: [
        {
          caulkAllocationId: 'caulk-1',
          requirementId: 'caulk-req-1',
          productId: 'caulk-product-1',
          manufacturerId: 'caulk-manufacturer-1',
          manufacturer: 'Caulk Co',
          productName: 'Clear Sealant',
          productCode: 'CS-1',
          tubesPerCase: 12,
          warehouse: 'IL1',
          allocatedTubes: 6,
          reservedTubesRemaining: 6,
          checkedOutTubesTotal: 0,
          returnedUnusedTubesTotal: 0,
          usedTubesTotal: 0,
          overageTubesTotal: 0,
          outstandingCheckoutTubes: 0,
          openCheckoutCount: 0,
          status: 'ACTIVE',
          allocationSource: 'MANUAL',
          createdAt: '',
          createdBy: 'tester',
          updatedAt: '',
          updatedBy: 'tester',
          resolvedAt: '',
          resolvedBy: '',
          notes: '',
          pendingTransfer: null
        }
      ]
    };

    queryClient.setQueryData(inventoryKeys.jobById(JOB_ID), detail);
    queryClient.setQueryData(inventoryKeys.job('1234'), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), {
      source: 'legacy-allocation-job'
    });
    updateCaulkJobAllocationMock.mockResolvedValueOnce({
      result: {
        jobId: JOB_ID,
        jobNumber: '1234',
        caulkAllocationId: 'caulk-1',
        warnings: []
      },
      warnings: []
    });

    const { result } = renderHook(() => useUpdateCaulkJobAllocation(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        caulkAllocationId: 'caulk-1',
        allocatedTubes: 8,
        notes: 'Need two more tubes.'
      });
    });

    expect(updateCaulkJobAllocationMock).toHaveBeenCalledWith({
      caulkAllocationId: 'caulk-1',
      allocatedTubes: 8,
      notes: 'Need two more tubes.'
    });
    expect(queryClient.getQueryState(inventoryKeys.jobById(JOB_ID))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(inventoryKeys.job('1234'))).toEqual({ source: 'legacy-job' });
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('1234'))).toEqual({
      source: 'legacy-allocation-job'
    });
  });
});

describe('useClearAllocationPlannerSuppression identity caches', () => {
  beforeEach(() => {
    removeJobBoxAllocationsMock.mockReset();
    clearAllocationPlannerSuppressionMock.mockReset();
  });

  it('canonical clear sends jobId, invalidates jobById, and avoids legacy detail caches', async () => {
    const queryClient = createQueryClient();
    const detail = buildDetail();

    queryClient.setQueryData(inventoryKeys.jobById(JOB_ID), detail);
    queryClient.setQueryData(inventoryKeys.job('1234'), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), {
      source: 'legacy-allocation-job'
    });
    clearAllocationPlannerSuppressionMock.mockResolvedValueOnce({
      result: detail,
      warnings: []
    });

    const { result } = renderHook(() => useClearAllocationPlannerSuppression(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobId: JOB_ID,
        jobNumber: '1234',
        requirementId: 'req-1',
        materialType: 'FILM',
        reason: 'resume'
      });
    });

    expect(clearAllocationPlannerSuppressionMock).toHaveBeenCalledWith({
      jobId: JOB_ID,
      jobNumber: '1234',
      requirementId: 'req-1',
      materialType: 'FILM',
      reason: 'resume'
    });
    expect(queryClient.getQueryState(inventoryKeys.jobById(JOB_ID))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(inventoryKeys.job('1234'))).toEqual({ source: 'legacy-job' });
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('1234'))).toEqual({
      source: 'legacy-allocation-job'
    });
  });

  it('canonical caulk clear sends jobId and materialType', async () => {
    const queryClient = createQueryClient();
    clearAllocationPlannerSuppressionMock.mockResolvedValueOnce({
      result: buildDetail(),
      warnings: []
    });

    const { result } = renderHook(() => useClearAllocationPlannerSuppression(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobId: JOB_ID,
        jobNumber: '1234',
        requirementId: 'caulk-req-1',
        materialType: 'CAULK',
        reason: 'resume caulk'
      });
    });

    expect(clearAllocationPlannerSuppressionMock).toHaveBeenCalledWith({
      jobId: JOB_ID,
      jobNumber: '1234',
      requirementId: 'caulk-req-1',
      materialType: 'CAULK',
      reason: 'resume caulk'
    });
  });

  it('legacy clear keeps jobNumber detail cache behavior', async () => {
    const queryClient = createQueryClient();
    const detail = buildDetail();

    queryClient.setQueryData(inventoryKeys.job('1234'), detail);
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), buildAllocationJobDetail(detail));
    clearAllocationPlannerSuppressionMock.mockResolvedValueOnce({
      result: detail,
      warnings: []
    });

    const { result } = renderHook(() => useClearAllocationPlannerSuppression(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobNumber: '1234',
        requirementId: 'req-1',
        materialType: 'FILM',
        reason: 'resume legacy'
      });
    });

    expect(clearAllocationPlannerSuppressionMock).toHaveBeenCalledWith({
      jobNumber: '1234',
      requirementId: 'req-1',
      materialType: 'FILM',
      reason: 'resume legacy'
    });
    expect(queryClient.getQueryData(inventoryKeys.job('1234'))).toEqual(detail);
    expect(
      queryClient.getQueryData<AllocationJobDetail>(inventoryKeys.allocationJob('1234'))?.allocations
    ).toEqual(detail.allocations);
  });
});
