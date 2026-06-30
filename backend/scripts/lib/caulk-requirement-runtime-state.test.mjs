import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPublicCaulkRequirementEntries,
  deriveCaulkRequirementCompletionResult,
} from '../../src/app/services/runtime/runtimeAllocationCoverage.mjs';
import { computeJobStatusFromRequirements } from '../../src/app/services/runtime/runtimeJobSummaries.mjs';

function buildCaulkRequirement(overrides = {}) {
  return {
    requirementId: '22222222-2222-4222-8222-222222222222',
    jobNumber: '5143',
    productId: '33333333-3333-4333-8333-333333333333',
    manufacturer: '3M',
    productName: 'IPA',
    productCode: 'Black',
    tubesPerCase: 12,
    requiredTubes: 8,
    status: 'ACTIVE',
    actualUsedTubes: 0,
    ...overrides,
  };
}

function buildCaulkAllocation(overrides = {}) {
  return {
    caulkAllocationId: 'alloc-1',
    requirementId: '22222222-2222-4222-8222-222222222222',
    jobNumber: '5143',
    productId: '33333333-3333-4333-8333-333333333333',
    warehouse: 'IL1',
    allocatedTubes: 8,
    reservedTubesRemaining: 8,
    checkedOutTubesTotal: 0,
    returnedUnusedTubesTotal: 0,
    usedTubesTotal: 0,
    outstandingCheckoutTubes: 0,
    openCheckoutCount: 0,
    status: 'ACTIVE',
    resolvedAt: '',
    ...overrides,
  };
}

test('new caulk requirement rows default to Active with no actual usage', () => {
  const [entry] = buildPublicCaulkRequirementEntries([buildCaulkRequirement({ status: undefined })], [], {
    jobNumber: '5143',
    jobWarehouse: 'IL1',
  });

  assert.equal(entry.status, 'ACTIVE');
  assert.equal(entry.isComplete, false);
  assert.equal(entry.actualUsedTubes, 0);
  assert.equal(entry.completionResult, '');
  assert.equal(entry.remainingTubes, 8);
});

test('caulk completion result is green for under or exact usage and red for overuse', () => {
  assert.equal(deriveCaulkRequirementCompletionResult(buildCaulkRequirement({ status: 'COMPLETE' }), 8, 5), 'ON_TARGET');
  assert.equal(deriveCaulkRequirementCompletionResult(buildCaulkRequirement({ status: 'COMPLETE' }), 8, 8), 'ON_TARGET');
  assert.equal(deriveCaulkRequirementCompletionResult(buildCaulkRequirement({ status: 'COMPLETE' }), 8, 9), 'OVERUSED');
  assert.equal(deriveCaulkRequirementCompletionResult(buildCaulkRequirement({ status: 'ACTIVE' }), 8, 9), '');
});

test('complete caulk requirements do not create material demand, and active rows do', () => {
  const completeStatus = computeJobStatusFromRequirements(
    'ACTIVE',
    false,
    false,
    [],
    [buildCaulkRequirement({ status: 'COMPLETE', actualUsedTubes: 8 })],
    [],
    [],
    { jobNumber: '5143', jobWarehouse: 'IL1' }
  );
  assert.equal(completeStatus, 'READY');

  const activeStatus = computeJobStatusFromRequirements(
    'ACTIVE',
    false,
    false,
    [],
    [buildCaulkRequirement({ status: 'ACTIVE', actualUsedTubes: 9 })],
    [],
    [],
    { jobNumber: '5143', jobWarehouse: 'IL1' }
  );
  assert.equal(activeStatus, 'NEEDS_ALLOCATION');
});

test('active caulk allocation coverage fulfills only active caulk requirements', () => {
  const [completeEntry] = buildPublicCaulkRequirementEntries(
    [buildCaulkRequirement({ status: 'COMPLETE', actualUsedTubes: 8 })],
    [buildCaulkAllocation()],
    { jobNumber: '5143', jobWarehouse: 'IL1' }
  );
  assert.equal(completeEntry.allocatedTubes, 0);
  assert.equal(completeEntry.remainingTubes, 0);

  const [activeEntry] = buildPublicCaulkRequirementEntries(
    [buildCaulkRequirement({ status: 'ACTIVE' })],
    [buildCaulkAllocation()],
    { jobNumber: '5143', jobWarehouse: 'IL1' }
  );
  assert.equal(activeEntry.allocatedTubes, 8);
  assert.equal(activeEntry.remainingTubes, 0);
});
