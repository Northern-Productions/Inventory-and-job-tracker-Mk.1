import { describe, expect, it } from 'vitest';
import type { AllocationJobDetailEntry, FilmOrderEntry, JobRequirementLine } from '../../../../domain';
import {
  buildStaleFilmOrderPromptKey,
  didFilmRequirementDemandChange,
  findStaleManualFilmOrdersAfterCoverageTransition,
  type FilmOrderCoverageSnapshot
} from './filmOrderCoveragePrompt';

function buildRequirement(overrides: Partial<JobRequirementLine> = {}): JobRequirementLine {
  return {
    requirementId: 'req-1',
    manufacturer: '3M Solar',
    filmName: 'Prestige 40',
    widthIn: 48,
    requiredFeet: 40,
    allocatedFeet: 0,
    remainingFeet: 40,
    ...overrides
  };
}

function buildFilmOrder(overrides: Partial<FilmOrderEntry> = {}): FilmOrderEntry {
  return {
    filmOrderId: 'FO-1',
    jobNumber: '19413',
    warehouse: 'IL1',
    manufacturer: '3M Solar',
    filmName: 'Prestige 40',
    widthIn: 48,
    requestedFeet: 40,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: 40,
    installDate: '2026-04-24',
    crewLeader: 'Crew',
    status: 'FILM_ORDER',
    sourceBoxId: '',
    origin: 'MANUAL',
    createdAt: '2026-04-20T10:00:00Z',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    linkedBoxes: [],
    ...overrides
  };
}

function buildAllocation(
  overrides: Partial<AllocationJobDetailEntry> = {}
): AllocationJobDetailEntry {
  return {
    allocationId: 'alloc-1',
    boxId: 'IL1-BOX',
    warehouse: 'IL1',
    jobNumber: '19413',
    installDate: '',
    crewLeader: '',
    allocatedFeet: 10,
    coveredFeet: 10,
    requirementId: 'req-1',
    allocationKind: 'REQUIREMENT',
    allocationSource: 'FILM_ORDER_RECEIPT',
    status: 'ACTIVE',
    createdAt: '2026-04-20T10:00:00Z',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    filmOrderId: 'FO-1',
    notes: '',
    manufacturer: '3M Solar',
    filmName: 'Prestige 40',
    widthIn: 48,
    boxStatus: 'IN_STOCK',
    checkedOutOnThisJob: false,
    ...overrides
  };
}

function findCandidates(before: FilmOrderCoverageSnapshot, after: FilmOrderCoverageSnapshot) {
  return findStaleManualFilmOrdersAfterCoverageTransition({ before, after }).map(
    (order) => order.filmOrderId
  );
}

describe('filmOrderCoveragePrompt', () => {
  it('returns a cancellable manual order when related requirements transition from unmet to fully covered', () => {
    const order = buildFilmOrder();

    expect(
      findCandidates(
        {
          requirements: [buildRequirement({ remainingFeet: 12 })],
          filmOrders: [order],
          allocations: []
        },
        {
          requirements: [buildRequirement({ allocatedFeet: 40, remainingFeet: 0 })],
          filmOrders: [order],
          allocations: []
        }
      )
    ).toEqual(['FO-1']);
  });

  it('does not prompt when requirements were already fully covered before the user action', () => {
    const order = buildFilmOrder();

    expect(
      findCandidates(
        {
          requirements: [buildRequirement({ allocatedFeet: 40, remainingFeet: 0 })],
          filmOrders: [order],
          allocations: []
        },
        {
          requirements: [buildRequirement({ allocatedFeet: 40, remainingFeet: 0 })],
          filmOrders: [order],
          allocations: []
        }
      )
    ).toEqual([]);
  });

  it('distinguishes user requirement demand edits from planner-only coverage changes', () => {
    const before = {
      requirements: [buildRequirement({ requiredFeet: 40, remainingFeet: 12 })],
      filmOrders: [],
      allocations: []
    };

    expect(
      didFilmRequirementDemandChange(before, {
        requirements: [buildRequirement({ requiredFeet: 40, allocatedFeet: 40, remainingFeet: 0 })],
        filmOrders: [],
        allocations: []
      })
    ).toBe(false);

    expect(
      didFilmRequirementDemandChange(before, {
        requirements: [buildRequirement({ requiredFeet: 28, allocatedFeet: 28, remainingFeet: 0 })],
        filmOrders: [],
        allocations: []
      })
    ).toBe(true);
  });

  it('requires every related requirement row to be fully covered before prompting one matching order', () => {
    const order = buildFilmOrder();
    const before = {
      requirements: [
        buildRequirement({ requirementId: 'req-1', remainingFeet: 4 }),
        buildRequirement({ requirementId: 'req-2', remainingFeet: 8 })
      ],
      filmOrders: [order],
      allocations: []
    };

    expect(
      findCandidates(before, {
        requirements: [
          buildRequirement({ requirementId: 'req-1', allocatedFeet: 40, remainingFeet: 0 }),
          buildRequirement({ requirementId: 'req-2', allocatedFeet: 32, remainingFeet: 8 })
        ],
        filmOrders: [order],
        allocations: []
      })
    ).toEqual([]);

    expect(
      findCandidates(before, {
        requirements: [
          buildRequirement({ requirementId: 'req-1', allocatedFeet: 40, remainingFeet: 0 }),
          buildRequirement({ requirementId: 'req-2', allocatedFeet: 40, remainingFeet: 0 })
        ],
        filmOrders: [order],
        allocations: []
      })
    ).toEqual(['FO-1']);
  });

  it('excludes non-cancellable statuses, automated orders, dismissed orders, and downstream fulfillment state', () => {
    const before = {
      requirements: [buildRequirement({ remainingFeet: 5 })],
      filmOrders: [],
      allocations: []
    };
    const afterRequirement = buildRequirement({ allocatedFeet: 40, remainingFeet: 0 });

    const ineligibleOrders = [
      buildFilmOrder({ filmOrderId: 'FO-ON-WAY', status: 'FILM_ON_THE_WAY' }),
      buildFilmOrder({ filmOrderId: 'FO-FULFILLED', status: 'FULFILLED' }),
      buildFilmOrder({ filmOrderId: 'FO-CANCELLED', status: 'CANCELLED' }),
      buildFilmOrder({ filmOrderId: 'FO-AUTO', origin: 'AUTO_SHORTAGE', sourceBoxId: 'IL1-1234' }),
      buildFilmOrder({ filmOrderId: 'FO-ORDERED', orderedFeet: 10 }),
      buildFilmOrder({
        filmOrderId: 'FO-LINKED',
        linkedBoxes: [{ boxId: 'IL1-ORDERED', orderedFeet: 40, autoAllocatedFeet: 0, isReceived: false }]
      }),
      buildFilmOrder({ filmOrderId: 'FO-COVERED', coveredFeet: 10 })
    ];

    expect(
      findStaleManualFilmOrdersAfterCoverageTransition({
        before,
        after: {
          requirements: [afterRequirement],
          filmOrders: [...ineligibleOrders, buildFilmOrder({ filmOrderId: 'FO-WITH-ALLOC' })],
          allocations: [buildAllocation({ filmOrderId: 'FO-WITH-ALLOC' })]
        },
        dismissedPromptKeys: [buildStaleFilmOrderPromptKey(buildFilmOrder({ filmOrderId: 'FO-DISMISSED' }))]
      }).map((order) => order.filmOrderId)
    ).toEqual([]);

    expect(
      findStaleManualFilmOrdersAfterCoverageTransition({
        before,
        after: {
          requirements: [afterRequirement],
          filmOrders: [buildFilmOrder({ filmOrderId: 'FO-DISMISSED' })],
          allocations: []
        },
        dismissedPromptKeys: ['FO-DISMISSED']
      }).map((order) => order.filmOrderId)
    ).toEqual([]);
  });
});
