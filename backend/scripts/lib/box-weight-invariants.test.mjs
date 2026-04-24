import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertLegalBoxWeightState,
  assertCanCheckoutBoxFromWarehouse,
  getWarehouseCheckoutWeightRequirementMessage,
  hasBoxWeightBaseline,
  requiresFirstReturnCalibration,
  isIllegalCheckedOutBoxWithoutWeightBaseline,
} from '../../src/app/core/helpers.mjs';

function buildBox(overrides = {}) {
  return {
    status: 'IN_STOCK',
    lastRollWeightLbs: 42,
    directToJobSite: false,
    ...overrides,
  };
}

test('hasBoxWeightBaseline uses Last Roll Weight as the canonical outbound baseline', () => {
  assert.equal(hasBoxWeightBaseline(buildBox()), true);
  assert.equal(hasBoxWeightBaseline(buildBox({ lastRollWeightLbs: 0 })), true);
  assert.equal(hasBoxWeightBaseline(buildBox({ lastRollWeightLbs: null })), false);
});

test('checked-out boxes without a weight baseline are illegal unless they are direct-to-job-site', () => {
  assert.equal(
    isIllegalCheckedOutBoxWithoutWeightBaseline(
      buildBox({ status: 'CHECKED_OUT', lastRollWeightLbs: null })
    ),
    true
  );
  assert.equal(
    isIllegalCheckedOutBoxWithoutWeightBaseline(
      buildBox({ status: 'CHECKED_OUT', lastRollWeightLbs: null, directToJobSite: true })
    ),
    false
  );
  assert.equal(
    isIllegalCheckedOutBoxWithoutWeightBaseline(buildBox({ status: 'IN_STOCK', lastRollWeightLbs: null })),
    false
  );
});

test('assertLegalBoxWeightState rejects illegal checked-out missing-weight states with the workflow-safe error', () => {
  assert.throws(
    () => assertLegalBoxWeightState(buildBox({ status: 'CHECKED_OUT', lastRollWeightLbs: null })),
    /direct-to-job-site fulfillment/
  );

  assert.doesNotThrow(() =>
    assertLegalBoxWeightState(
      buildBox({ status: 'CHECKED_OUT', lastRollWeightLbs: null, directToJobSite: true })
    )
  );
});

test('assertCanCheckoutBoxFromWarehouse blocks in-stock warehouse checkout until a weight baseline exists', () => {
  assert.throws(
    () => assertCanCheckoutBoxFromWarehouse(buildBox({ boxId: 'IL1-400', lastRollWeightLbs: null })),
    new RegExp(getWarehouseCheckoutWeightRequirementMessage('IL1-400').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );

  assert.doesNotThrow(() =>
    assertCanCheckoutBoxFromWarehouse(buildBox({ status: 'IN_STOCK', lastRollWeightLbs: 12.4 }))
  );
});

test('requiresFirstReturnCalibration only allows the approved direct-to-site checked-out return path', () => {
  assert.equal(
    requiresFirstReturnCalibration(
      buildBox({
        status: 'CHECKED_OUT',
        directToJobSite: true,
        receivedDate: '',
        lastRollWeightLbs: null,
      })
    ),
    true
  );
  assert.equal(
    requiresFirstReturnCalibration(
      buildBox({
        status: 'CHECKED_OUT',
        directToJobSite: false,
        receivedDate: '',
        lastRollWeightLbs: null,
      })
    ),
    false
  );
  assert.equal(
    requiresFirstReturnCalibration(
      buildBox({
        status: 'CHECKED_OUT',
        directToJobSite: true,
        receivedDate: '2026-04-21',
        lastRollWeightLbs: null,
      })
    ),
    false
  );
});
