import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBoxReservationSnapshot } from '../../../shared/domain/filmAllocationReservations.mjs';

function buildBox(overrides = {}) {
  return {
    boxId: 'IL1-6880',
    status: 'IN_STOCK',
    initialFeet: 100,
    feetAvailable: 0,
    ...overrides,
  };
}

function buildAllocation(overrides = {}) {
  return {
    allocationId: 'alloc-1',
    boxId: 'IL1-6880',
    jobNumber: '1001',
    allocatedFeet: 10,
    status: 'ACTIVE',
    installDate: '',
    createdAt: '2026-04-01T09:00:00.000Z',
    ...overrides,
  };
}

test('buildBoxReservationSnapshot prioritizes scheduled work ahead of older placeholders', () => {
  const snapshot = buildBoxReservationSnapshot(
    buildBox({ feetAvailable: 50 }),
    [
      buildAllocation({
        allocationId: 'placeholder-oldest',
        jobNumber: '4449',
        allocatedFeet: 60,
        createdAt: '2026-04-16T10:06:00.000Z',
      }),
      buildAllocation({
        allocationId: 'placeholder-newer',
        jobNumber: '4450',
        allocatedFeet: 40,
        createdAt: '2026-04-16T10:28:00.000Z',
      }),
      buildAllocation({
        allocationId: 'scheduled-urgent',
        jobNumber: '4690',
        allocatedFeet: 50,
        installDate: '2026-04-24',
        createdAt: '2026-04-16T11:00:00.000Z',
      }),
    ],
    {
      jobCreatedAtByJobNumber: {
        '4449': '2026-04-16T10:06:00.000Z',
        '4450': '2026-04-16T10:28:00.000Z',
        '4690': '2026-04-16T11:00:00.000Z',
      },
    }
  );

  assert.equal(snapshot.physicalFeetAvailable, 100);
  assert.equal(snapshot.allocatableNowFeet, 50);
  assert.equal(snapshot.allocatedWithInstallDateFeet, 50);
  assert.equal(snapshot.allocatedWithoutInstallDateFeet, 100);
  assert.equal(snapshot.allocationSnapshotsById['scheduled-urgent'].backedPhysicalFeet, 50);
  assert.equal(snapshot.allocationSnapshotsById['scheduled-urgent'].reservationState, 'WITH_INSTALL_DATE');
  assert.equal(snapshot.allocationSnapshotsById['placeholder-oldest'].backedPhysicalFeet, 50);
  assert.equal(snapshot.allocationSnapshotsById['placeholder-newer'].backedPhysicalFeet, 0);
});

test('buildBoxReservationSnapshot gives the oldest placeholder first claim on remaining physical feet', () => {
  const snapshot = buildBoxReservationSnapshot(
    buildBox({ feetAvailable: 80 }),
    [
      buildAllocation({
        allocationId: 'placeholder-first',
        jobNumber: '18992',
        allocatedFeet: 60,
        createdAt: '2026-04-13T14:16:00.000Z',
      }),
      buildAllocation({
        allocationId: 'placeholder-second',
        jobNumber: '4691',
        allocatedFeet: 40,
        createdAt: '2026-04-16T12:00:00.000Z',
      }),
    ],
    {
      jobCreatedAtByJobNumber: {
        '18992': '2026-04-13T14:16:00.000Z',
        '4691': '2026-04-16T12:00:00.000Z',
      },
    }
  );

  assert.equal(snapshot.physicalFeetAvailable, 80);
  assert.equal(snapshot.allocatableNowFeet, 80);
  assert.equal(snapshot.allocatedWithInstallDateFeet, 0);
  assert.equal(snapshot.allocatedWithoutInstallDateFeet, 100);
  assert.equal(snapshot.allocationSnapshotsById['placeholder-first'].backedPhysicalFeet, 60);
  assert.equal(snapshot.allocationSnapshotsById['placeholder-second'].backedPhysicalFeet, 20);
  assert.equal(snapshot.allocationSnapshotsById['placeholder-second'].shortageFeet, 20);
});
