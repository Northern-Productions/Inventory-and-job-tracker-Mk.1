import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBoxReservationSnapshot } from '../../../shared/domain/filmAllocationReservations.mjs';

function buildBox(overrides = {}) {
  return {
    boxId: 'IL1-6594',
    status: 'IN_STOCK',
    initialFeet: 100,
    feetAvailable: 100,
    ...overrides,
  };
}

function buildAllocation(overrides = {}) {
  return {
    allocationId: 'alloc-1',
    boxId: 'IL1-6594',
    jobNumber: '1001',
    requirementId: '11111111-1111-4111-8111-111111111111',
    allocatedFeet: 10,
    status: 'ACTIVE',
    installDate: '2026-04-24',
    allocationKind: 'REQUIREMENT',
    allocationSource: 'MANUAL',
    createdAt: '2026-04-01T09:00:00.000Z',
    ...overrides,
  };
}

test('buildBoxReservationSnapshot subtracts active requirement reservations across sources', () => {
  const snapshot = buildBoxReservationSnapshot(
    buildBox({ feetAvailable: 70 }),
    [
      buildAllocation({ allocationId: 'manual', allocatedFeet: 20, allocationSource: 'MANUAL' }),
      buildAllocation({ allocationId: 'auto', allocatedFeet: 30, allocationSource: 'AUTO_PLANNED' }),
      buildAllocation({ allocationId: 'receipt', allocatedFeet: 10, allocationSource: 'FILM_ORDER_RECEIPT' }),
      buildAllocation({ allocationId: 'direct', allocatedFeet: 5, allocationSource: 'DIRECT_TO_JOB_SITE' }),
    ]
  );

  assert.equal(snapshot.physicalFeetAvailable, 105);
  assert.equal(snapshot.activeAllocatedFeet, 65);
  assert.equal(snapshot.allocatableNowFeet, 40);
  assert.equal(snapshot.allocationSnapshotsById.auto.backedPhysicalFeet, 30);
});

test('buildBoxReservationSnapshot counts AUTO_PLANNED reservations without relying on stored feetAvailable', () => {
  const snapshot = buildBoxReservationSnapshot(
    buildBox({ feetAvailable: 100 }),
    [buildAllocation({ allocationId: 'auto', allocatedFeet: 100, installDate: '', allocationSource: 'AUTO_PLANNED' })]
  );

  assert.equal(snapshot.physicalFeetAvailable, 100);
  assert.equal(snapshot.allocatableNowFeet, 0);
  assert.equal(snapshot.allocatedWithoutInstallDateFeet, 100);
});

test('buildBoxReservationSnapshot treats received film-order allocations as physical commitments without install dates', () => {
  const snapshot = buildBoxReservationSnapshot(
    buildBox({ feetAvailable: 0 }),
    [
      buildAllocation({
        allocationId: 'receipt-without-install-date',
        allocatedFeet: 100,
        installDate: '',
        allocationSource: 'FILM_ORDER_RECEIPT',
      }),
    ]
  );

  assert.equal(snapshot.physicalFeetAvailable, 100);
  assert.equal(snapshot.activeAllocatedFeet, 100);
  assert.equal(snapshot.allocatableNowFeet, 0);
  assert.equal(snapshot.allocatedWithoutInstallDateFeet, 100);
  assert.equal(snapshot.allocationSnapshotsById['receipt-without-install-date'].backedPhysicalFeet, 100);
});

test('buildBoxReservationSnapshot excludes extra, placeholder, cancelled, and invalid allocations', () => {
  const snapshot = buildBoxReservationSnapshot(
    buildBox({ feetAvailable: 100 }),
    [
      buildAllocation({ allocationId: 'extra', allocatedFeet: 20, allocationKind: 'EXTRA' }),
      buildAllocation({ allocationId: 'placeholder', allocatedFeet: 20, jobNumber: '', jobId: null }),
      buildAllocation({ allocationId: 'cancelled', allocatedFeet: 20, status: 'CANCELLED' }),
      buildAllocation({ allocationId: 'invalid', allocatedFeet: 20, requirementId: '' }),
    ]
  );

  assert.equal(snapshot.activeAllocatedFeet, 0);
  assert.equal(snapshot.allocatableNowFeet, 100);
  assert.equal(snapshot.allocationSnapshotsById.placeholder.backedPhysicalFeet, 0);
});

test('buildBoxReservationSnapshot counts fulfilled requirement allocations while checked out', () => {
  const snapshot = buildBoxReservationSnapshot(
    buildBox({ status: 'CHECKED_OUT', feetAvailable: 0 }),
    [
      buildAllocation({
        allocationId: 'fulfilled-checked-out',
        allocatedFeet: 45,
        status: 'FULFILLED',
        allocationSource: 'MANUAL',
      }),
    ]
  );

  assert.equal(snapshot.activeAllocatedFeet, 45);
  assert.equal(snapshot.allocatableNowFeet, 0);
  assert.equal(snapshot.allocationSnapshotsById['fulfilled-checked-out'].backedPhysicalFeet, 45);
});

test('buildBoxReservationSnapshot stops counting fulfilled allocations after check-in', () => {
  const snapshot = buildBoxReservationSnapshot(
    buildBox({ status: 'IN_STOCK', feetAvailable: 55 }),
    [
      buildAllocation({
        allocationId: 'fulfilled-returned',
        allocatedFeet: 45,
        status: 'FULFILLED',
        allocationSource: 'MANUAL',
      }),
    ]
  );

  assert.equal(snapshot.activeAllocatedFeet, 0);
  assert.equal(snapshot.allocatableNowFeet, 55);
});
