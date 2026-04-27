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
  applyAllocationPlan,
  checkinCaulkJobAllocation,
  clearAllocationPlannerSuppression,
  checkoutCaulkJobAllocation,
  getAllocationJob,
  previewAllocationPlan,
  removeCaulkJobAllocation,
  removeJobBoxAllocations,
  updateCaulkJobAllocation
} from './client';
import { request } from './http';

const requestMock = vi.mocked(request);

function buildAllocationJobSummary(overrides: Record<string, unknown> = {}) {
  return {
    jobNumber: '000123',
    installDate: '2026-03-05',
    crewLeader: '',
    status: 'FILM_ORDER',
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
      transferFromWarehouse: 'MS1' as const,
      allocatedTubes: 10
    };
    const result = await addCaulkJobAllocation(payload);

    expect(result.result.caulkAllocationId).toBe('alloc-1');
    expect(result.warnings).toEqual(['reserve warning']);
    expect(requestMock).toHaveBeenCalledWith('POST', '/allocations/caulk/add', {
      body: payload
    });
  });

  it('passes requirementId and jobWarehouse through allocation preview requests', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        jobNumber: '000123',
        installDate: '',
        crewLeader: '',
        requestedFeet: 12,
        sourceBoxId: 'IL1-6502',
        sourceWarehouse: 'IL1',
        sourceBoxFeetAvailable: 12,
        sourceSuggestedFeet: 12,
        sourceConflicts: [],
        suggestions: [],
        defaultCoveredFeet: 12,
        defaultRemainingFeet: 0
      },
      warnings: []
    });

    await previewAllocationPlan({
      boxId: 'IL1-6502',
      jobNumber: '000123',
      requestedFeet: 12,
      requestedWidthIn: 72,
      requirementId: 'req-72',
      jobWarehouse: 'IL1'
    });

    expect(requestMock).toHaveBeenCalledWith('GET', '/allocations/preview', {
      query: {
        boxId: 'IL1-6502',
        jobNumber: '000123',
        installDate: undefined,
        crewLeader: undefined,
        requestedFeet: 12,
        requestedWidthIn: 72,
        requirementId: 'req-72',
        crossWarehouse: undefined,
        jobWarehouse: 'IL1'
      }
    });
  });

  it('posts film allocation plans with requirementId in the body', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        allocations: [],
        filmOrder: null,
        remainingUncoveredFeet: 0
      },
      warnings: []
    });

    await applyAllocationPlan({
      boxId: 'IL1-6502',
      jobNumber: '000123',
      requestedFeet: 12,
      requestedWidthIn: 72,
      requirementId: 'req-72',
      selectedSuggestionBoxIds: [],
      extraAllocations: []
    });

    expect(requestMock).toHaveBeenCalledWith('POST', '/allocations/apply', {
      body: {
        boxId: 'IL1-6502',
        jobNumber: '000123',
        requestedFeet: 12,
        requestedWidthIn: 72,
        requirementId: 'req-72',
        selectedSuggestionBoxIds: [],
        extraAllocations: []
      }
    });
  });

  it('posts remove-box with the allocation row id, not the box id', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        jobNumber: '4953',
        allocationId: 'alloc-6868',
        boxId: 'IL1-6868',
        removedAllocationCount: 1,
        releasedFeet: 60
      },
      warnings: []
    });

    const result = await removeJobBoxAllocations({
      jobNumber: '4953',
      allocationId: 'alloc-6868',
      reason: 'Removed allocation alloc-6868 for box IL1-6868 from job 4953.'
    });

    expect(result.result.allocationId).toBe('alloc-6868');
    expect(requestMock).toHaveBeenCalledWith('POST', '/allocations/remove-box', {
      body: {
        jobNumber: '4953',
        allocationId: 'alloc-6868',
        reason: 'Removed allocation alloc-6868 for box IL1-6868 from job 4953.'
      }
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
      transferFromWarehouse: 'IL1' as const,
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
      unusedLooseTubes: 2,
      unusedCases: 1
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

  it('posts planner suppression clears and normalizes requirement pause state', async () => {
    requestMock.mockResolvedValueOnce({
      data: {
        summary: {
          jobNumber: '000123',
          warehouse: 'IL1',
          sections: null,
          installDate: '',
          crewLeader: '',
          status: 'READY',
          lifecycleStatus: 'ACTIVE',
          isLaborOnly: false,
          isStagedForPickup: false,
          requiredFeet: 100,
          allocatedFeet: 100,
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
          notes: ''
        },
        requirements: [
          {
            requirementId: 'req-1',
            manufacturer: '3M',
            filmName: 'Night Vision 15',
            widthIn: 36,
            requiredFeet: 100,
            allocatedFeet: 100,
            remainingFeet: 0,
            autoPlanningSuppressed: false
          }
        ],
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

    const payload = {
      jobNumber: '000123',
      requirementId: 'req-1',
      reason: 'resume'
    };
    const result = await clearAllocationPlannerSuppression(payload);

    expect(result.result.requirements[0].autoPlanningSuppressed).toBe(false);
    expect(requestMock).toHaveBeenCalledWith('POST', '/allocations/planner-suppression/clear', {
      body: payload
    });
  });
});
