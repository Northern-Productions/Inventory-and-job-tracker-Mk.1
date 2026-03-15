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

import { __resetJobsApiAvailabilityForTests, createJob, getJobs, searchJobsByNumber } from './client';
import { APIError, request } from './http';

const requestMock = vi.mocked(request);

function buildJobListEntry(overrides: Record<string, unknown> = {}) {
  return {
    jobNumber: '000123',
    warehouse: 'IL1',
    sections: null,
    dueDate: '2026-03-05',
    crewLeader: '',
    status: 'ALLOCATE',
    lifecycleStatus: 'ACTIVE',
    requiredFeet: 0,
    allocatedFeet: 0,
    remainingFeet: 0,
    requirementCount: 0,
    allocationCount: 0,
    filmOrderCount: 0,
    updatedAt: '',
    notes: '',
    ...overrides
  };
}

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

  it('searches jobs through /jobs/search when available', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        entries: [buildJobListEntry({ jobNumber: '000123' }), buildJobListEntry({ jobNumber: '000120' })]
      },
      warnings: []
    });

    const entries = await searchJobsByNumber('00123', 25);

    expect(entries.map((entry) => entry.jobNumber)).toEqual(['000123', '000120']);
    expect(requestMock).toHaveBeenCalledWith('POST', '/jobs/search', {
      body: { query: '00123', limit: 25 }
    });
  });

  it('falls back to local ranking when /jobs/search is missing', async () => {
    requestMock
      .mockRejectedValueOnce(new APIError('Route not found: /jobs/search'))
      .mockRejectedValueOnce(new APIError('Route not found: /jobs/search'))
      .mockResolvedValueOnce({
        data: {
          entries: [
            buildJobListEntry({ jobNumber: '000120', dueDate: '2026-03-01' }),
            buildJobListEntry({ jobNumber: '000123', dueDate: '2026-03-02' }),
            buildJobListEntry({ jobNumber: '000126', dueDate: '2026-03-03' }),
            buildJobListEntry({ jobNumber: '000124', lifecycleStatus: 'COMPLETED' })
          ]
        },
        warnings: []
      });

    const entries = await searchJobsByNumber('123', 25);

    expect(entries.map((entry) => entry.jobNumber)).toEqual(['000123', '000126', '000120']);
    expect(requestMock).toHaveBeenNthCalledWith(1, 'POST', '/jobs/search', {
      body: { query: '123', limit: 25 }
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, 'GET', '/jobs/search', {
      query: { query: '123', limit: 25 }
    });
    expect(requestMock).toHaveBeenNthCalledWith(3, 'POST', '/jobs/list', {
      body: { limit: 25 }
    });
  });

  it('uses prefix-first ordering in /jobs/search fallback ranking', async () => {
    requestMock
      .mockRejectedValueOnce(new APIError('Route not found: /jobs/search'))
      .mockRejectedValueOnce(new APIError('Route not found: /jobs/search'))
      .mockResolvedValueOnce({
        data: {
          entries: [
            buildJobListEntry({ jobNumber: '4217', dueDate: '2026-03-16' }),
            buildJobListEntry({ jobNumber: '18542', dueDate: '2026-03-18' }),
            buildJobListEntry({ jobNumber: '17045', dueDate: '2026-03-13' })
          ]
        },
        warnings: []
      });

    const entries = await searchJobsByNumber('1854', 25);

    expect(entries.map((entry) => entry.jobNumber)).toEqual(['18542', '4217', '17045']);
  });

  it('throws a deployment hint when /jobs/create is missing', async () => {
    requestMock.mockRejectedValueOnce(new APIError('Route not found: /jobs/create'));

    await expect(
      createJob({
        jobNumber: '000123',
        warehouse: 'IL1',
        requirements: []
      })
    ).rejects.toThrow('Jobs backend is not deployed yet.');
  });

  it('creates a job when /jobs/create is available', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        summary: {
          jobNumber: '000123',
          warehouse: 'IL1',
          sections: null,
          dueDate: '',
          crewLeader: '',
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
        usage: [],
        filmOrders: []
      },
      warnings: []
    });

    const result = await createJob({
      jobNumber: '000123',
      warehouse: 'IL1',
      requirements: []
    });

    expect(result.result.summary.jobNumber).toBe('000123');
    expect(requestMock).toHaveBeenCalledWith('POST', '/jobs/create', {
      body: {
        jobNumber: '000123',
        warehouse: 'IL1',
        requirements: []
      }
    });
  });
});
