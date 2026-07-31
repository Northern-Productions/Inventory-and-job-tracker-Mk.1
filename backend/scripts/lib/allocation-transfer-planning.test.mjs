import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildAllocationPreviewPlan } from '../../src/app/services/runtime/runtimeAllocationPlanning.mjs';
import { buildCapacityAllocationsByBoxIndex } from '../../src/app/services/runtime/runtimeAllocationCoverage.mjs';

const localAllocationRuntime = readFileSync(
  new URL('../../src/app/services/runtime/runtimeAllocationApply.mjs', import.meta.url),
  'utf8'
);
const edgeReadHandlers = readFileSync(
  new URL('../../../supabase/functions/_shared/routes/readHandlers.ts', import.meta.url),
  'utf8'
);

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected marker ${startMarker}.`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Expected marker ${endMarker}.`);
  return source.slice(start, end);
}

function buildBox(overrides = {}) {
  return {
    id: overrides.id || `${overrides.boxId || 'BOX'}-record`,
    boxId: overrides.boxId || 'BOX-1',
    warehouse: overrides.warehouse || 'IL1',
    manufacturer: overrides.manufacturer || 'SOLYX',
    filmName: overrides.filmName || 'Whiteout SXWF-WO',
    widthIn: overrides.widthIn ?? 72,
    initialFeet: overrides.initialFeet ?? 96,
    feetAvailable: overrides.feetAvailable ?? 96,
    storedFeetAvailable: overrides.storedFeetAvailable ?? overrides.feetAvailable ?? 96,
    physicalFeetAvailable:
      overrides.physicalFeetAvailable === undefined ? null : overrides.physicalFeetAvailable,
    allocationPlanningFeet: overrides.allocationPlanningFeet ?? overrides.feetAvailable ?? 96,
    lotRun: '',
    status: overrides.status || 'IN_STOCK',
    orderDate: overrides.orderDate || '',
    receivedDate: overrides.receivedDate || '2026-04-01',
  };
}

function buildRequirement(overrides = {}) {
  return {
    id: overrides.id || 'req-1',
    manufacturer: overrides.manufacturer || 'SOLYX',
    filmName: overrides.filmName || 'Whiteout SXWF-WO',
    widthIn: overrides.widthIn ?? 72,
    requiredFeet: overrides.requiredFeet ?? 13,
  };
}

test('rejects a source box that is already in transfer', () => {
  const source = buildBox({
    id: 'box-transfer-source',
    boxId: 'IL1-6773',
    warehouse: 'IL1',
    status: 'TRANSFER',
  });
  assert.throws(
    () => buildAllocationPreviewPlan(
      source,
      13,
      { jobNumber: '4803', installDate: '', crewLeader: '' },
      {
        crossWarehouse: true,
        minimumWidthIn: 72,
        allBoxes: [source],
        activeAllocationsByBox: {},
        selectedRequirement: buildRequirement(),
        jobWarehouse: 'MS1',
        pendingTransfersByBoxRecordId: {},
      },
    ),
    /pending transfer/i,
  );
});

test('includes only unreserved cross-warehouse in-stock candidates for transfer assist', () => {
  const source = buildBox({
    id: 'box-source',
    boxId: 'MS1-IN-STOCK-SOURCE',
    warehouse: 'MS1',
    status: 'IN_STOCK',
    feetAvailable: 10,
    allocationPlanningFeet: 10,
  });
  const matchingTransfer = buildBox({
    id: 'box-transfer',
    boxId: 'IL1-TRANSFER',
    warehouse: 'IL1',
    status: 'TRANSFER',
    feetAvailable: 40,
    allocationPlanningFeet: 40,
  });
  const ordered = buildBox({
    id: 'box-ordered',
    boxId: 'MS1-ORDERED',
    warehouse: 'MS1',
    status: 'ORDERED',
    feetAvailable: 0,
    allocationPlanningFeet: 80,
    receivedDate: '',
  });
  const inStock = buildBox({
    id: 'box-in-stock',
    boxId: 'MS1-IN-STOCK',
    warehouse: 'MS1',
    status: 'IN_STOCK',
    feetAvailable: 30,
    allocationPlanningFeet: 30,
  });
  const crossWarehouseInStock = buildBox({
    id: 'box-cross-in-stock',
    boxId: 'IL1-IN-STOCK',
    warehouse: 'IL1',
    status: 'IN_STOCK',
    feetAvailable: 40,
    allocationPlanningFeet: 40,
  });
  const reservedCrossWarehouse = buildBox({
    id: 'box-cross-reserved',
    boxId: 'IL1-RESERVED',
    warehouse: 'IL1',
    status: 'IN_STOCK',
    feetAvailable: 40,
    allocationPlanningFeet: 20,
  });
  const wrongTransfer = buildBox({
    id: 'box-transfer-wrong',
    boxId: 'IL1-TRANSFER-WRONG',
    warehouse: 'IL1',
    status: 'TRANSFER',
    feetAvailable: 40,
    allocationPlanningFeet: 40,
  });

  const plan = buildAllocationPreviewPlan(
    source,
    70,
    { jobNumber: '4803', installDate: '', crewLeader: '' },
    {
      crossWarehouse: true,
      minimumWidthIn: 72,
      allBoxes: [
        source,
        ordered,
        inStock,
        crossWarehouseInStock,
        reservedCrossWarehouse,
        matchingTransfer,
        wrongTransfer,
      ],
      activeAllocationsByBox: {
        [reservedCrossWarehouse.boxId]: [
          {
            allocationId: 'ALLOC-RESERVED',
            allocationKind: 'REQUIREMENT',
            requirementId: 'req-reserved',
            jobNumber: '4802',
            status: 'ACTIVE',
            allocatedFeet: 20,
          },
        ],
      },
      selectedRequirement: buildRequirement({ requiredFeet: 70 }),
      jobWarehouse: 'MS1',
      pendingTransfersByBoxRecordId: {
        [wrongTransfer.id]: {
          transferId: 'TRF-3',
          status: 'PENDING',
          sourceWarehouse: 'IL1',
          destinationWarehouse: 'TX1',
        },
      },
    },
  );

  assert.deepEqual(
    plan.suggestions.map((entry) => entry.boxId),
    ['MS1-IN-STOCK', 'IL1-IN-STOCK', 'MS1-ORDERED'],
  );
  assert.deepEqual(
    plan.suggestions.map((entry) => entry.requiresTransfer),
    [false, true, false],
  );
});

test('rejects zeroed source boxes from allocation planning', () => {
  const source = buildBox({
    id: 'box-zeroed-source',
    boxId: 'IL1-ZEROED',
    warehouse: 'IL1',
    status: 'ZEROED',
    feetAvailable: 0,
    allocationPlanningFeet: 0,
  });

  assert.throws(
    () =>
      buildAllocationPreviewPlan(
        source,
        13,
        { jobNumber: '4803', installDate: '', crewLeader: '' },
        {
          crossWarehouse: true,
          minimumWidthIn: 72,
          allBoxes: [source],
          activeAllocationsByBox: {},
          selectedRequirement: buildRequirement(),
          jobWarehouse: 'MS1',
          pendingTransfersByBoxRecordId: {},
        },
      ),
    /must be in stock|no longer allocatable/i,
  );
});

test('local and Edge preview use one bounded candidate snapshot instead of list-boxes reads', () => {
  const localPreview = extractBetween(
    localAllocationRuntime,
    'async function previewAllocationPlan',
    'function resolveSelectedRequirement'
  );
  const edgePreview = extractBetween(
    edgeReadHandlers,
    '"/allocations/preview": async',
    '"/jobs/list": async'
  );

  for (const body of [localPreview, edgePreview]) {
    assert.match(body, /loadAllocationPreviewCandidateSnapshot/);
    assert.match(body, /buildCapacityAllocationsByBoxIndex/);
    assert.doesNotMatch(body, /\blistBoxes\s*\(/);
    assert.doesNotMatch(body, /\blistBoxesByWarehouses\s*\(/);
    assert.doesNotMatch(body, /\blistActiveAllocations\s*\(/);
    assert.doesNotMatch(body, /buildPendingTransfersByBoxRecordId\s*\(/);
  }
});

test('preview capacity index includes reserving history states without including cancelled history', () => {
  const grouped = buildCapacityAllocationsByBoxIndex([
    { boxId: 'ACTIVE-BOX', status: 'ACTIVE' },
    { boxId: 'FULFILLED-BOX', status: 'FULFILLED' },
    { boxId: 'CANCELLED-BOX', status: 'CANCELLED' },
    { boxId: 'REMOVED-BOX', status: 'REMOVED' },
  ]);

  assert.deepEqual(Object.keys(grouped).sort(), ['ACTIVE-BOX', 'FULFILLED-BOX']);
});

test('same-warehouse preview preserves remaining capacity and fulfilled checked-out reservations', () => {
  const source = buildBox({
    boxId: 'IL1-SOURCE',
    warehouse: 'IL1',
    feetAvailable: 5,
    physicalFeetAvailable: 5,
  });
  const partial = buildBox({
    boxId: 'IL1-PARTIAL',
    warehouse: 'IL1',
    feetAvailable: 30,
    physicalFeetAvailable: 50,
  });
  const fullyReservedCheckedOut = buildBox({
    boxId: 'IL1-CHECKED-OUT',
    warehouse: 'IL1',
    status: 'CHECKED_OUT',
    feetAvailable: 40,
    physicalFeetAvailable: 40,
  });
  const allocations = [
    {
      allocationId: 'ALLOC-PARTIAL',
      allocationKind: 'REQUIREMENT',
      requirementId: 'req-prior',
      jobNumber: '4700',
      installDate: '2026-04-01',
      status: 'ACTIVE',
      boxId: partial.boxId,
      allocatedFeet: 20,
    },
    {
      allocationId: 'ALLOC-FULFILLED',
      allocationKind: 'REQUIREMENT',
      requirementId: 'req-fulfilled',
      jobNumber: '4701',
      installDate: '2026-04-02',
      status: 'FULFILLED',
      boxId: fullyReservedCheckedOut.boxId,
      allocatedFeet: 40,
    },
  ];

  const plan = buildAllocationPreviewPlan(
    source,
    35,
    { jobNumber: '4803', installDate: '2026-05-01', crewLeader: 'Crew A' },
    {
      crossWarehouse: false,
      minimumWidthIn: 72,
      allBoxes: [partial, fullyReservedCheckedOut],
      activeAllocationsByBox: buildCapacityAllocationsByBoxIndex(allocations),
      selectedRequirement: buildRequirement({ requiredFeet: 35 }),
      jobWarehouse: 'IL1',
      pendingTransfersByBoxRecordId: {},
    },
  );

  assert.deepEqual(plan.suggestions.map((entry) => entry.boxId), ['IL1-PARTIAL']);
  assert.equal(plan.suggestions[0].planningFeet, 30);
  assert.equal(plan.defaultCoveredFeet, 35);
  assert.equal(plan.defaultRemainingFeet, 0);
});

test('cross-warehouse preview excludes every reservation and pending transfer while retaining historical-only boxes', () => {
  const source = buildBox({
    boxId: 'MS1-SOURCE',
    warehouse: 'MS1',
    feetAvailable: 5,
    physicalFeetAvailable: 5,
  });
  const candidates = [
    buildBox({ id: 'zero-record', boxId: 'IL1-ZERO', warehouse: 'IL1', physicalFeetAvailable: 30, feetAvailable: 30 }),
    buildBox({ id: 'scheduled-record', boxId: 'IL1-SCHEDULED', warehouse: 'IL1', physicalFeetAvailable: 30, feetAvailable: 20 }),
    buildBox({ id: 'placeholder-record', boxId: 'IL1-PLACEHOLDER', warehouse: 'IL1', physicalFeetAvailable: 30, feetAvailable: 20 }),
    buildBox({ id: 'cancelled-record', boxId: 'IL1-CANCELLED-HISTORY', warehouse: 'IL1', physicalFeetAvailable: 30, feetAvailable: 30 }),
    buildBox({ id: 'fulfilled-record', boxId: 'IL1-FULFILLED-HISTORY', warehouse: 'IL1', physicalFeetAvailable: 30, feetAvailable: 30 }),
    buildBox({ id: 'pending-record', boxId: 'IL1-PENDING', warehouse: 'IL1', physicalFeetAvailable: 30, feetAvailable: 30 }),
  ];
  const allocations = [
    {
      allocationId: 'ALLOC-SCHEDULED',
      allocationKind: 'REQUIREMENT',
      requirementId: 'req-scheduled',
      jobNumber: '4700',
      installDate: '2026-05-01',
      status: 'ACTIVE',
      boxId: 'IL1-SCHEDULED',
      allocatedFeet: 10,
    },
    {
      allocationId: 'ALLOC-PLACEHOLDER',
      allocationKind: 'REQUIREMENT',
      requirementId: 'req-placeholder',
      jobNumber: '4701',
      installDate: '',
      status: 'ACTIVE',
      boxId: 'IL1-PLACEHOLDER',
      allocatedFeet: 10,
    },
    {
      allocationId: 'ALLOC-CANCELLED',
      allocationKind: 'REQUIREMENT',
      requirementId: 'req-cancelled',
      jobNumber: '4702',
      status: 'CANCELLED',
      boxId: 'IL1-CANCELLED-HISTORY',
      allocatedFeet: 30,
    },
    {
      allocationId: 'ALLOC-FULFILLED-HISTORY',
      allocationKind: 'REQUIREMENT',
      requirementId: 'req-fulfilled',
      jobNumber: '4703',
      status: 'FULFILLED',
      boxId: 'IL1-FULFILLED-HISTORY',
      allocatedFeet: 30,
    },
  ];

  const plan = buildAllocationPreviewPlan(
    source,
    100,
    { jobNumber: '4803', installDate: '2026-05-01', crewLeader: 'Crew A' },
    {
      crossWarehouse: true,
      minimumWidthIn: 72,
      allBoxes: candidates,
      activeAllocationsByBox: buildCapacityAllocationsByBoxIndex(allocations),
      selectedRequirement: buildRequirement({ requiredFeet: 100 }),
      jobWarehouse: 'MS1',
      pendingTransfersByBoxRecordId: {
        'pending-record': {
          transferId: 'TRF-PENDING',
          status: 'PENDING',
          sourceWarehouse: 'IL1',
          destinationWarehouse: 'MS1',
        },
      },
    },
  );

  assert.deepEqual(
    plan.suggestions.map((entry) => entry.boxId),
    ['IL1-CANCELLED-HISTORY', 'IL1-FULFILLED-HISTORY', 'IL1-ZERO'],
  );
  assert.ok(plan.suggestions.every((entry) => entry.requiresTransfer === true));
});

test('non-cross-warehouse scoped snapshot preserves preview suggestions and allocation math', () => {
  const source = buildBox({
    id: 'source-record',
    boxId: 'IL1-SOURCE',
    warehouse: 'IL1',
    feetAvailable: 10,
    allocationPlanningFeet: 10,
  });
  const sameWarehouseCandidate = buildBox({
    id: 'same-warehouse-record',
    boxId: 'IL1-CANDIDATE',
    warehouse: 'IL1',
    feetAvailable: 40,
    allocationPlanningFeet: 40,
  });
  const otherWarehouseCandidate = buildBox({
    id: 'other-warehouse-record',
    boxId: 'MS1-CANDIDATE',
    warehouse: 'MS1',
    feetAvailable: 40,
    allocationPlanningFeet: 40,
  });
  const context = { jobNumber: '4803', installDate: '', crewLeader: '' };
  const baseOptions = {
    crossWarehouse: false,
    minimumWidthIn: 72,
    activeAllocationsByBox: {},
    selectedRequirement: buildRequirement({ requiredFeet: 50 }),
    jobWarehouse: 'IL1',
    pendingTransfersByBoxRecordId: {},
  };

  const fullOrgPlan = buildAllocationPreviewPlan(source, 50, context, {
    ...baseOptions,
    allBoxes: [source, sameWarehouseCandidate, otherWarehouseCandidate],
  });
  const scopedPlan = buildAllocationPreviewPlan(source, 50, context, {
    ...baseOptions,
    allBoxes: [source, sameWarehouseCandidate],
  });

  assert.deepEqual(scopedPlan, fullOrgPlan);
  assert.deepEqual(scopedPlan.suggestions.map((entry) => entry.boxId), ['IL1-CANDIDATE']);
  assert.equal(scopedPlan.defaultCoveredFeet, 50);
  assert.equal(scopedPlan.defaultRemainingFeet, 0);
});
