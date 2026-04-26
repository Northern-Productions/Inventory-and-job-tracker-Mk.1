import test from 'node:test';
import assert from 'node:assert/strict';

import { planBoxCheckIn } from '../../src/app/services/runtime/runtimeBoxCheckin.mjs';

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
    initialWeightLbs: null,
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

test('planBoxCheckIn calibrates missing-initial-weight returns and releases same-job planning feet', () => {
  const plan = planBoxCheckIn(
    buildBox(),
    {
      lastRollWeightLbs: 3.34,
      currentFeetOnRoll: 19,
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
  assert.equal(plan.lfWeightLbsPerFt, 0.108174);
  assert.equal(plan.usedCalibration, true);
  assert.equal(plan.autoMoveToZeroed, false);
});

test('planBoxCheckIn preserves other-job reservations after same-job check-in release', () => {
  const plan = planBoxCheckIn(
    buildBox(),
    {
      lastRollWeightLbs: 2.37,
      currentFeetOnRoll: 10,
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

test('planBoxCheckIn flags zero-foot returns for auto-zero handling', () => {
  const plan = planBoxCheckIn(
    buildBox(),
    {
      lastRollWeightLbs: 0,
      currentFeetOnRoll: 0,
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
      currentFeetOnRoll: 0,
    },
    [buildAllocation()],
    '4580'
  );

  assert.equal(plan.usedCalibration, true);
  assert.equal(plan.physicalFeetAfterCheckIn, 0);
  assert.equal(plan.autoMoveToZeroed, true);
});

test('planBoxCheckIn requires current feet for approved direct-to-site first returns', () => {
  assert.throws(
    () =>
      planBoxCheckIn(
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
      ),
    /CurrentFeetOnRoll is required/
  );
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

test('planBoxCheckIn rejects manual reservations that exceed returned physical LF', () => {
  assert.throws(
    () =>
      planBoxCheckIn(
        buildBox(),
        {
          lastRollWeightLbs: 1.9,
          currentFeetOnRoll: 5,
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
      ),
    /CurrentFeetOnRoll cannot be lower than the box's locked allocated feet \(10\)\./
  );
});

test('planBoxCheckIn leaves AUTO_PLANNED overage for planner reconciliation', () => {
  const plan = planBoxCheckIn(
    buildBox(),
    {
      lastRollWeightLbs: 1.9,
      currentFeetOnRoll: 5,
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

test('planBoxCheckIn requires a core type when calibration cannot derive a core weight', () => {
  assert.throws(
    () =>
      planBoxCheckIn(
        buildBox({
          coreType: '',
          coreWeightLbs: null,
        }),
        {
          lastRollWeightLbs: 3.34,
          currentFeetOnRoll: 19,
        },
        [buildAllocation()],
        '4580'
      ),
    /CoreType is required/
  );
});

test('planBoxCheckIn rejects nonzero weight when current feet is zero', () => {
  assert.throws(
    () =>
      planBoxCheckIn(
        buildBox(),
        {
          lastRollWeightLbs: 0.5,
          currentFeetOnRoll: 0,
        },
        [buildAllocation()],
        '4580'
      ),
    /CurrentFeetOnRoll cannot be 0/
  );
});
