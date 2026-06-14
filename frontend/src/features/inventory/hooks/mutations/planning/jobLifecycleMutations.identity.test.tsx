// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptimisticQueueProvider } from '../../../../../components/OptimisticQueue';
import type { JobDetail, JobListEntry, JobRequirementLine, SetJobRequirementStatePayload } from '../../../../../domain';
import { inventoryKeys } from '../../inventoryQueryKeys';
import {
  useCancelJob,
  useCompleteJob,
  useDeleteJob,
  useSetJobRequirementState,
  useUpdateJob
} from './jobLifecycleMutations';

const updateJobMock = vi.fn();
const completeJobMock = vi.fn();
const cancelJobMock = vi.fn();
const deleteJobMock = vi.fn();
const setJobRequirementStateMock = vi.fn();

vi.mock('../../../../../api/features/jobsClient', () => ({
  completeJob: (...args: unknown[]) => completeJobMock(...args),
  createJob: vi.fn(),
  deleteJob: (...args: unknown[]) => deleteJobMock(...args),
  reopenJob: vi.fn(),
  setJobRequirementState: (...args: unknown[]) => setJobRequirementStateMock(...args),
  updateJob: (...args: unknown[]) => updateJobMock(...args)
}));

vi.mock('../../../../../api/features/filmOrdersClient', () => ({
  getFilmOrderDetail: vi.fn(),
  cancelJob: (...args: unknown[]) => cancelJobMock(...args)
}));

beforeEach(() => {
  updateJobMock.mockReset();
  completeJobMock.mockReset();
  cancelJobMock.mockReset();
  deleteJobMock.mockReset();
  setJobRequirementStateMock.mockReset();
});

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
    return (
      <QueryClientProvider client={queryClient}>
        <OptimisticQueueProvider>{children}</OptimisticQueueProvider>
      </QueryClientProvider>
    );
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

function buildRequirement(overrides: Partial<JobRequirementLine> = {}): JobRequirementLine {
  return {
    requirementId: 'req-1',
    manufacturer: '3M',
    filmName: 'Prestige 40',
    widthIn: 60,
    requiredFeet: 10,
    status: 'ACTIVE',
    isComplete: false,
    actualUsedFeet: 0,
    completionResult: '',
    allocatedFeet: 10,
    remainingFeet: 0,
    autoPlanningSuppressed: false,
    ...overrides
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function buildDetailWithRequirements(requirements: JobRequirementLine[]) {
  return {
    ...buildDetail(
      buildSummary({
        requirementCount: requirements.length,
        requiredFeet: requirements.reduce((sum, entry) => sum + Number(entry.requiredFeet || 0), 0),
        allocatedFeet: requirements.reduce((sum, entry) => sum + Number(entry.allocatedFeet || 0), 0),
        remainingFeet: requirements.reduce((sum, entry) => sum + Number(entry.remainingFeet || 0), 0)
      })
    ),
    requirements
  };
}

function getRequirementStatus(queryClient: QueryClient, jobId: string, requirementId: string) {
  return queryClient
    .getQueryData<JobDetail>(inventoryKeys.jobById(jobId))
    ?.requirements.find((entry) => entry.requirementId === requirementId)?.status;
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

describe('useSetJobRequirementState optimistic cache behavior', () => {
  it('keeps later pending optimistic requirement state when an earlier save resolves first', async () => {
    const queryClient = createQueryClient();
    const requirementA = buildRequirement({ requirementId: 'req-a', filmName: 'Film A' });
    const requirementB = buildRequirement({ requirementId: 'req-b', filmName: 'Film B' });
    const before = buildDetailWithRequirements([requirementA, requirementB]);
    const afterFirst = buildDetailWithRequirements([
      buildRequirement({ ...requirementA, status: 'COMPLETE', isComplete: true }),
      requirementB
    ]);
    const afterSecond = buildDetailWithRequirements([
      buildRequirement({ ...requirementA, status: 'COMPLETE', isComplete: true }),
      buildRequirement({ ...requirementB, status: 'COMPLETE', isComplete: true })
    ]);
    const firstSave = createDeferred<{ result: JobDetail; warnings: string[] }>();
    const secondSave = createDeferred<{ result: JobDetail; warnings: string[] }>();
    queryClient.setQueryData(inventoryKeys.jobById(before.summary.jobId!), before);
    setJobRequirementStateMock.mockImplementation((payload: SetJobRequirementStatePayload) =>
      payload.requirementId === 'req-a' ? firstSave.promise : secondSave.promise
    );

    const { result } = renderHook(() => useSetJobRequirementState(), {
      wrapper: createWrapper(queryClient)
    });

    let firstPromise!: Promise<unknown>;
    let secondPromise!: Promise<unknown>;
    await act(async () => {
      firstPromise = result.current.mutateAsync({
        jobId: before.summary.jobId,
        jobNumber: before.summary.jobNumber,
        requirementId: 'req-a',
        status: 'COMPLETE'
      });
      secondPromise = result.current.mutateAsync({
        jobId: before.summary.jobId,
        jobNumber: before.summary.jobNumber,
        requirementId: 'req-b',
        status: 'COMPLETE'
      });
      await Promise.resolve();
    });

    expect(getRequirementStatus(queryClient, before.summary.jobId!, 'req-a')).toBe('COMPLETE');
    expect(getRequirementStatus(queryClient, before.summary.jobId!, 'req-b')).toBe('COMPLETE');

    await act(async () => {
      firstSave.resolve({ result: afterFirst, warnings: [] });
      await firstPromise;
    });

    expect(getRequirementStatus(queryClient, before.summary.jobId!, 'req-a')).toBe('COMPLETE');
    expect(getRequirementStatus(queryClient, before.summary.jobId!, 'req-b')).toBe('COMPLETE');

    await act(async () => {
      secondSave.resolve({ result: afterSecond, warnings: [] });
      await secondPromise;
    });

    expect(getRequirementStatus(queryClient, before.summary.jobId!, 'req-a')).toBe('COMPLETE');
    expect(getRequirementStatus(queryClient, before.summary.jobId!, 'req-b')).toBe('COMPLETE');
  });

  it('rolls back only the failed requirement while preserving another pending optimistic save', async () => {
    const queryClient = createQueryClient();
    const requirementA = buildRequirement({ requirementId: 'req-a', filmName: 'Film A' });
    const requirementB = buildRequirement({ requirementId: 'req-b', filmName: 'Film B' });
    const before = buildDetailWithRequirements([requirementA, requirementB]);
    const afterSecond = buildDetailWithRequirements([
      requirementA,
      buildRequirement({ ...requirementB, status: 'COMPLETE', isComplete: true })
    ]);
    const firstSave = createDeferred<{ result: JobDetail; warnings: string[] }>();
    const secondSave = createDeferred<{ result: JobDetail; warnings: string[] }>();
    queryClient.setQueryData(inventoryKeys.jobById(before.summary.jobId!), before);
    setJobRequirementStateMock.mockImplementation((payload: SetJobRequirementStatePayload) =>
      payload.requirementId === 'req-a' ? firstSave.promise : secondSave.promise
    );

    const { result } = renderHook(() => useSetJobRequirementState(), {
      wrapper: createWrapper(queryClient)
    });

    let firstPromise!: Promise<unknown>;
    let secondPromise!: Promise<unknown>;
    await act(async () => {
      firstPromise = result.current.mutateAsync({
        jobId: before.summary.jobId,
        jobNumber: before.summary.jobNumber,
        requirementId: 'req-a',
        status: 'COMPLETE'
      });
      secondPromise = result.current.mutateAsync({
        jobId: before.summary.jobId,
        jobNumber: before.summary.jobNumber,
        requirementId: 'req-b',
        status: 'COMPLETE'
      });
      await Promise.resolve();
    });

    expect(getRequirementStatus(queryClient, before.summary.jobId!, 'req-a')).toBe('COMPLETE');
    expect(getRequirementStatus(queryClient, before.summary.jobId!, 'req-b')).toBe('COMPLETE');

    await act(async () => {
      firstSave.reject(new Error('Save failed'));
      await expect(firstPromise).rejects.toThrow('Save failed');
    });

    expect(getRequirementStatus(queryClient, before.summary.jobId!, 'req-a')).toBe('ACTIVE');
    expect(getRequirementStatus(queryClient, before.summary.jobId!, 'req-b')).toBe('COMPLETE');

    await act(async () => {
      secondSave.resolve({ result: afterSecond, warnings: [] });
      await secondPromise;
    });

    expect(getRequirementStatus(queryClient, before.summary.jobId!, 'req-a')).toBe('ACTIVE');
    expect(getRequirementStatus(queryClient, before.summary.jobId!, 'req-b')).toBe('COMPLETE');
  });
});

describe('useCancelJob identity caches', () => {
  it('canonical cancel invalidates jobById and leaves same-number legacy detail caches unpatched', async () => {
    const queryClient = createQueryClient();
    const before = buildDetail();

    queryClient.setQueryData(inventoryKeys.jobById(before.summary.jobId!), before);
    queryClient.setQueryData(inventoryKeys.job(before.summary.jobNumber), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob(before.summary.jobNumber), {
      source: 'legacy-allocation-job'
    });
    cancelJobMock.mockResolvedValueOnce({
      result: { jobId: before.summary.jobId, jobNumber: before.summary.jobNumber },
      warnings: []
    });

    const { result } = renderHook(() => useCancelJob(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobId: before.summary.jobId,
        jobNumber: before.summary.jobNumber,
        reason: 'Cancel selected job.'
      });
    });

    expect(cancelJobMock).toHaveBeenCalledWith({
      jobId: before.summary.jobId,
      jobNumber: before.summary.jobNumber,
      reason: 'Cancel selected job.'
    });
    expect(queryClient.getQueryState(inventoryKeys.jobById(before.summary.jobId!))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(inventoryKeys.job(before.summary.jobNumber))).toEqual({
      source: 'legacy-job'
    });
    expect(queryClient.getQueryData(inventoryKeys.allocationJob(before.summary.jobNumber))).toEqual({
      source: 'legacy-allocation-job'
    });
  });

  it('legacy cancel keeps jobNumber cache behavior', async () => {
    const queryClient = createQueryClient();
    const before = buildDetail();

    queryClient.setQueryData(inventoryKeys.job(before.summary.jobNumber), before);
    queryClient.setQueryData(inventoryKeys.allocationJob(before.summary.jobNumber), {
      source: 'legacy-allocation-job'
    });
    cancelJobMock.mockResolvedValueOnce({
      result: { jobNumber: before.summary.jobNumber },
      warnings: []
    });

    const { result } = renderHook(() => useCancelJob(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobNumber: before.summary.jobNumber,
        reason: 'Cancel legacy job.'
      });
    });

    expect(cancelJobMock).toHaveBeenCalledWith({
      jobNumber: before.summary.jobNumber,
      reason: 'Cancel legacy job.'
    });
    expect(queryClient.getQueryState(inventoryKeys.job(before.summary.jobNumber))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.allocationJob(before.summary.jobNumber))?.isInvalidated).toBe(true);
  });
});

describe('useDeleteJob identity caches', () => {
  it('canonical delete removes jobById and leaves same-number legacy detail caches alone', async () => {
    const queryClient = createQueryClient();
    const before = buildDetail();

    queryClient.setQueryData(inventoryKeys.jobById(before.summary.jobId!), before);
    queryClient.setQueryData(inventoryKeys.job(before.summary.jobNumber), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob(before.summary.jobNumber), {
      source: 'legacy-allocation-job'
    });
    deleteJobMock.mockResolvedValueOnce({
      result: { jobId: before.summary.jobId, jobNumber: before.summary.jobNumber },
      warnings: []
    });

    const { result } = renderHook(() => useDeleteJob(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobId: before.summary.jobId,
        jobNumber: before.summary.jobNumber,
        reason: 'Delete selected job.'
      });
    });

    expect(deleteJobMock).toHaveBeenCalledWith({
      jobId: before.summary.jobId,
      jobNumber: before.summary.jobNumber,
      reason: 'Delete selected job.'
    });
    expect(queryClient.getQueryData(inventoryKeys.jobById(before.summary.jobId!))).toBeUndefined();
    expect(queryClient.getQueryData(inventoryKeys.job(before.summary.jobNumber))).toEqual({
      source: 'legacy-job'
    });
    expect(queryClient.getQueryData(inventoryKeys.allocationJob(before.summary.jobNumber))).toEqual({
      source: 'legacy-allocation-job'
    });
  });

  it('legacy delete keeps jobNumber cache removal behavior', async () => {
    const queryClient = createQueryClient();
    const before = buildDetail();

    queryClient.setQueryData(inventoryKeys.job(before.summary.jobNumber), before);
    queryClient.setQueryData(inventoryKeys.allocationJob(before.summary.jobNumber), {
      source: 'legacy-allocation-job'
    });
    deleteJobMock.mockResolvedValueOnce({
      result: { jobNumber: before.summary.jobNumber },
      warnings: []
    });

    const { result } = renderHook(() => useDeleteJob(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobNumber: before.summary.jobNumber,
        reason: 'Delete legacy job.'
      });
    });

    expect(deleteJobMock).toHaveBeenCalledWith({
      jobNumber: before.summary.jobNumber,
      reason: 'Delete legacy job.'
    });
    expect(queryClient.getQueryData(inventoryKeys.job(before.summary.jobNumber))).toBeUndefined();
    expect(queryClient.getQueryData(inventoryKeys.allocationJob(before.summary.jobNumber))).toBeUndefined();
  });
});

describe('useCompleteJob identity caches', () => {
  it('canonical complete syncs jobById and leaves same-number legacy detail caches alone', async () => {
    const queryClient = createQueryClient();
    const before = buildDetail();
    const after = buildDetail(
      buildSummary({
        lifecycleStatus: 'COMPLETED',
        status: 'COMPLETED'
      })
    );

    queryClient.setQueryData(inventoryKeys.jobById(before.summary.jobId!), before);
    queryClient.setQueryData(inventoryKeys.job(before.summary.jobNumber), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob(before.summary.jobNumber), {
      source: 'legacy-allocation-job'
    });
    completeJobMock.mockResolvedValueOnce({ result: after, warnings: [] });

    const { result } = renderHook(() => useCompleteJob(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobId: before.summary.jobId,
        jobNumber: before.summary.jobNumber,
        reason: 'Done.'
      });
    });

    expect(completeJobMock).toHaveBeenCalledWith({
      jobId: before.summary.jobId,
      jobNumber: before.summary.jobNumber,
      reason: 'Done.'
    });
    expect(queryClient.getQueryData<JobDetail>(inventoryKeys.jobById(before.summary.jobId!))?.summary).toEqual(
      expect.objectContaining({ lifecycleStatus: 'COMPLETED', status: 'COMPLETED' })
    );
    expect(queryClient.getQueryData(inventoryKeys.job(before.summary.jobNumber))).toEqual({
      source: 'legacy-job'
    });
    expect(queryClient.getQueryData(inventoryKeys.allocationJob(before.summary.jobNumber))).toEqual({
      source: 'legacy-allocation-job'
    });
  });

  it('legacy complete keeps jobNumber cache behavior', async () => {
    const queryClient = createQueryClient();
    const before = buildDetail();
    const after = buildDetail(
      buildSummary({
        lifecycleStatus: 'COMPLETED',
        status: 'COMPLETED'
      })
    );

    queryClient.setQueryData(inventoryKeys.job(before.summary.jobNumber), before);
    completeJobMock.mockResolvedValueOnce({ result: after, warnings: [] });

    const { result } = renderHook(() => useCompleteJob(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobNumber: before.summary.jobNumber,
        reason: 'Done.'
      });
    });

    expect(completeJobMock).toHaveBeenCalledWith({
      jobNumber: before.summary.jobNumber,
      reason: 'Done.'
    });
    expect(queryClient.getQueryData<JobDetail>(inventoryKeys.job(before.summary.jobNumber))?.summary).toEqual(
      expect.objectContaining({ lifecycleStatus: 'COMPLETED', status: 'COMPLETED' })
    );
  });
});
