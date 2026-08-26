import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planBoxCheckIn,
  resolveBoxWeightCalibration,
} from '../../src/app/services/runtime/runtimeBoxCheckin.mjs';

function buildBox(overrides = {}) {
  return {
    boxId: 'MS1-919',
    warehouse: 'MS1',
    manufacturer: '3M Fasara',
    filmName: 'Milano Milky White SH2MAML',
    widthIn: 50,
    initialFeet: 45,
    feetAvailable: 5,
    status: 'CHECKED_OUT',
    receivedDate: '2023-07-31',
    initialWeightLbs: 6.15,
    lastRollWeightLbs: null,
    lastWeighedDate: '',
    coreType: 'Red plastic',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    lastCheckoutJob: '4580',
    lastCheckoutDate: '2026-04-15',
    ...overrides,
  };
}

function buildAllocation(overrides = {}) {
  return {
    allocationId: 'alloc-1',
    boxId: 'MS1-919',
    jobNumber: '4580',
    installDate: '2026-04-15',
    allocatedFeet: 20,
    status: 'ACTIVE',
    filmOrderId: '',
    requirementId: '11111111-1111-4111-8111-111111111111',
    allocationKind: 'REQUIREMENT',
    allocationSource: 'MANUAL',
    ...overrides,
  };
}

test('resolveBoxWeightCalibration prefers valid saved calibration', () => {
  const calibration = resolveBoxWeightCalibration(
    buildBox({
      coreWeightLbs: 1.2,
      lfWeightLbsPerFt: 0.1,
    }),
    {
      sqFtWeightLbsPerSqFt: 0.5,
      defaultCoreType: 'Cardboard 1/8"',
    }
  );

  assert.deepEqual(calibration, {
    resolved: true,
    source: 'SAVED_BOX',
    coreType: 'Red plastic',
    coreWeightLbs: 1.2,
    lfWeightLbsPerFt: 0.1,
  });
});

test('resolveBoxWeightCalibration derives a box-specific baseline before catalog fallback', () => {
  const calibration = resolveBoxWeightCalibration(buildBox(), {
    sqFtWeightLbsPerSqFt: 0.5,
    defaultCoreType: 'Cardboard 1/8"',
  });

  assert.equal(calibration.resolved, true);
  assert.equal(calibration.source, 'BOX_INITIAL_BASELINE');
  assert.equal(calibration.coreType, 'Red plastic');
  assert.equal(calibration.coreWeightLbs, 1.2847);
  assert.equal(calibration.lfWeightLbsPerFt, 0.108118);
});

test('resolveBoxWeightCalibration uses the existing film catalog when box-specific history is incomplete', () => {
  const calibration = resolveBoxWeightCalibration(
    buildBox({
      initialWeightLbs: null,
      coreType: '',
    }),
    {
      sqFtWeightLbsPerSqFt: 0.03,
      defaultCoreType: 'Cardboard 1/8"',
    }
  );

  assert.equal(calibration.resolved, true);
  assert.equal(calibration.source, 'FILM_CATALOG');
  assert.equal(calibration.coreType, 'Cardboard 1/8"');
  assert.equal(calibration.lfWeightLbsPerFt, 0.125);
});

test('planBoxCheckIn self-heals missing saved calibration and releases same-job planning feet', () => {
  const plan = planBoxCheckIn(
    buildBox(),
    {
      lastRollWeightLbs: 3.34,
      currentFeetOnRoll: 44,
      coreType: 'Cardboard 3/8"',
    },
    [buildAllocation()],
    '4580'
  );

  assert.equal(plan.physicalFeetBeforeCheckIn, 25);
  assert.equal(plan.physicalFeetAfterCheckIn, 19);
  assert.equal(plan.feetAvailableAfterCheckIn, 19);
  assert.equal(plan.sameJobActiveAllocationCount, 1);
  assert.equal(plan.sameJobActiveAllocatedFeet, 20);
  assert.equal(plan.otherActiveAllocatedFeet, 0);
  assert.equal(plan.coreType, 'Red plastic');
  assert.equal(plan.coreWeightLbs, 1.2847);
  assert.equal(plan.lfWeightLbsPerFt, 0.108118);
  assert.equal(plan.calibrationSource, 'BOX_INITIAL_BASELINE');
  assert.equal(plan.usedCalibration, true);
  assert.equal(plan.autoMoveToZeroed, false);
});

test('planBoxCheckIn preserves other-job reservations after same-job check-in release', () => {
  const plan = planBoxCheckIn(
    buildBox(),
    {
      lastRollWeightLbs: 2.37,
      currentFeetOnRoll: 40,
    },
    [
      buildAllocation(),
      buildAllocation({
        allocationId: 'alloc-2',
        jobNumber: '7777',
        allocatedFeet: 5,
      }),
    ],
    '4580'
  );

  assert.equal(plan.physicalFeetBeforeCheckIn, 30);
  assert.equal(plan.physicalFeetAfterCheckIn, 10);
  assert.equal(plan.feetAvailableAfterCheckIn, 5);
  assert.equal(plan.sameJobActiveAllocatedFeet, 20);
  assert.equal(plan.otherActiveAllocatedFeet, 5);
  assert.deepEqual(plan.otherJobs, ['7777']);
});

test('planBoxCheckIn scopes same-number check-in release by jobId when available', () => {
  const checkoutJobId = '11111111-1111-4111-8111-111111111111';
  const otherScopeJobId = '22222222-2222-4222-8222-222222222222';
  const plan = planBoxCheckIn(
    buildBox(),
    {
      lastRollWeightLbs: 2.37,
      currentFeetOnRoll: 40,
    },
    [
      buildAllocation({
        allocationId: 'alloc-s1',
        jobId: checkoutJobId,
        jobNumber: '9327001',
        allocatedFeet: 12,
      }),
      buildAllocation({
        allocationId: 'alloc-s2',
        jobId: otherScopeJobId,
        jobNumber: '9327001',
        allocatedFeet: 6,
      }),
    ],
    '9327001',
    { jobId: checkoutJobId }
  );

  assert.equal(plan.sameJobActiveAllocationCount, 1);
  assert.equal(plan.sameJobActiveAllocatedFeet, 12);
  assert.equal(plan.otherActiveAllocatedFeet, 6);
  assert.deepEqual(plan.otherJobs, ['9327001']);
});

test('planBoxCheckIn flags zero-foot returns for auto-zero handling', () => {
  const plan = planBoxCheckIn(
    buildBox(),
    {
      lastRollWeightLbs: 0,
      currentFeetOnRoll: 40,
    },
    [buildAllocation()],
    '4580'
  );

  assert.equal(plan.physicalFeetAfterCheckIn, 0);
  assert.equal(plan.feetAvailableAfterCheckIn, 0);
  assert.equal(plan.autoMoveToZeroed, true);
});

test('planBoxCheckIn allows direct-to-site first returns without a received date and still zeroes fully-used rolls', () => {
  const plan = planBoxCheckIn(
    buildBox({
      receivedDate: '',
      directToJobSite: true,
      lastRollWeightLbs: null,
    }),
    {
      lastRollWeightLbs: 0,
    },
    [buildAllocation()],
    '4580'
  );

  assert.equal(plan.usedCalibration, true);
  assert.equal(plan.physicalFeetAfterCheckIn, 0);
  assert.equal(plan.autoMoveToZeroed, true);
});

test('planBoxCheckIn keeps direct-to-site first returns weight-only when initial history is sufficient', () => {
  const plan = planBoxCheckIn(
    buildBox({
      receivedDate: '',
      directToJobSite: true,
      lastRollWeightLbs: null,
    }),
    {
      lastRollWeightLbs: 3.34,
    },
    [buildAllocation()],
    '4580'
  );

  assert.equal(plan.physicalFeetAfterCheckIn, 19);
  assert.equal(plan.calibrationSource, 'BOX_INITIAL_BASELINE');
});

test('planBoxCheckIn keeps normal weight-only returns on the existing derived path', () => {
  const plan = planBoxCheckIn(
    buildBox({
      feetAvailable: 5,
      lastRollWeightLbs: 3.2,
      coreWeightLbs: 1.2,
      lfWeightLbsPerFt: 0.1,
      initialWeightLbs: null,
      coreType: 'Cardboard 1/8"',
    }),
    {
      lastRollWeightLbs: 2.9,
    },
    [buildAllocation({ allocatedFeet: 15 })],
    '4580'
  );

  assert.equal(plan.usedCalibration, false);
  assert.equal(plan.physicalFeetBeforeCheckIn, 20);
  assert.equal(plan.physicalFeetAfterCheckIn, 17);
  assert.equal(plan.feetAvailableAfterCheckIn, 17);
  assert.equal(plan.sameJobActiveAllocatedFeet, 15);
});

test('planBoxCheckIn allows manual reservations to exceed returned physical LF for DB reconciliation', () => {
  const plan = planBoxCheckIn(
    buildBox(),
    {
      lastRollWeightLbs: 1.9,
      currentFeetOnRoll: 40,
    },
    [
      buildAllocation(),
      buildAllocation({
        allocationId: 'alloc-2',
        jobNumber: '7777',
        allocatedFeet: 10,
      }),
    ],
    '4580'
  );

  assert.equal(plan.physicalFeetAfterCheckIn, 5);
  assert.equal(plan.manualReservationOverageFeet, 5);
  assert.equal(plan.feetAvailableAfterCheckIn, 0);
});

test('planBoxCheckIn leaves AUTO_PLANNED overage for planner reconciliation', () => {
  const plan = planBoxCheckIn(
    buildBox(),
    {
      lastRollWeightLbs: 1.9,
      currentFeetOnRoll: 40,
    },
    [
      buildAllocation(),
      buildAllocation({
        allocationId: 'alloc-2',
        jobNumber: '7777',
        allocatedFeet: 10,
        allocationSource: 'AUTO_PLANNED',
      }),
    ],
    '4580'
  );

  assert.equal(plan.physicalFeetAfterCheckIn, 5);
  assert.equal(plan.feetAvailableAfterCheckIn, 5);
  assert.equal(plan.otherAutoPlannedAllocatedFeet, 10);
  assert.equal(plan.manualReservationOverageFeet, 0);
  assert.equal(plan.autoPlannedReservationOverageFeet, 5);
});

test('planBoxCheckIn fails explicitly when no canonical calibration source can resolve', () => {
  assert.throws(
    () =>
      planBoxCheckIn(
        buildBox({
          coreType: '',
          coreWeightLbs: null,
          initialWeightLbs: null,
        }),
        {
          lastRollWeightLbs: 3.34,
          currentFeetOnRoll: 19,
          coreType: 'Red plastic',
        },
        [buildAllocation()],
        '4580'
      ),
    /missing the roll-weight calibration needed to calculate remaining LF/
  );
});

test('planBoxCheckIn derives LF from returned weight even when an old client submits conflicting LF', () => {
  const plan = planBoxCheckIn(
    buildBox(),
    {
      lastRollWeightLbs: 3.34,
      currentFeetOnRoll: 0,
      coreType: 'Cardboard 3/8"',
    },
    [buildAllocation()],
    '4580'
  );

  assert.equal(plan.physicalFeetAfterCheckIn, 19);
  assert.equal(plan.coreType, 'Red plastic');
  assert.equal(plan.lfWeightLbsPerFt, 0.108118);
});
