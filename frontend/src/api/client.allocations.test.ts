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

import {
  __resetJobsApiAvailabilityForTests,
  addCaulkJobAllocation,
  checkinCaulkJobAllocation,
  checkoutCaulkJobAllocation,
  getAllocationJob,
  removeCaulkJobAllocation,
  updateCaulkJobAllocation
} from './client';
import { request } from './http';

const requestMock = vi.mocked(request);

function buildAllocationJobSummary(overrides: Record<string, unknown> = {}) {
  return {
    jobNumber: '000123',
    jobDate: '2026-03-05',
    crewLeader: '',
    status: 'ALLOCATE',
    activeAllocatedFeet: 0,
    fulfilledAllocatedFeet: 0,
    requiredTubes: 0,
    allocatedTubes: 0,
    remainingTubes: 0,
    openFilmOrderCount: 0,
    boxCount: 0,
    ...overrides
  };
}

describe('allocations API client caulk routes', () => {
  beforeEach(() => {
    __resetJobsApiAvailabilityForTests();
    requestMock.mockReset();
  });

  it('loads one allocation job through GET /allocations/by-job and normalizes caulk arrays', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        summary: buildAllocationJobSummary(),
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

    const detail = await getAllocationJob('000123');

    expect(detail.summary.jobNumber).toBe('000123');
    expect(detail.usage).toEqual([]);
    expect(detail.usageTimeline).toEqual([]);
    expect(detail.caulkRequirements).toEqual([]);
    expect(detail.caulkAllocations).toEqual([]);
    expect(detail.caulkCheckouts).toEqual([]);
    expect(requestMock).toHaveBeenCalledWith('GET', '/allocations/by-job', {
      query: { jobNumber: '000123' }
    });
  });

  it('posts add caulk allocation to /allocations/caulk/add', async () => {
    requestMock.mockResolvedValueOnce({
      data: { jobNumber: '000123', caulkAllocationId: 'alloc-1' },
      warnings: ['reserve warning']
    });

    const payload = {
      jobNumber: '000123',
      productId: 'product-1',
      warehouse: 'IL1' as const,
      allocatedTubes: 10
    };
    const result = await addCaulkJobAllocation(payload);

    expect(result.result.caulkAllocationId).toBe('alloc-1');
    expect(result.warnings).toEqual(['reserve warning']);
    expect(requestMock).toHaveBeenCalledWith('POST', '/allocations/caulk/add', {
      body: payload
    });
  });

  it('posts update caulk allocation to /allocations/caulk/update', async () => {
    requestMock.mockResolvedValueOnce({
      data: { jobNumber: '000123', caulkAllocationId: 'alloc-1' },
      warnings: []
    });

    const payload = {
      caulkAllocationId: 'alloc-1',
      allocatedTubes: 12,
      notes: 'increase reserve'
    };
    const result = await updateCaulkJobAllocation(payload);

    expect(result.result.caulkAllocationId).toBe('alloc-1');
    expect(requestMock).toHaveBeenCalledWith('POST', '/allocations/caulk/update', {
      body: payload
    });
  });

  it('posts checkout caulk allocation to /allocations/caulk/checkout', async () => {
    requestMock.mockResolvedValueOnce({
      data: { jobNumber: '000123', caulkAllocationId: 'alloc-1', caulkCheckoutId: 'checkout-1' },
      warnings: []
    });

    const payload = {
      caulkAllocationId: 'alloc-1',
      checkoutTubes: 8
    };
    const result = await checkoutCaulkJobAllocation(payload);

    expect(result.result.caulkCheckoutId).toBe('checkout-1');
    expect(requestMock).toHaveBeenCalledWith('POST', '/allocations/caulk/checkout', {
      body: payload
    });
  });

  it('posts checkin caulk allocation to /allocations/caulk/checkin', async () => {
    requestMock.mockResolvedValueOnce({
      data: { jobNumber: '000123', caulkAllocationId: 'alloc-1', caulkCheckoutId: 'checkout-1' },
      warnings: []
    });

    const payload = {
      caulkCheckoutId: 'checkout-1',
      unusedTubes: 2
    };
    const result = await checkinCaulkJobAllocation(payload);

    expect(result.result.caulkCheckoutId).toBe('checkout-1');
    expect(requestMock).toHaveBeenCalledWith('POST', '/allocations/caulk/checkin', {
      body: payload
    });
  });

  it('posts remove caulk allocation to /allocations/caulk/remove', async () => {
    requestMock.mockResolvedValueOnce({
      data: { jobNumber: '000123', caulkAllocationId: 'alloc-1', releasedReservedTubes: 4 },
      warnings: ['released reserve']
    });

    const payload = {
      caulkAllocationId: 'alloc-1',
      reason: 'cleanup'
    };
    const result = await removeCaulkJobAllocation(payload);

    expect(result.result.releasedReservedTubes).toBe(4);
    expect(result.warnings).toEqual(['released reserve']);
    expect(requestMock).toHaveBeenCalledWith('POST', '/allocations/caulk/remove', {
      body: payload
    });
  });
});
