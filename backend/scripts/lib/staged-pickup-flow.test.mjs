import test from 'node:test';
import assert from 'node:assert/strict';

import { getJobStagingBlockingReason } from '../../src/app/services/runtime/runtimeJobSummaries.mjs';
import { loadJobStagingValidationState } from '../../src/app/services/runtime/runtimeCheckoutOperations.mjs';
import { executeSetJobStagedPickup } from '../../src/app/services/runtime/runtimeJobsRead.mjs';

test('loadJobStagingValidationState only loads boxes linked to the job allocations', async () => {
  const boxLoadCalls = [];
  const pendingTransferCalls = [];
  const state = await loadJobStagingValidationState(
    {},
    'org-1',
    '18722',
    'IL1',
    {},
    {
      listAllocationsByJob: async () => [
        {
          allocationId: 'alloc-1',
          jobNumber: '18722',
          boxId: 'IL1-100',
          status: 'ACTIVE',
          allocationKind: 'REQUIREMENT',
          allocatedFeet: 25,
        },
        {
          allocationId: 'alloc-2',
          jobNumber: '18722',
          boxId: 'IL1-200',
          status: 'FULFILLED',
          allocationKind: 'REQUIREMENT',
          allocatedFeet: 0,
        },
      ],
      listFilmOrdersByJob: async () => [],
      listJobRequirementsByJob: async () => [],
      listJobCaulkRequirementsByJob: async () => [],
      listCaulkJobAllocationsByJob: async () => [],
      listBoxesByIds: async (_client, _orgId, boxIds) => {
        boxLoadCalls.push(boxIds);
        return [
          {
            id: 'box-record-1',
            boxId: 'IL1-100',
            warehouse: 'IL1',
            status: 'IN_STOCK',
            initialFeet: 100,
            feetAvailable: 75,
            activeAllocatedFeet: 25,
          },
        ];
      },
      listPendingBoxTransfersByBoxRecordIds: async (_client, _orgId, recordIds) => {
        pendingTransferCalls.push(recordIds);
        return [];
      },
      indexPendingBoxTransfersByBoxRecordId: () => ({}),
      listBoxes: async () => {
        throw new Error('Whole-org box loads should not be used for job-scoped staging validation.');
      },
    },
  );

  assert.deepEqual(boxLoadCalls, [['IL1-100', 'IL1-200']]);
  assert.deepEqual(pendingTransferCalls, [['box-record-1']]);
  assert.equal(state.boxes.length, 1);
  assert.equal(state.boxById['IL1-100'].status, 'IN_STOCK');
});

test('executeSetJobStagedPickup reuses refreshed checkout state after auto checkout', async () => {
  let loadCount = 0;
  let updateCount = 0;

  const result = await executeSetJobStagedPickup(
    {},
    'org-1',
    '18722',
    true,
    'tester',
    { autoCheckoutRemaining: true },
    {
      nowIso: '2026-04-15T12:00:00Z',
      normalizeJobNumberDigits: (value) => String(value).trim(),
      asTrimmedString: (value) => String(value || '').trim(),
      resolveExistingOrLegacyJobHeader: async () => ({
        header: {
          jobNumber: '18722',
          warehouse: 'IL1',
          lifecycleStatus: 'ACTIVE',
        },
        allocations: null,
        filmOrders: null,
      }),
      normalizeJobLifecycleStatus: () => 'ACTIVE',
      checkoutAllJobMaterials: async () => ({
        warnings: ['Checked out 1 film box and 0 caulk allocations for job 18722.'],
        stagingState: { blockingReason: '' },
      }),
      loadJobStagingValidationState: async () => {
        loadCount += 1;
        return { blockingReason: '' };
      },
      queryRow: async () => {
        updateCount += 1;
        return {
          job_number: '18722',
          is_staged_for_pickup: true,
          updated_at: '2026-04-15T12:00:00Z',
        };
      },
      mapDbJobRow: (row) => ({
        jobNumber: row.job_number,
        isStagedForPickup: row.is_staged_for_pickup,
        updatedAt: row.updated_at,
      }),
    },
  );

  assert.equal(loadCount, 0);
  assert.equal(updateCount, 1);
  assert.equal(result.isStagedForPickup, true);
  assert.equal(result.updatedAt, '2026-04-15T12:00:00Z');
  assert.deepEqual(result.warnings, ['Checked out 1 film box and 0 caulk allocations for job 18722.']);
});

test('executeSetJobStagedPickup rejects closed jobs', async () => {
  await assert.rejects(
    () =>
      executeSetJobStagedPickup(
        {},
        'org-1',
        '18722',
        true,
        'tester',
        {},
        {
          normalizeJobNumberDigits: (value) => String(value).trim(),
          asTrimmedString: (value) => String(value || '').trim(),
          resolveExistingOrLegacyJobHeader: async () => ({
            header: {
              jobNumber: '18722',
              warehouse: 'IL1',
              lifecycleStatus: 'COMPLETED',
            },
          }),
          normalizeJobLifecycleStatus: () => 'COMPLETED',
        },
      ),
    /Job 18722 is closed and staged pickup cannot be changed\./,
  );
});

test('getJobStagingBlockingReason keeps transfer blockers intact', () => {
  const reason = getJobStagingBlockingReason(
    [{ requiredFeet: 25, remainingFeet: 0 }],
    [],
    [],
    [],
    [],
    [{ boxId: 'IL1-100', state: 'TRANSFER_PENDING' }],
    [],
    {},
  );

  assert.equal(reason, 'Receive transferred film before staging this job.');
});

test('getJobStagingBlockingReason blocks pending caulk transfers', () => {
  const reason = getJobStagingBlockingReason(
    [{ requiredFeet: 25, remainingFeet: 0 }],
    [{ requiredTubes: 3, remainingTubes: 0 }],
    [],
    [],
    [],
    [],
    [{ caulkAllocationId: 'caulk-1', state: 'TRANSFER_PENDING' }],
    {},
  );

  assert.equal(reason, 'Receive transferred caulk before staging this job.');
});

test('getJobStagingBlockingReason combines film and caulk transfer blockers', () => {
  const reason = getJobStagingBlockingReason(
    [{ requiredFeet: 25, remainingFeet: 0 }],
    [{ requiredTubes: 3, remainingTubes: 0 }],
    [],
    [],
    [],
    [{ boxId: 'IL1-100', state: 'TRANSFER_PENDING' }],
    [{ caulkAllocationId: 'caulk-1', state: 'TRANSFER_PENDING' }],
    {},
  );

  assert.equal(reason, 'Receive transferred film and caulk before staging this job.');
});

test('getJobStagingBlockingReason keeps ordered-allocation blockers intact', () => {
  const reason = getJobStagingBlockingReason(
    [{ requiredFeet: 25, remainingFeet: 0 }],
    [],
    [
      {
        boxId: 'IL1-200',
        status: 'ACTIVE',
        allocationKind: 'REQUIREMENT',
        allocatedFeet: 25,
      },
    ],
    [],
    [],
    [],
    [],
    {
      'IL1-200': {
        boxId: 'IL1-200',
        status: 'ORDERED',
      },
    },
  );

  assert.equal(reason, 'Receive ordered film before staging this job.');
});

test('getJobStagingBlockingReason keeps unchecked-out caulk blockers intact', () => {
  const reason = getJobStagingBlockingReason(
    [{ requiredFeet: 25, remainingFeet: 0 }],
    [{ requiredTubes: 1, remainingTubes: 0 }],
    [],
    [],
    [
      {
        status: 'ACTIVE',
        allocatedTubes: 1,
        reservedTubesRemaining: 1,
      },
    ],
    [],
    [],
    {},
  );

  assert.equal(reason, 'All required caulk must be checked out before staging this job.');
});
