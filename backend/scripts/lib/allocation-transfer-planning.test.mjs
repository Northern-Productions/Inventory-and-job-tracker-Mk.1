import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAllocationPreviewPlan } from '../../src/app/services/runtime/runtimeAllocationPlanning.mjs';
import { loadAllocationPreviewBoxes } from '../../src/app/services/runtime/runtimeAllocationApply.mjs';

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

test('accepts a transfer source box without requiring pending transfer metadata', () => {
  const source = buildBox({
    id: 'box-transfer-source',
    boxId: 'IL1-6773',
    warehouse: 'IL1',
    status: 'TRANSFER',
  });
  const plan = buildAllocationPreviewPlan(
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
  );

  assert.equal(plan.sourceBoxId, 'IL1-6773');
  assert.equal(plan.sourceSuggestedFeet, 13);
  assert.equal(plan.sourceSuggestedCoveredFeet, 13);
});

test('includes transfer candidates between in-stock and ordered suggestions without destination matching', () => {
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
    { jobNumber: '4803', installDate: '', crewLeader: '' },
    {
      crossWarehouse: true,
      minimumWidthIn: 72,
      allBoxes: [source, ordered, inStock, matchingTransfer, wrongTransfer],
      activeAllocationsByBox: {},
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
    ['MS1-IN-STOCK', 'IL1-TRANSFER', 'IL1-TRANSFER-WRONG', 'MS1-ORDERED'],
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
    /no longer allocatable/i,
  );
});

test('loads only source warehouse boxes for non-cross-warehouse allocation preview', async () => {
  const source = buildBox({ boxId: 'IL1-SOURCE', warehouse: 'IL1' });
  const scopedBoxes = [source, buildBox({ boxId: 'IL1-CANDIDATE', warehouse: 'IL1' })];
  let fullOrgReadCount = 0;
  let warehouseReadArgs = null;

  const boxes = await loadAllocationPreviewBoxes({}, 'org-1', source, false, {
    listBoxes: async () => {
      fullOrgReadCount += 1;
      return [];
    },
    listBoxesByWarehouses: async (_client, orgId, warehouses) => {
      warehouseReadArgs = { orgId, warehouses };
      return scopedBoxes;
    },
  });

  assert.equal(fullOrgReadCount, 0);
  assert.deepEqual(warehouseReadArgs, { orgId: 'org-1', warehouses: ['IL1'] });
  assert.deepEqual(boxes, scopedBoxes);
});

test('keeps full-org boxes for cross-warehouse allocation preview', async () => {
  const source = buildBox({ boxId: 'IL1-SOURCE', warehouse: 'IL1' });
  const fullOrgBoxes = [source, buildBox({ boxId: 'MS1-CANDIDATE', warehouse: 'MS1' })];
  let warehouseReadCount = 0;

  const boxes = await loadAllocationPreviewBoxes({}, 'org-1', source, true, {
    listBoxes: async (_client, orgId) => {
      assert.equal(orgId, 'org-1');
      return fullOrgBoxes;
    },
    listBoxesByWarehouses: async () => {
      warehouseReadCount += 1;
      return [];
    },
  });

  assert.equal(warehouseReadCount, 0);
  assert.deepEqual(boxes, fullOrgBoxes);
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
