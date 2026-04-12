import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAllocationPreviewPlan } from '../../src/app/services/runtime/runtimeAllocationPlanning.mjs';

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

test('accepts a transfer source box when its pending transfer matches the job warehouse', () => {
  const source = buildBox({
    id: 'box-transfer-source',
    boxId: 'IL1-6773',
    warehouse: 'IL1',
    status: 'TRANSFER',
  });
  const plan = buildAllocationPreviewPlan(
    source,
    13,
    { jobNumber: '4803', jobDate: '', crewLeader: '' },
    {
      crossWarehouse: true,
      minimumWidthIn: 72,
      allBoxes: [source],
      activeAllocationsByBox: {},
      selectedRequirement: buildRequirement(),
      jobWarehouse: 'MS1',
      pendingTransfersByBoxRecordId: {
        [source.id]: {
          transferId: 'TRF-1',
          status: 'PENDING',
          sourceWarehouse: 'IL1',
          destinationWarehouse: 'MS1',
        },
      },
    },
  );

  assert.equal(plan.sourceBoxId, 'IL1-6773');
  assert.equal(plan.sourceSuggestedFeet, 13);
  assert.equal(plan.sourceSuggestedCoveredFeet, 13);
});

test('includes matching transfer candidates between in-stock and ordered suggestions', () => {
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
    { jobNumber: '4803', jobDate: '', crewLeader: '' },
    {
      crossWarehouse: true,
      minimumWidthIn: 72,
      allBoxes: [source, ordered, inStock, matchingTransfer, wrongTransfer],
      activeAllocationsByBox: {},
      selectedRequirement: buildRequirement({ requiredFeet: 70 }),
      jobWarehouse: 'MS1',
      pendingTransfersByBoxRecordId: {
        [matchingTransfer.id]: {
          transferId: 'TRF-2',
          status: 'PENDING',
          sourceWarehouse: 'IL1',
          destinationWarehouse: 'MS1',
        },
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
    ['MS1-IN-STOCK', 'IL1-TRANSFER', 'MS1-ORDERED'],
  );
});

test('rejects a transfer source box when its pending transfer points to another warehouse', () => {
  const source = buildBox({
    id: 'box-transfer-source',
    boxId: 'IL1-6773',
    warehouse: 'IL1',
    status: 'TRANSFER',
  });

  assert.throws(
    () =>
      buildAllocationPreviewPlan(
        source,
        13,
        { jobNumber: '4803', jobDate: '', crewLeader: '' },
        {
          crossWarehouse: true,
          minimumWidthIn: 72,
          allBoxes: [source],
          activeAllocationsByBox: {},
          selectedRequirement: buildRequirement(),
          jobWarehouse: 'MS1',
          pendingTransfersByBoxRecordId: {
            [source.id]: {
              transferId: 'TRF-1',
              status: 'PENDING',
              sourceWarehouse: 'IL1',
              destinationWarehouse: 'IL1',
            },
          },
        },
      ),
    /cannot be allocated to a job in MS1/i,
  );
});
