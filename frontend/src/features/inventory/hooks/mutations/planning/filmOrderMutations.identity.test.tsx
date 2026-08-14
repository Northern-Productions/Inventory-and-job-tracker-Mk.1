// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AllocationJobDetail,
  CreateFilmOrderPayload,
  FilmOrderEntry,
  JobDetail,
  JobListEntry
} from '../../../../../domain';
import { inventoryKeys } from '../../inventoryQueryKeys';
import {
  useCorrectFilmOrderReceipt,
  useCreateFilmOrder,
  useDeleteFilmOrder
} from './filmOrderMutations';

const createFilmOrderMock = vi.fn();
const deleteFilmOrderMock = vi.fn();
const correctFilmOrderReceiptMock = vi.fn();

vi.mock('../../../../../api/features/filmOrdersClient', () => ({
  getFilmOrderDetail: vi.fn(),
  correctFilmOrderReceipt: (...args: unknown[]) => correctFilmOrderReceiptMock(...args),
  createFilmOrder: (...args: unknown[]) => createFilmOrderMock(...args),
  deleteFilmOrder: (...args: unknown[]) => deleteFilmOrderMock(...args)
}));

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const SIBLING_JOB_ID = '22222222-2222-4222-8222-222222222222';

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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function buildFilmOrder(overrides: Partial<FilmOrderEntry> = {}): FilmOrderEntry {
  return {
    filmOrderId: 'FO-1',
    requirementId: 'req-1',
    jobNumber: '1234',
    warehouse: 'IL1',
    manufacturer: '3M',
    filmName: 'Night Vision 35',
    widthIn: 60,
    requestedFeet: 100,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: 100,
    installDate: '2026-05-01',
    crewLeader: 'Crew A',
    status: 'FILM_ORDER',
    sourceBoxId: '',
    origin: 'MANUAL',
    createdAt: '',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    linkedBoxes: [],
    ...overrides
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
    status: 'FILM_ORDER',
    lifecycleStatus: 'ACTIVE',
    isLaborOnly: false,
    isStagedForPickup: false,
    requiredFeet: 100,
    allocatedFeet: 0,
    allocatedWithInstallDateFeet: 0,
    allocatedWithoutInstallDateFeet: 0,
    remainingFeet: 100,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 1,
    allocationCount: 0,
    filmOrderCount: 1,
    hasOrderedAllocations: false,
    createdAt: '',
    updatedAt: '',
    notes: '',
    ...overrides
  };
}

function buildDetail(filmOrders: FilmOrderEntry[] = [buildFilmOrder()]): JobDetail {
  return {
    summary: buildSummary({ filmOrderCount: filmOrders.length }),
    requirements: [],
    allocations: [],
    usage: [],
    usageTimeline: [],
    caulkRequirements: [],
    caulkAllocations: [],
    caulkCheckouts: [],
    filmOrders,
    filmTransferAlerts: [],
    caulkTransferAlerts: []
  };
}

function buildAllocationJobDetail(filmOrders: FilmOrderEntry[] = [buildFilmOrder()]): AllocationJobDetail {
  const summary = buildSummary({ filmOrderCount: filmOrders.length });
  return {
    summary: {
      jobId: summary.jobId,
      jobNumber: summary.jobNumber,
      workScope: summary.workScope,
      sections: summary.sections,
      installDate: summary.installDate,
      crewLeader: summary.crewLeader,
      status: 'FILM_ORDER',
      activeAllocatedFeet: 0,
      allocatedWithInstallDateFeet: 0,
      allocatedWithoutInstallDateFeet: 0,
      fulfilledAllocatedFeet: 0,
      requiredTubes: 0,
      allocatedTubes: 0,
      remainingTubes: 0,
      openFilmOrderCount: filmOrders.length,
      boxCount: 0,
      hasOrderedAllocations: false
    },
    requirements: [],
    allocations: [],
    usage: [],
    usageTimeline: [],
    caulkRequirements: [],
    caulkAllocations: [],
    caulkCheckouts: [],
    filmOrders,
    filmTransferAlerts: [],
    caulkTransferAlerts: []
  };
}

describe('film order mutation identity caches', () => {
  beforeEach(() => {
    createFilmOrderMock.mockReset();
    deleteFilmOrderMock.mockReset();
    correctFilmOrderReceiptMock.mockReset();
  });

  it('canonical create sends jobId and avoids same-number legacy detail cache patching', async () => {
    const queryClient = createQueryClient();
    const createdFilmOrder = buildFilmOrder({ filmOrderId: 'FO-2' });
    const legacyJobCache = { source: 'legacy-job' };
    const legacyAllocationJobCache = { source: 'legacy-allocation-job' };
    const payload: CreateFilmOrderPayload = {
      jobId: JOB_ID,
      jobNumber: '1234',
      requirementId: 'req-1',
      warehouse: 'IL1',
      manufacturer: '3M',
      filmName: 'Night Vision 35',
      widthIn: 60,
      requestedFeet: 50
    };

    queryClient.setQueryData(inventoryKeys.jobById(JOB_ID), buildDetail([]));
    queryClient.setQueryData(inventoryKeys.job('1234'), legacyJobCache);
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), legacyAllocationJobCache);
    queryClient.setQueryData(inventoryKeys.filmOrders, []);
    createFilmOrderMock.mockResolvedValueOnce({
      result: createdFilmOrder,
      warnings: []
    });

    const { result } = renderHook(() => useCreateFilmOrder(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync(payload);
    });

    expect(createFilmOrderMock).toHaveBeenCalledWith(payload);
    expect(queryClient.getQueryState(inventoryKeys.jobById(JOB_ID))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(inventoryKeys.job('1234'))).toEqual(legacyJobCache);
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('1234'))).toEqual(legacyAllocationJobCache);
    expect(queryClient.getQueryData<FilmOrderEntry[]>(inventoryKeys.filmOrders)).toEqual([createdFilmOrder]);
  });

  it('canonical create seeds optimistic schedule metadata from the matching same-number jobId', async () => {
    const queryClient = createQueryClient();
    const deferred = createDeferred<{ result: FilmOrderEntry; warnings: string[] }>();
    const payload: CreateFilmOrderPayload = {
      jobId: SIBLING_JOB_ID,
      jobNumber: '1234',
      requirementId: 'req-2',
      warehouse: 'IL1',
      manufacturer: '3M',
      filmName: 'Night Vision 35',
      widthIn: 60,
      requestedFeet: 50
    };
    const siblingSummary = buildSummary({
      jobId: SIBLING_JOB_ID,
      workScope: 'Section 2',
      sections: 'Section 2',
      installDate: '2026-06-01',
      crewLeader: 'Crew B'
    });

    queryClient.setQueryData(inventoryKeys.jobsList({ limit: 25, lifecycleStatus: 'ACTIVE' }), [
      buildSummary({ installDate: '2026-05-01', crewLeader: 'Crew A' }),
      siblingSummary
    ]);
    createFilmOrderMock.mockReturnValueOnce(deferred.promise);

    const { result } = renderHook(() => useCreateFilmOrder(), {
      wrapper: createWrapper(queryClient)
    });

    let mutationPromise!: Promise<unknown>;
    await act(async () => {
      mutationPromise = result.current.mutateAsync(payload);
      await Promise.resolve();
    });

    expect(queryClient.getQueryData<FilmOrderEntry[]>(inventoryKeys.filmOrders)).toEqual([
      expect.objectContaining({
        jobId: SIBLING_JOB_ID,
        jobNumber: '1234',
        requirementId: 'req-2',
        installDate: '2026-06-01',
        crewLeader: 'Crew B'
      })
    ]);

    deferred.resolve({
      result: buildFilmOrder({
        filmOrderId: 'FO-2',
        jobId: SIBLING_JOB_ID,
        requirementId: 'req-2',
        installDate: '2026-06-01',
        crewLeader: 'Crew B'
      }),
      warnings: []
    });
    await act(async () => {
      await mutationPromise;
    });
  });

  it('legacy create remains jobNumber-only and keeps legacy detail cache patching', async () => {
    const queryClient = createQueryClient();
    const createdFilmOrder = buildFilmOrder({ filmOrderId: 'FO-2' });
    const payload: CreateFilmOrderPayload = {
      jobNumber: '1234',
      warehouse: 'IL1',
      manufacturer: '3M',
      filmName: 'Night Vision 35',
      widthIn: 60,
      requestedFeet: 50
    };

    queryClient.setQueryData(inventoryKeys.job('1234'), buildDetail([]));
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), buildAllocationJobDetail([]));
    createFilmOrderMock.mockResolvedValueOnce({
      result: createdFilmOrder,
      warnings: []
    });

    const { result } = renderHook(() => useCreateFilmOrder(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync(payload);
    });

    expect(createFilmOrderMock).toHaveBeenCalledWith(payload);
    expect(createFilmOrderMock.mock.calls[0][0]).not.toHaveProperty('jobId');
    expect(queryClient.getQueryData<JobDetail>(inventoryKeys.job('1234'))?.filmOrders).toEqual([createdFilmOrder]);
    expect(queryClient.getQueryData<AllocationJobDetail>(inventoryKeys.allocationJob('1234'))?.filmOrders).toEqual([
      createdFilmOrder
    ]);
  });

  it('canonical delete invalidates jobById and avoids same-number legacy detail cache patching', async () => {
    const queryClient = createQueryClient();
    const filmOrder = buildFilmOrder();

    queryClient.setQueryData(inventoryKeys.jobById(JOB_ID), buildDetail([filmOrder]));
    queryClient.setQueryData(inventoryKeys.job('1234'), { source: 'legacy-job' });
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), {
      source: 'legacy-allocation-job'
    });
    queryClient.setQueryData(inventoryKeys.filmOrders, [filmOrder]);

    deleteFilmOrderMock.mockResolvedValueOnce({
      result: filmOrder,
      warnings: []
    });

    const { result } = renderHook(() => useDeleteFilmOrder(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobId: JOB_ID,
        jobNumber: '1234',
        filmOrderId: 'FO-1',
        reason: 'Delete selected film order.'
      });
    });

    expect(deleteFilmOrderMock).toHaveBeenCalledWith({
      jobId: JOB_ID,
      jobNumber: '1234',
      filmOrderId: 'FO-1',
      reason: 'Delete selected film order.'
    });
    expect(queryClient.getQueryState(inventoryKeys.jobById(JOB_ID))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(inventoryKeys.job('1234'))).toEqual({ source: 'legacy-job' });
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('1234'))).toEqual({
      source: 'legacy-allocation-job'
    });
  });

  it('legacy/global delete keeps jobNumber detail cache behavior', async () => {
    const queryClient = createQueryClient();
    const filmOrder = buildFilmOrder();

    queryClient.setQueryData(inventoryKeys.job('1234'), buildDetail([filmOrder]));
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), buildAllocationJobDetail([filmOrder]));
    deleteFilmOrderMock.mockResolvedValueOnce({
      result: filmOrder,
      warnings: []
    });

    const { result } = renderHook(() => useDeleteFilmOrder(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        jobNumber: '1234',
        filmOrderId: 'FO-1',
        reason: 'Delete legacy film order.'
      });
    });

    expect(deleteFilmOrderMock).toHaveBeenCalledWith({
      jobNumber: '1234',
      filmOrderId: 'FO-1',
      reason: 'Delete legacy film order.'
    });
    expect(queryClient.getQueryState(inventoryKeys.job('1234'))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.allocationJob('1234'))?.isInvalidated).toBe(true);
  });

  it('canonical receipt correction invalidates exact Film Order and Job Details caches', async () => {
    const queryClient = createQueryClient();
    const legacyJobCache = { source: 'legacy-job' };
    const legacyAllocationJobCache = { source: 'legacy-allocation-job' };

    queryClient.setQueryData(inventoryKeys.filmOrder('FO-1'), buildFilmOrder());
    queryClient.setQueryData(inventoryKeys.jobById(JOB_ID), buildDetail());
    queryClient.setQueryData(inventoryKeys.job('1234'), legacyJobCache);
    queryClient.setQueryData(inventoryKeys.allocationJob('1234'), legacyAllocationJobCache);
    correctFilmOrderReceiptMock.mockResolvedValueOnce({
      result: {
        filmOrderId: 'FO-1',
        linkId: 'link-1',
        boxId: 'IL1-100',
        previousReceivedFeet: 60,
        correctedReceivedFeet: 52
      },
      warnings: []
    });

    const { result } = renderHook(() => useCorrectFilmOrderReceipt(), {
      wrapper: createWrapper(queryClient)
    });

    await act(async () => {
      await result.current.mutateAsync({
        filmOrderId: 'FO-1',
        jobId: JOB_ID,
        jobNumber: '1234',
        linkId: 'link-1',
        boxId: 'IL1-100',
        correctedReceivedFeet: 52,
        reason: 'Receiving footage entered incorrectly.'
      });
    });

    expect(queryClient.getQueryState(inventoryKeys.filmOrder('FO-1'))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inventoryKeys.jobById(JOB_ID))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(inventoryKeys.job('1234'))).toEqual(legacyJobCache);
    expect(queryClient.getQueryData(inventoryKeys.allocationJob('1234'))).toEqual(legacyAllocationJobCache);
  });
});
