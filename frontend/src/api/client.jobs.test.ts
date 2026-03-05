import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./http', () => {
  class APIError extends Error {
    warnings: string[];

    constructor(message: string, warnings: string[] = []) {
      super(message);
      this.name = 'APIError';
      this.warnings = warnings;
    }
  }

  return {
    APIError,
    request: vi.fn()
  };
});

vi.mock('../lib/offlineInventory', () => ({
  getOfflineBox: vi.fn(),
  replaceOfflineInventoryBoxes: vi.fn(),
  searchOfflineBoxes: vi.fn()
}));

import { __resetJobsApiAvailabilityForTests, createJob, getJobs } from './client';
import { APIError, request } from './http';

const requestMock = vi.mocked(request);

describe('jobs API client fallbacks', () => {
  beforeEach(() => {
    __resetJobsApiAvailabilityForTests();
    requestMock.mockReset();
  });

  it('falls back to legacy allocations jobs route when /jobs/list is missing', async () => {
    requestMock
      .mockRejectedValueOnce(new APIError('Route not found: /jobs/list'))
      .mockRejectedValueOnce(new APIError('Route not found: /jobs/list'))
      .mockResolvedValueOnce({
        data: {
          entries: [
            {
              jobNumber: '123',
              jobDate: '2026-03-05',
              crewLeader: '',
              status: 'FILM_ORDER',
              activeAllocatedFeet: 0,
              fulfilledAllocatedFeet: 0,
              openFilmOrderCount: 1,
              boxCount: 0
            }
          ]
        },
        warnings: []
      });

    const entries = await getJobs(25);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      jobNumber: '123',
      dueDate: '2026-03-05',
      status: 'ALLOCATE',
      lifecycleStatus: 'ACTIVE'
    });
    expect(requestMock).toHaveBeenNthCalledWith(1, 'POST', '/jobs/list', { body: { limit: 25 } });
    expect(requestMock).toHaveBeenNthCalledWith(2, 'GET', '/jobs/list', { query: { limit: 25 } });
    expect(requestMock).toHaveBeenNthCalledWith(3, 'POST', '/allocations/jobs', { body: {} });
  });

  it('skips repeated /jobs/list failures after capability is marked missing', async () => {
    requestMock
      .mockRejectedValueOnce(new APIError('Route not found: /jobs/list'))
      .mockRejectedValueOnce(new APIError('Route not found: /jobs/list'))
      .mockResolvedValueOnce({
        data: { entries: [] },
        warnings: []
      });

    await getJobs(25);

    requestMock.mockClear();
    requestMock.mockResolvedValueOnce({
      data: { entries: [] },
      warnings: []
    });

    await getJobs(25);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith('POST', '/allocations/jobs', { body: {} });
  });

  it('throws a deployment hint when /jobs/create is missing', async () => {
    requestMock.mockRejectedValueOnce(new APIError('Route not found: /jobs/create'));

    await expect(
      createJob({
        jobNumber: '000123',
        warehouse: 'IL',
        requirements: []
      })
    ).rejects.toThrow('Jobs backend is not deployed yet.');
  });

  it('creates a job when /jobs/create is available', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        summary: {
          jobNumber: '000123',
          warehouse: 'IL',
          sections: null,
          dueDate: '',
          status: 'ALLOCATE',
          lifecycleStatus: 'ACTIVE',
          requiredFeet: 0,
          allocatedFeet: 0,
          remainingFeet: 0,
          requirementCount: 0,
          allocationCount: 0,
          filmOrderCount: 0,
          updatedAt: '',
          notes: ''
        },
        requirements: [],
        allocations: [],
        filmOrders: []
      },
      warnings: []
    });

    const result = await createJob({
      jobNumber: '000123',
      warehouse: 'IL',
      requirements: []
    });

    expect(result.result.summary.jobNumber).toBe('000123');
    expect(requestMock).toHaveBeenCalledWith('POST', '/jobs/create', {
      body: {
        jobNumber: '000123',
        warehouse: 'IL',
        requirements: []
      }
    });
  });
});
