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
  checkJobDuplicate,
  checkoutAllJobMaterials,
  createJob,
  deleteJob,
  getJob,
  getJobById,
  getJobsCalendarEntries,
  getJobsCalendarMonth,
  getJobs,
  reopenJob,
  searchJobsByNumber,
  setJobStagedForPickup,
  updateJob
} from './client';
import { APIError, request } from './http';

const requestMock = vi.mocked(request);

function buildJobListEntry(overrides: Record<string, unknown> = {}) {
  return {
    jobId: '11111111-1111-4111-8111-111111111111',
    jobNumber: '000123',
    warehouse: 'IL1',
    sections: null,
    installDate: '2026-03-05',
    crewLeader: '',
    status: 'FILM_ORDER',
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
    hasOrderedAllocations: false,
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

  it('passes jobNumbers through GET /jobs/list as repeated query params', async () => {
    requestMock.mockResolvedValueOnce({
      data: { entries: [buildJobListEntry({ jobNumber: '000123' })] },
      warnings: []
    });

    const entries = await getJobs(0, { jobNumbers: ['000123', '000124', '000123'] });

    expect(entries.map((entry) => entry.jobNumber)).toEqual(['000123']);
    expect(requestMock).toHaveBeenCalledWith('GET', '/jobs/list', {
      query: { limit: 0, jobNumbers: ['000123', '000124'] }
    });
  });

  it('normalizes first-class and legacy work scope fields from job reads', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        entries: [
          buildJobListEntry({ jobNumber: '000123', workScope: 'Sections 4, 5', sections: null }),
          buildJobListEntry({ jobNumber: '000124', sections: 'Section 1' })
        ]
      },
      warnings: []
    });

    const entries = await getJobs(25);

    expect(entries[0].workScope).toBe('Sections 4, 5');
    expect(entries[0].sections).toBe('Sections 4, 5');
    expect(entries[1].workScope).toBe('Section 1');
    expect(entries[1].sections).toBe('Section 1');
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

    expect(detail.summary.jobId).toBe('11111111-1111-4111-8111-111111111111');
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

  it('loads one job through GET /jobs/get-by-id and preserves hash-route identity fields', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        summary: buildJobListEntry({
          jobId: '22222222-2222-4222-8222-222222222222',
          jobNumber: '4953'
        }),
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

    const detail = await getJobById('22222222-2222-4222-8222-222222222222');

    expect(detail.summary.jobId).toBe('22222222-2222-4222-8222-222222222222');
    expect(detail.summary.jobNumber).toBe('4953');
    expect(requestMock).toHaveBeenCalledWith('GET', '/jobs/get-by-id', {
      query: { jobId: '22222222-2222-4222-8222-222222222222' }
    });
  });

  it('defaults missing jobId to undefined for legacy job payloads', async () => {
    const { jobId: _jobId, ...legacySummary } = buildJobListEntry();
    requestMock.mockResolvedValueOnce({
      data: {
        summary: legacySummary,
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

    const detail = await getJob('000123');

    expect(detail.summary.jobId).toBeUndefined();
  });

  it('checks duplicate jobs through GET /jobs/check-duplicate', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        exists: true,
        allowed: false,
        reason: 'SAME_JOB_SCOPE_ACTIVE',
        jobNumber: '000123',
        workScope: 'Sections 4, 5',
        workScopeKey: 'section:4,5',
        job: buildJobListEntry({
          jobId: '33333333-3333-4333-8333-333333333333',
          jobNumber: '000123',
          workScope: 'Sections 4, 5',
          sections: null,
          workScopeKey: 'section:4,5',
          routeTarget: '/allocations/jobs/33333333-3333-4333-8333-333333333333'
        }),
        existingJob: buildJobListEntry({
          jobId: '33333333-3333-4333-8333-333333333333',
          jobNumber: '000123',
          workScope: 'Sections 4, 5',
          sections: null,
          workScopeKey: 'section:4,5',
          routeTarget: '/allocations/jobs/33333333-3333-4333-8333-333333333333'
        }),
        sameJobNumberJobs: [
          buildJobListEntry({
            jobId: '33333333-3333-4333-8333-333333333333',
            jobNumber: '000123',
            workScope: 'Sections 4, 5',
            sections: null,
            workScopeKey: 'section:4,5',
            routeTarget: '/allocations/jobs/33333333-3333-4333-8333-333333333333'
          })
        ]
      },
      warnings: []
    });

    const result = await checkJobDuplicate(' 000123 ', {
      workScope: ' Sections 4, 5 ',
      sections: 'Legacy Sections'
    });

    expect(result.exists).toBe(true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('SAME_JOB_SCOPE_ACTIVE');
    expect(result.workScopeKey).toBe('section:4,5');
    expect(result.job?.jobId).toBe('33333333-3333-4333-8333-333333333333');
    expect(result.job?.workScope).toBe('Sections 4, 5');
    expect(result.job?.sections).toBe('Sections 4, 5');
    expect(result.job?.routeTarget).toBe('/allocations/jobs/33333333-3333-4333-8333-333333333333');
    expect(result.existingJob?.workScopeKey).toBe('section:4,5');
    expect(result.sameJobNumberJobs).toHaveLength(1);
    expect(requestMock).toHaveBeenCalledWith('GET', '/jobs/check-duplicate', {
      query: {
        jobNumber: '000123',
        workScope: 'Sections 4, 5',
        sections: 'Legacy Sections'
      }
    });
  });

  it('returns exists false for unique job numbers', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        exists: false,
        allowed: true,
        reason: 'NO_MATCH',
        jobNumber: '000124',
        workScope: null,
        workScopeKey: 'blank:',
        job: null,
        existingJob: null,
        sameJobNumberJobs: []
      },
      warnings: []
    });

    const result = await checkJobDuplicate('000124');

    expect(result).toEqual({
      exists: false,
      allowed: true,
      reason: 'NO_MATCH',
      jobNumber: '000124',
      workScope: null,
      workScopeKey: 'blank:',
      existingJob: null,
      sameJobNumberJobs: [],
      job: null
    });
    expect(requestMock).toHaveBeenCalledWith('GET', '/jobs/check-duplicate', {
      query: { jobNumber: '000124' }
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
      workScope: 'Lobby Phase 2',
      requirements: []
    });

    expect(result.result.summary.jobNumber).toBe('000123');
    expect(requestMock).toHaveBeenCalledWith('POST', '/jobs/create', {
      body: {
        jobNumber: '000123',
        warehouse: 'IL1',
        workScope: 'Lobby Phase 2',
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

  it('keeps installDate canonical in update job requests', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        summary: buildJobListEntry({ jobNumber: '000123', installDate: '2026-04-20' }),
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

    const result = await updateJob({
      jobNumber: '000123',
      installDate: '2026-04-20',
      requirements: [],
      caulkRequirements: []
    });

    expect(result.result.summary.installDate).toBe('2026-04-20');
    expect(requestMock).toHaveBeenCalledWith('POST', '/jobs/update', {
      body: {
        jobNumber: '000123',
        installDate: '2026-04-20',
        requirements: [],
        caulkRequirements: []
      }
    });
  });

  it('passes optional jobId through update job requests', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        summary: buildJobListEntry({
          jobId: '11111111-1111-4111-8111-111111111111',
          jobNumber: '000123'
        }),
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

    await updateJob({
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '000123',
      requirements: [],
      caulkRequirements: []
    });

    expect(requestMock).toHaveBeenCalledWith('POST', '/jobs/update', {
      body: {
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '000123',
        requirements: [],
        caulkRequirements: []
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

  it('reopens a job through POST /jobs/reopen', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        summary: buildJobListEntry({
          jobNumber: '000123',
          lifecycleStatus: 'ACTIVE',
          status: 'FILM_ORDER'
        }),
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

    const result = await reopenJob({
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '000123',
      reason: 'Reopened after staging correction.'
    });

    expect(result.result.summary.lifecycleStatus).toBe('ACTIVE');
    expect(requestMock).toHaveBeenCalledWith('POST', '/jobs/reopen', {
      body: {
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '000123',
        reason: 'Reopened after staging correction.'
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

  it('passes autoCheckoutRemaining through POST /jobs/set-staged-pickup', async () => {
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

    await setJobStagedForPickup({
      jobNumber: '000123',
      isStagedForPickup: true,
      autoCheckoutRemaining: true
    });

    expect(requestMock).toHaveBeenCalledWith('POST', '/jobs/set-staged-pickup', {
      body: {
        jobNumber: '000123',
        isStagedForPickup: true,
        autoCheckoutRemaining: true
      }
    });
  });

  it('checks out all materials through POST /jobs/checkout-all', async () => {
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

    const result = await checkoutAllJobMaterials({ jobNumber: '000123' });

    expect(result.result.summary.jobNumber).toBe('000123');
    expect(requestMock).toHaveBeenCalledWith('POST', '/jobs/checkout-all', {
      body: {
        jobNumber: '000123'
      }
    });
  });

  it('passes canonical jobId through checkout-all requests when supplied', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        summary: buildJobListEntry({
          jobId: '11111111-1111-4111-8111-111111111111',
          jobNumber: '000123',
          isStagedForPickup: true
        }),
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

    await checkoutAllJobMaterials({
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '000123'
    });

    expect(requestMock).toHaveBeenCalledWith('POST', '/jobs/checkout-all', {
      body: {
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '000123'
      }
    });
  });
});
