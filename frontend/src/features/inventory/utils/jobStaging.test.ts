import { describe, expect, it } from 'vitest';
import type { JobDetail } from '../../../domain';
import { canMarkJobStagedForPickup, getJobStagingBlockingMessage } from './jobStaging';

function buildDetail(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    summary: {
      jobNumber: '000123',
      warehouse: 'IL1',
      sections: null,
      dueDate: '2026-04-01',
      crewLeader: 'Crew',
      status: 'ALLOCATE',
      lifecycleStatus: 'ACTIVE',
      isLaborOnly: false,
      isStagedForPickup: false,
      requiredFeet: 8,
      allocatedFeet: 8,
      remainingFeet: 0,
      requiredTubes: 0,
      allocatedTubes: 0,
      remainingTubes: 0,
      requirementCount: 1,
      allocationCount: 1,
      filmOrderCount: 0,
      createdAt: '',
      updatedAt: '',
      notes: ''
    },
    requirements: [
      {
        requirementId: 'req-1',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 60,
        requiredFeet: 8,
        allocatedFeet: 8,
        remainingFeet: 0
      }
    ],
    allocations: [
      {
        allocationId: 'alloc-1',
        boxId: 'IL1-100',
        warehouse: 'IL1',
        jobNumber: '000123',
        jobDate: '2026-04-01',
        crewLeader: 'Crew',
        allocatedFeet: 8,
        status: 'FULFILLED',
        allocationKind: 'REQUIREMENT',
        createdAt: '',
        createdBy: '',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: '',
        notes: '',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 60,
        boxStatus: 'CHECKED_OUT',
        checkedOutOnThisJob: true
      }
    ],
    usage: [],
    usageTimeline: [],
    caulkRequirements: [],
    caulkAllocations: [],
    caulkCheckouts: [],
    filmOrders: [],
    ...overrides
  };
}

describe('jobStaging', () => {
  it('allows staging once required film is fully checked out', () => {
    const detail = buildDetail();

    expect(getJobStagingBlockingMessage(detail)).toBe('');
    expect(canMarkJobStagedForPickup(detail)).toBe(true);
  });

  it('blocks staging while required film is still only allocated', () => {
    const detail = buildDetail({
      allocations: [
        {
          ...buildDetail().allocations[0],
          status: 'ACTIVE',
          boxStatus: 'IN_STOCK',
          checkedOutOnThisJob: false
        }
      ]
    });

    expect(getJobStagingBlockingMessage(detail)).toBe(
      'Check out the allocated film before staging this job.'
    );
    expect(canMarkJobStagedForPickup(detail)).toBe(false);
  });

  it('blocks staging while required caulk is still reserved', () => {
    const detail = buildDetail({
      summary: {
        ...buildDetail().summary,
        requiredFeet: 0,
        allocatedFeet: 0,
        remainingFeet: 0,
        requiredTubes: 12,
        allocatedTubes: 12,
        remainingTubes: 0
      },
      requirements: [],
      allocations: [],
      caulkRequirements: [
        {
          requirementId: 'caulk-1',
          jobNumber: '000123',
          productId: 'product-1',
          manufacturerId: 'manufacturer-1',
          manufacturer: 'DOW',
          productName: '795 Black',
          productCode: '795-BLK',
          tubesPerCase: 12,
          requiredTubes: 12,
          allocatedTubes: 12,
          remainingTubes: 0,
          notes: '',
          updatedAt: ''
        }
      ],
      caulkAllocations: [
        {
          caulkAllocationId: 'caulk-alloc-1',
          requirementId: 'caulk-1',
          productId: 'product-1',
          manufacturerId: 'manufacturer-1',
          manufacturer: 'DOW',
          productName: '795 Black',
          productCode: '795-BLK',
          tubesPerCase: 12,
          warehouse: 'IL1',
          allocatedTubes: 12,
          reservedTubesRemaining: 12,
          checkedOutTubesTotal: 0,
          returnedUnusedTubesTotal: 0,
          usedTubesTotal: 0,
          overageTubesTotal: 0,
          outstandingCheckoutTubes: 0,
          openCheckoutCount: 0,
          status: 'ACTIVE',
          createdAt: '',
          createdBy: '',
          updatedAt: '',
          updatedBy: '',
          resolvedAt: '',
          resolvedBy: '',
          notes: ''
        }
      ]
    });

    expect(getJobStagingBlockingMessage(detail)).toBe(
      'Check out the allocated caulk before staging this job.'
    );
    expect(canMarkJobStagedForPickup(detail)).toBe(false);
  });
});
