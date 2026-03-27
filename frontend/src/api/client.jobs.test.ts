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

import {
  __resetJobsApiAvailabilityForTests,
  createJob,
  deleteJob,
  getJob,
  getJobsCalendarEntries,
  getJobsCalendarMonth,
  getJobs,
  searchJobsByNumber,
  setJobStagedForPickup,
  updateJob
} from './client';
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
    isLaborOnly: false,
    isStagedForPickup: false,
    requiredFeet: 0,
    allocatedFeet: 0,
    remainingFeet: 0,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    requirementCount: 0,
    allocationCount: 0,
    filmOrderCount: 0,
    createdAt: '',
    updatedAt: '',
    notes: '',
    ...overrides
  };
}

describe('jobs API client canonical routes', () => {
  beforeEach(() => {
    __resetJobsApiAvailabilityForTests();
    requestMock.mockReset();
  });

  it('loads jobs through GET /jobs/list', async () => {
    requestMock.mockResolvedValueOnce({
      data: { entries: [buildJobListEntry({ jobNumber: '000123' })] },
      warnings: []
    });

    const entries = await getJobs(25);

    expect(entries.map((entry) => entry.jobNumber)).toEqual(['000123']);
    expect(requestMock).toHaveBeenCalledWith('GET', '/jobs/list', { query: { limit: 25 } });
  });

  it('passes lifecycleStatus to GET /jobs/list when provided', async () => {
    requestMock.mockResolvedValueOnce({
      data: { entries: [buildJobListEntry({ jobNumber: '000123', lifecycleStatus: 'COMPLETED' })] },
      warnings: []
    });

    const entries = await getJobs(25, { lifecycleStatus: 'COMPLETED' });

    expect(entries.map((entry) => entry.jobNumber)).toEqual(['000123']);
    expect(requestMock).toHaveBeenCalledWith('GET', '/jobs/list', {
      query: { limit: 25, lifecycleStatus: 'COMPLETED' }
    });
  });

  it('loads jobs search through GET /jobs/search', async () => {
    requestMock.mockResolvedValueOnce({
      data: { entries: [buildJobListEntry({ jobNumber: '000123' })] },
      warnings: []
    });

    const entries = await searchJobsByNumber('00123', 25);

    expect(entries.map((entry) => entry.jobNumber)).toEqual(['000123']);
    expect(requestMock).toHaveBeenCalledWith('GET', '/jobs/search', {
      query: { query: '00123', limit: 25 }
    });
  });

  it('loads week calendar jobs through GET /jobs/calendar', async () => {
    requestMock.mockResolvedValueOnce({
      data: { entries: [buildJobListEntry({ jobNumber: '000123' })] },
      warnings: []
    });

    const entries = await getJobsCalendarEntries({
      view: 'week',
      anchorDate: '2026-04-15'
    });

    expect(entries.map((entry) => entry.jobNumber)).toEqual(['000123']);
    expect(requestMock).toHaveBeenCalledWith('GET', '/jobs/calendar', {
      query: { view: 'week', anchorDate: '2026-04-15' }
    });
  });

  it('keeps the month helper aligned with the new anchorDate calendar contract', async () => {
    requestMock.mockResolvedValueOnce({
      data: { entries: [buildJobListEntry({ jobNumber: '000123' })] },
      warnings: []
    });

    const entries = await getJobsCalendarMonth('2026-04');

    expect(entries.map((entry) => entry.jobNumber)).toEqual(['000123']);
    expect(requestMock).toHaveBeenCalledWith('GET', '/jobs/calendar', {
      query: { view: 'month', anchorDate: '2026-04-01' }
    });
  });

  it('passes lifecycleStatus to GET /jobs/search when provided', async () => {
    requestMock.mockResolvedValueOnce({
      data: { entries: [buildJobListEntry({ jobNumber: '000123', lifecycleStatus: 'COMPLETED' })] },
      warnings: []
    });

    const entries = await searchJobsByNumber('00123', 25, { lifecycleStatus: 'COMPLETED' });

    expect(entries.map((entry) => entry.jobNumber)).toEqual(['000123']);
    expect(requestMock).toHaveBeenCalledWith('GET', '/jobs/search', {
      query: { query: '00123', limit: 25, lifecycleStatus: 'COMPLETED' }
    });
  });

  it('loads one job through GET /jobs/get and normalizes usage fields', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        summary: buildJobListEntry(),
        requirements: [],
        allocations: [],
        usage: undefined,
        usageTimeline: undefined,
        caulkRequirements: undefined,
        caulkAllocations: undefined,
        caulkCheckouts: undefined,
        filmOrders: []
      },
      warnings: []
    });

    const detail = await getJob('000123');

    expect(detail.summary.jobNumber).toBe('000123');
    expect(detail.usage).toEqual([]);
    expect(detail.usageTimeline).toEqual([]);
    expect(detail.caulkRequirements).toEqual([]);
    expect(detail.caulkAllocations).toEqual([]);
    expect(detail.caulkCheckouts).toEqual([]);
    expect(requestMock).toHaveBeenCalledWith('GET', '/jobs/get', {
      query: { jobNumber: '000123' }
    });
  });

  it('surfaces backend route errors for create job', async () => {
    requestMock.mockRejectedValueOnce(new APIError('Route not found: /jobs/create'));

    await expect(
      createJob({
        jobNumber: '000123',
        warehouse: 'IL1',
        requirements: []
      })
    ).rejects.toThrow('Route not found: /jobs/create');
  });

  it('creates a job through POST /jobs/create', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        summary: buildJobListEntry({ jobNumber: '000123' }),
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

  it('passes labor-only flags through create and update job requests', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        summary: buildJobListEntry({ jobNumber: '000123', isLaborOnly: true, isStagedForPickup: true }),
        requirements: [],
        allocations: [],
        usage: [],
        usageTimeline: [],
        caulkRequirements: [],
        caulkAllocations: [],
        caulkCheckouts: [],
        filmOrders: []
      },
      warnings: []
    });
    requestMock.mockResolvedValueOnce({
      data: {
        summary: buildJobListEntry({ jobNumber: '000123', isLaborOnly: false, isStagedForPickup: false }),
        requirements: [],
        allocations: [],
        usage: [],
        usageTimeline: [],
        caulkRequirements: [],
        caulkAllocations: [],
        caulkCheckouts: [],
        filmOrders: []
      },
      warnings: []
    });

    const created = await createJob({
      jobNumber: '000123',
      warehouse: 'IL1',
      requirements: [],
      caulkRequirements: [],
      isLaborOnly: true
    });
    const updated = await updateJob({
      jobNumber: '000123',
      requirements: [],
      caulkRequirements: [],
      isLaborOnly: false
    });

    expect(created.result.summary.isLaborOnly).toBe(true);
    expect(created.result.summary.isStagedForPickup).toBe(true);
    expect(updated.result.summary.isLaborOnly).toBe(false);
    expect(requestMock).toHaveBeenNthCalledWith(1, 'POST', '/jobs/create', {
      body: {
        jobNumber: '000123',
        warehouse: 'IL1',
        requirements: [],
        caulkRequirements: [],
        isLaborOnly: true
      }
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, 'POST', '/jobs/update', {
      body: {
        jobNumber: '000123',
        requirements: [],
        caulkRequirements: [],
        isLaborOnly: false
      }
    });
  });

  it('deletes a job through POST /jobs/delete', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        jobNumber: '000123'
      },
      warnings: []
    });

    const result = await deleteJob({
      jobNumber: '000123'
    });

    expect(result.result.jobNumber).toBe('000123');
    expect(requestMock).toHaveBeenCalledWith('POST', '/jobs/delete', {
      body: {
        jobNumber: '000123'
      }
    });
  });

  it('sets the staged-for-pickup flag through POST /jobs/set-staged-pickup', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        summary: buildJobListEntry({ jobNumber: '000123', isStagedForPickup: true }),
        requirements: [],
        allocations: [],
        usage: [],
        usageTimeline: [],
        caulkRequirements: [],
        caulkAllocations: [],
        caulkCheckouts: [],
        filmOrders: []
      },
      warnings: []
    });

    const result = await setJobStagedForPickup({
      jobNumber: '000123',
      isStagedForPickup: true
    });

    expect(result.result.summary.isStagedForPickup).toBe(true);
    expect(requestMock).toHaveBeenCalledWith('POST', '/jobs/set-staged-pickup', {
      body: {
        jobNumber: '000123',
        isStagedForPickup: true
      }
    });
  });
});
