import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBoxReservationSnapshot } from '../../../shared/domain/filmAllocationReservations.mjs';
import { applyReservationMetricsToBox } from '../../src/app/services/runtime/runtimeAllocationReservations.mjs';
import { toPublicBox } from '../../src/app/repositories/inventoryRepositories.mjs';

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
    buildBox({ status: 'CHECKED_OUT', feetAvailable: 45 }),
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

test('buildBoxReservationSnapshot uses stored checked-out physical feet instead of initial feet', () => {
  const snapshot = buildBoxReservationSnapshot(
    buildBox({ status: 'CHECKED_OUT', initialFeet: 20, feetAvailable: 12 }),
    [
      buildAllocation({
        allocationId: 'checked-out-fixture',
        allocatedFeet: 12,
        installDate: '',
        allocationSource: 'AUTO_PLANNED',
      }),
    ]
  );

  assert.equal(snapshot.physicalFeetAvailable, 12);
  assert.equal(snapshot.allocatableNowFeet, 0);
  assert.equal(snapshot.allocatedWithoutInstallDateFeet, 12);
  assert.equal(snapshot.allocationSnapshotsById['checked-out-fixture'].backedPhysicalFeet, 12);
  assert.equal(snapshot.allocationSnapshotsById['checked-out-fixture'].shortageFeet, 0);
});

test('buildBoxReservationSnapshot protects scheduled jobs before unscheduled jobs when physical LF is short', () => {
  const snapshot = buildBoxReservationSnapshot(
    buildBox({ status: 'CHECKED_OUT', initialFeet: 100, feetAvailable: 70 }),
    [
      buildAllocation({
        allocationId: 'unscheduled-old-job',
        jobId: '11111111-1111-4111-8111-111111111111',
        allocatedFeet: 50,
        installDate: '',
      }),
      buildAllocation({
        allocationId: 'scheduled-later-job',
        jobId: '22222222-2222-4222-8222-222222222222',
        allocatedFeet: 25,
        installDate: '2026-04-25',
      }),
      buildAllocation({
        allocationId: 'scheduled-earliest-job',
        jobId: '33333333-3333-4333-8333-333333333333',
        allocatedFeet: 25,
        installDate: '2026-04-20',
      }),
    ],
    {
      jobCreatedAtByJobId: {
        '11111111-1111-4111-8111-111111111111': '2026-03-01T10:00:00.000Z',
        '22222222-2222-4222-8222-222222222222': '2026-03-03T10:00:00.000Z',
        '33333333-3333-4333-8333-333333333333': '2026-03-04T10:00:00.000Z',
      },
    }
  );

  assert.equal(snapshot.allocationSnapshotsById['scheduled-earliest-job'].backedPhysicalFeet, 25);
  assert.equal(snapshot.allocationSnapshotsById['scheduled-later-job'].backedPhysicalFeet, 25);
  assert.equal(snapshot.allocationSnapshotsById['unscheduled-old-job'].backedPhysicalFeet, 20);
  assert.equal(snapshot.allocationSnapshotsById['unscheduled-old-job'].shortageFeet, 30);
});

test('buildBoxReservationSnapshot uses job creation and jobId tie-breakers within equal priority groups', () => {
  const snapshot = buildBoxReservationSnapshot(
    buildBox({ status: 'CHECKED_OUT', initialFeet: 100, feetAvailable: 55 }),
    [
      buildAllocation({
        allocationId: 'scheduled-newer',
        jobId: '33333333-3333-4333-8333-333333333333',
        allocatedFeet: 20,
        installDate: '2026-04-20',
      }),
      buildAllocation({
        allocationId: 'scheduled-jobid-later',
        jobId: '22222222-2222-4222-8222-222222222222',
        allocatedFeet: 20,
        installDate: '2026-04-20',
      }),
      buildAllocation({
        allocationId: 'scheduled-jobid-earlier',
        jobId: '11111111-1111-4111-8111-111111111111',
        allocatedFeet: 20,
        installDate: '2026-04-20',
      }),
    ],
    {
      jobCreatedAtByJobId: {
        '11111111-1111-4111-8111-111111111111': '2026-03-01T10:00:00.000Z',
        '22222222-2222-4222-8222-222222222222': '2026-03-01T10:00:00.000Z',
        '33333333-3333-4333-8333-333333333333': '2026-03-02T10:00:00.000Z',
      },
    }
  );

  assert.equal(snapshot.allocationSnapshotsById['scheduled-jobid-earlier'].backedPhysicalFeet, 20);
  assert.equal(snapshot.allocationSnapshotsById['scheduled-jobid-later'].backedPhysicalFeet, 20);
  assert.equal(snapshot.allocationSnapshotsById['scheduled-newer'].backedPhysicalFeet, 15);
  assert.equal(snapshot.allocationSnapshotsById['scheduled-newer'].shortageFeet, 5);
});

test('buildBoxReservationSnapshot keeps checked-out physical feet separate from public allocatable feet', () => {
  const snapshot = buildBoxReservationSnapshot(
    buildBox({ status: 'CHECKED_OUT', initialFeet: 20, feetAvailable: 0, storedFeetAvailable: 12 }),
    [
      buildAllocation({
        allocationId: 'checked-out-public-read',
        allocatedFeet: 12,
        installDate: '',
        allocationSource: 'AUTO_PLANNED',
      }),
    ]
  );

  assert.equal(snapshot.physicalFeetAvailable, 12);
  assert.equal(snapshot.allocatableNowFeet, 0);
  assert.equal(snapshot.allocatedWithoutInstallDateFeet, 12);
  assert.equal(snapshot.allocationSnapshotsById['checked-out-public-read'].backedPhysicalFeet, 12);
  assert.equal(snapshot.allocationSnapshotsById['checked-out-public-read'].shortageFeet, 0);
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

test('applyReservationMetricsToBox keeps full-roll edge cases at 100 LF with no allocations', () => {
  const readPayload = toPublicBox(
    applyReservationMetricsToBox(
      buildBox({
        boxId: 'IL1-6890',
        feetAvailable: 99,
        initialFeet: 100,
        lastRollWeightLbs: 24.65,
        coreWeightLbs: 1.3333,
        lfWeightLbsPerFt: 0.233167,
      }),
      []
    )
  );

  assert.equal(readPayload.physicalFeetAvailable, 100);
  assert.equal(readPayload.allocatableNowFeet, 100);
  assert.equal(readPayload.feetAvailable, 100);
});

test('applyReservationMetricsToBox separates full-roll physical LF from reserved allocatable LF', () => {
  const readPayload = toPublicBox(
    applyReservationMetricsToBox(
      buildBox({
        boxId: 'IL1-6890',
        feetAvailable: 99,
        initialFeet: 100,
        lastRollWeightLbs: 24.65,
        coreWeightLbs: 1.3333,
        lfWeightLbsPerFt: 0.233167,
      }),
      [buildAllocation({ allocationId: 'reserved-1', allocatedFeet: 1 })]
    )
  );

  assert.equal(readPayload.physicalFeetAvailable, 100);
  assert.equal(readPayload.allocatableNowFeet, 99);
  assert.equal(readPayload.feetAvailable, 99);
});
