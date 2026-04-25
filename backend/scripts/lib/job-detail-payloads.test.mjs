import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAllocationJobDetailPayload,
  buildJobDetailPayload,
} from '../../src/app/services/runtime/runtimeJobDetails.mjs';
import { buildPublicJobUsageTimelineEntries } from '../../src/app/services/runtime/runtimeTransferUsage.mjs';

function buildDetailContext() {
  return {
    jobNumber: '000123',
    header: {
      id: 'job-1',
      orgId: 'org-1',
      jobNumber: '000123',
      warehouse: 'MS1',
      sections: '260',
      installDate: '2026-04-15',
      crewLeader: 'Crew A',
      lifecycleStatus: 'ACTIVE',
      isLaborOnly: false,
      isStagedForPickup: true,
      notes: '',
      createdAt: '2026-04-10T08:00:00Z',
      createdBy: 'tester',
      updatedAt: '2026-04-10T09:00:00Z',
      updatedBy: 'tester',
    },
    allocations: [
      {
        allocationId: 'alloc-1',
        boxId: 'IL1-100',
        warehouse: 'MS1',
        jobNumber: '000123',
        installDate: '2026-04-15',
        crewLeader: 'Crew A',
        allocatedFeet: 8,
        coveredFeet: 8,
        status: 'ACTIVE',
        allocationKind: 'REQUIREMENT',
        createdAt: '2026-04-15T08:00:00Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: '',
        notes: '',
        requirementId: 'req-1',
      },
    ],
    filmOrders: [
      {
        filmOrderId: 'fo-1',
        jobId: 'job-1',
        jobNumber: '000123',
        warehouse: 'MS1',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 36,
        requestedFeet: 12,
        coveredFeet: 12,
        orderedFeet: 12,
        remainingToOrderFeet: 0,
        installDate: '2026-04-15',
        crewLeader: 'Crew A',
        status: 'FULFILLED',
        sourceBoxId: '',
        resolvedAt: '2026-04-14T12:00:00Z',
        resolvedBy: 'tester',
        notes: '',
        createdAt: '2026-04-12T10:00:00Z',
        createdBy: 'tester',
      },
    ],
    requirements: [],
    caulkRequirements: [],
    caulkAllocations: [
      {
        caulkAllocationId: 'caulk-alloc-1',
        requirementId: 'caulk-req-1',
        jobNumber: '000123',
        productId: 'p1',
        manufacturerId: 'm1',
        manufacturer: 'DOW',
        productName: '795 Black',
        productCode: '795-BLK',
        tubesPerCase: 12,
        warehouse: 'MS1',
        allocatedTubes: 12,
        reservedTubesRemaining: 0,
        checkedOutTubesTotal: 12,
        returnedUnusedTubesTotal: 2,
        usedTubesTotal: 10,
        overageTubesTotal: 0,
        outstandingCheckoutTubes: 0,
        openCheckoutCount: 0,
        status: 'ACTIVE',
        createdAt: '2026-04-15T08:30:00Z',
        createdBy: 'tester',
        updatedAt: '2026-04-15T08:30:00Z',
        updatedBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        notes: '',
      },
    ],
    caulkCheckouts: [
      {
        caulkCheckoutId: 'caulk-checkout-1',
        caulkAllocationId: 'caulk-alloc-1',
        productId: 'p1',
        manufacturerId: 'm1',
        manufacturer: 'DOW',
        productName: '795 Black',
        productCode: '795-BLK',
        tubesPerCase: 12,
        warehouse: 'MS1',
        checkoutTubes: 12,
        overageTubes: 0,
        status: 'CLOSED',
        checkedOutAt: '2026-04-15T09:00:00Z',
        checkedOutBy: 'crew',
        checkedInAt: '2026-04-15T16:00:00Z',
        checkedInBy: 'crew',
        unusedTubes: 2,
        usedTubes: 10,
        notes: '',
      },
    ],
    rollHistory: [
      {
        logId: 'roll-1',
        boxId: 'IL1-100',
        warehouse: 'IL1',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 36,
        jobNumber: '000123',
        checkedOutAt: '2026-04-15T09:00:00Z',
        checkedOutBy: 'crew',
        checkedOutWeightLbs: 20,
        checkedInAt: '2026-04-15T15:00:00Z',
        checkedInBy: 'crew',
        checkedInWeightLbs: 18,
        weightDeltaLbs: 2,
        feetBefore: 50,
        feetAfter: 38,
        notes: 'returned after install',
      },
    ],
    conflictAllocations: [
      {
        allocationId: 'conflict-1',
        boxId: 'IL1-100',
        warehouse: 'MS1',
        jobNumber: '000999',
        installDate: '2026-04-15',
        crewLeader: 'Crew B',
        allocatedFeet: 8,
        coveredFeet: 8,
        status: 'ACTIVE',
        allocationKind: 'REQUIREMENT',
        createdAt: '2026-04-15T07:30:00Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: '',
        notes: '',
        requirementId: 'req-other',
      },
    ],
    boxById: {
      'IL1-100': {
        id: 'box-record-1',
        boxId: 'IL1-100',
        warehouse: 'IL1',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 36,
        status: 'TRANSFER',
        initialFeet: 100,
        feetAvailable: 38,
        activeAllocatedFeet: 8,
        allocationPlanningFeet: 38,
        lotRun: '',
        orderDate: '',
        receivedDate: '',
        notes: '',
        lastCheckoutJob: '000123',
      },
    },
    publicRequirements: [
      {
        requirementId: 'req-1',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 36,
        requiredFeet: 12,
        allocatedFeet: 8,
        remainingFeet: 4,
      },
    ],
    publicCaulkRequirements: [
      {
        requirementId: 'caulk-req-1',
        jobNumber: '000123',
        productId: 'p1',
        manufacturerId: 'm1',
        manufacturer: 'DOW',
        productName: '795 Black',
        productCode: '795-BLK',
        tubesPerCase: 12,
        requiredTubes: 12,
        allocatedTubes: 12,
        remainingTubes: 0,
        notes: '',
        updatedAt: '2026-04-15T08:00:00Z',
      },
    ],
    publicAllocations: [
      {
        allocationId: 'alloc-1',
        boxId: 'IL1-100',
        warehouse: 'MS1',
        jobNumber: '000123',
        installDate: '2026-04-15',
        crewLeader: 'Crew A',
        allocatedFeet: 8,
        coveredFeet: 8,
        status: 'ACTIVE',
        allocationKind: 'REQUIREMENT',
        createdAt: '2026-04-15T08:00:00Z',
        createdBy: 'tester',
        resolvedAt: '',
        resolvedBy: '',
        filmOrderId: '',
        notes: '',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 36,
        boxStatus: 'TRANSFER',
        checkedOutOnThisJob: true,
      },
    ],
    publicFilmOrders: [
      {
        filmOrderId: 'fo-1',
        jobNumber: '000123',
        warehouse: 'MS1',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 36,
        requestedFeet: 12,
        coveredFeet: 12,
        orderedFeet: 12,
        remainingToOrderFeet: 0,
        installDate: '2026-04-15',
        crewLeader: 'Crew A',
        status: 'FULFILLED',
        sourceBoxId: '',
        resolvedAt: '2026-04-14T12:00:00Z',
        resolvedBy: 'tester',
        notes: '',
        createdAt: '2026-04-12T10:00:00Z',
        createdBy: 'tester',
        linkedBoxes: [
          {
            boxId: 'MS1-LINK',
            orderedFeet: 12,
            autoAllocatedFeet: 12,
          },
        ],
      },
    ],
    usage: [
      {
        boxId: 'IL1-100',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 36,
        usedFeet: 12,
        usageEventCount: 1,
        latestCheckedInAt: '2026-04-15T15:00:00Z',
        latestCheckedOutAt: '2026-04-15T09:00:00Z',
        lastActivityAt: '2026-04-15T15:00:00Z',
      },
    ],
    usageTimeline: [
      {
        usageType: 'CAULK',
        occurredAt: '2026-04-15T16:00:00Z',
        actor: 'crew',
        warehouse: 'MS1',
        referenceId: 'caulk-checkout-1',
        manufacturer: 'DOW',
        itemName: '795 Black',
        itemCode: '795-BLK',
        unit: 'TUBES',
        checkedOutQuantity: 12,
        returnedQuantity: 2,
        usedQuantity: 10,
        notes: '',
      },
      {
        usageType: 'FILM',
        occurredAt: '2026-04-15T15:00:00Z',
        actor: 'crew',
        warehouse: 'IL1',
        referenceId: 'IL1-100',
        manufacturer: '3M',
        itemName: 'Night Vision 35',
        itemCode: '',
        unit: 'LF',
        checkedOutQuantity: 50,
        returnedQuantity: 38,
        usedQuantity: 12,
        notes: 'returned after install',
      },
    ],
    filmTransferAlerts: [
      {
        boxId: 'IL1-100',
        sourceWarehouse: 'IL1',
        destinationWarehouse: 'MS1',
        state: 'TRANSFER_PENDING',
        transferId: 'transfer-1',
        startedAt: '2026-04-14T13:00:00Z',
        startedBy: 'warehouse',
      },
    ],
  };
}

test('buildJobDetailPayload preserves linked boxes, usage history, and transfer alerts in one payload', () => {
  const payload = buildJobDetailPayload(buildDetailContext());
  const filmUsageEntry = payload.usageTimeline.find((entry) => entry.usageType === 'FILM');

  assert.deepEqual(Object.keys(payload).sort(), [
    'allocations',
    'caulkAllocations',
    'caulkCheckouts',
    'caulkRequirements',
    'caulkTransferAlerts',
    'filmOrders',
    'filmTransferAlerts',
    'requirements',
    'summary',
    'usage',
    'usageTimeline',
  ]);
  assert.equal(payload.summary.installDate, '2026-04-15');
  assert.equal(payload.summary.status, 'FILM_ORDER');
  assert.equal(Object.hasOwn(payload.summary, 'isLaborAssigned'), false);
  assert.deepEqual(payload.caulkTransferAlerts || [], []);
  assert.equal(payload.filmTransferAlerts[0]?.state, 'TRANSFER_PENDING');
  assert.equal(payload.filmOrders[0]?.linkedBoxes[0]?.boxId, 'MS1-LINK');
  assert.equal(payload.usage[0]?.usedFeet, 12);
  assert.equal(filmUsageEntry?.checkedOutQuantity, 50);
  assert.equal(filmUsageEntry?.returnedQuantity, 38);
  assert.equal(filmUsageEntry?.usedQuantity, 12);
  assert.deepEqual(
    payload.usageTimeline.map((entry) => entry.usageType),
    ['CAULK', 'FILM'],
  );
});

test('buildAllocationJobDetailPayload keeps the allocation-detail summary aligned with the shared context', () => {
  const payload = buildAllocationJobDetailPayload(buildDetailContext());

  assert.equal(payload.summary.jobNumber, '000123');
  assert.equal(payload.summary.installDate, '2026-04-15');
  assert.equal(payload.summary.crewLeader, 'Crew A');
  assert.equal(Object.hasOwn(payload.summary, 'isLaborAssigned'), false);
  assert.equal(payload.summary.requiredTubes, 12);
  assert.equal(payload.summary.hasOrderedAllocations, false);
  assert.equal(payload.filmTransferAlerts[0]?.destinationWarehouse, 'MS1');
  assert.equal(payload.caulkAllocations[0]?.usedTubesTotal, 10);
});

test('buildPublicJobUsageTimelineEntries includes open direct-to-site checkouts before first return', () => {
  const timeline = buildPublicJobUsageTimelineEntries(
    '000123',
    [],
    {
      'MS1-LINK': {
        boxId: 'MS1-LINK',
        warehouse: 'MS1',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
        widthIn: 36,
        status: 'CHECKED_OUT',
        initialFeet: 50,
        feetAvailable: 0,
        directToJobSite: true,
        receivedDate: '',
        lastRollWeightLbs: null,
        coreWeightLbs: null,
        lfWeightLbsPerFt: null,
        lastCheckoutJob: '000123',
        lastCheckoutDate: '2026-04-15',
      },
    },
    [],
    [
      {
        filmOrderId: 'fo-1',
        boxId: 'MS1-LINK',
        orderedFeet: 50,
        createdAt: '2026-04-15T08:00:00Z',
        createdBy: 'tester',
      },
    ],
    [
      {
        filmOrderId: 'fo-1',
        jobNumber: '000123',
        warehouse: 'MS1',
        manufacturer: '3M',
        filmName: 'Night Vision 35',
      },
    ]
  );

  assert.deepEqual(
    timeline.map((entry) => [entry.usageType, entry.referenceId, entry.notes]),
    [
      [
        'FILM_ORDER',
        'MS1-LINK',
        'DIRECT_TO_SITE_CREATED: Created from Film Order fo-1 for job 000123; shipped directly to job site; no warehouse receipt; no initial weight recorded.',
      ],
      [
        'FILM',
        'MS1-LINK',
        'DIRECT_TO_SITE_CHECKED_OUT: Box committed directly to job 000123 from Film Order fo-1.',
      ],
    ]
  );
  assert.equal(timeline[1]?.checkedOutQuantity, 50);
});
