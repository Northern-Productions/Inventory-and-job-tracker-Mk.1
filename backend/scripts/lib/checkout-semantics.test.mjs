import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPublicAllocationEntriesForJob } from '../../src/app/services/runtime/runtimeJobSummaries.mjs';
import {
  PENDING_TRANSFER_CHECKOUT_BLOCKED_CODE,
  PENDING_TRANSFER_CHECKOUT_BLOCKED_MESSAGE,
  buildFilmCheckoutActionPlan,
  getPendingTransferCheckoutDenial,
  isPendingTransferCheckoutConflict,
} from '../../../shared/checkoutSemantics.mjs';

function buildAllocation(overrides = {}) {
  return {
    allocationId: 'alloc-1',
    boxId: 'IL1-100',
    warehouse: 'IL1',
    jobNumber: '000123',
    installDate: '2026-04-10',
    crewLeader: 'Crew',
    allocatedFeet: 10,
    coveredFeet: 10,
    status: 'ACTIVE',
    allocationKind: 'REQUIREMENT',
    createdAt: '2026-04-10T10:00:00Z',
    createdBy: 'tester',
    resolvedAt: '',
    resolvedBy: '',
    filmOrderId: '',
    notes: '',
    requirementId: 'req-1',
    ...overrides,
  };
}

function buildBox(overrides = {}) {
  return {
    boxId: 'IL1-100',
    warehouse: 'IL1',
    manufacturer: 'SOLYX',
    filmName: 'Whiteout SXWF-WO',
    widthIn: 60,
    status: 'CHECKED_OUT',
    lastCheckoutJob: '000123',
    ...overrides,
  };
}

test('buildPublicAllocationEntriesForJob flags only the latest checkout cycle rows for a checked-out box', () => {
  const boxById = {
    'IL1-100': buildBox(),
  };
  const allocations = [
    buildAllocation({
      allocationId: 'alloc-history',
      createdAt: '2026-04-10T08:27:00Z',
      resolvedAt: '2026-04-10T09:56:00Z',
    }),
    buildAllocation({
      allocationId: 'alloc-current',
      createdAt: '2026-04-10T10:32:00Z',
      resolvedAt: '2026-04-10T10:35:00Z',
    }),
  ];

  const entries = buildPublicAllocationEntriesForJob(allocations, boxById);
  assert.equal(entries.find((entry) => entry.allocationId === 'alloc-history')?.checkedOutOnThisJob, false);
  assert.equal(entries.find((entry) => entry.allocationId === 'alloc-current')?.checkedOutOnThisJob, true);
});

test('buildPublicAllocationEntriesForJob prefers unresolved active rows when a box is already checked out on the same job', () => {
  const boxById = {
    'IL1-100': buildBox(),
  };
  const allocations = [
    buildAllocation({
      allocationId: 'alloc-resolved',
      createdAt: '2026-04-10T10:32:00Z',
      resolvedAt: '2026-04-10T10:35:00Z',
    }),
    buildAllocation({
      allocationId: 'alloc-open',
      createdAt: '2026-04-10T11:00:00Z',
      resolvedAt: '',
    }),
  ];

  const entries = buildPublicAllocationEntriesForJob(allocations, boxById);
  assert.equal(entries.find((entry) => entry.allocationId === 'alloc-resolved')?.checkedOutOnThisJob, false);
  assert.equal(entries.find((entry) => entry.allocationId === 'alloc-open')?.checkedOutOnThisJob, true);
});

test('buildPublicAllocationEntriesForJob treats fulfilled rows as current only while the box is still checked out to that job', () => {
  const boxById = {
    'IL1-100': buildBox(),
    'IL1-101': buildBox({
      boxId: 'IL1-101',
      status: 'IN_STOCK',
      lastCheckoutJob: '',
    }),
    'IL1-102': buildBox({
      boxId: 'IL1-102',
      status: 'ZEROED',
      lastCheckoutJob: '',
    }),
    'IL1-103': buildBox({
      boxId: 'IL1-103',
      status: 'CHECKED_OUT',
      lastCheckoutJob: '000999',
    }),
  };
  const allocations = [
    buildAllocation({
      allocationId: 'alloc-checked-out',
      status: 'FULFILLED',
      resolvedAt: '2026-04-10T10:35:00Z',
    }),
    buildAllocation({
      allocationId: 'alloc-returned',
      boxId: 'IL1-101',
      status: 'FULFILLED',
      resolvedAt: '2026-04-10T10:36:00Z',
    }),
    buildAllocation({
      allocationId: 'alloc-zeroed',
      boxId: 'IL1-102',
      status: 'FULFILLED',
      resolvedAt: '2026-04-10T10:37:00Z',
    }),
    buildAllocation({
      allocationId: 'alloc-other-job',
      boxId: 'IL1-103',
      status: 'FULFILLED',
      resolvedAt: '2026-04-10T10:38:00Z',
    }),
  ];

  const entries = buildPublicAllocationEntriesForJob(allocations, boxById);
  assert.equal(entries.find((entry) => entry.allocationId === 'alloc-checked-out')?.checkedOutOnThisJob, true);
  assert.equal(entries.find((entry) => entry.allocationId === 'alloc-returned')?.checkedOutOnThisJob, false);
  assert.equal(entries.find((entry) => entry.allocationId === 'alloc-zeroed')?.checkedOutOnThisJob, false);
  assert.equal(entries.find((entry) => entry.allocationId === 'alloc-other-job')?.checkedOutOnThisJob, false);
});

test('buildFilmCheckoutActionPlan ignores stale resolved rows and keeps resolve-only steps for same-job checked-out boxes', () => {
  const allocations = [
    buildAllocation({
      allocationId: 'alloc-history',
      createdAt: '2026-04-10T11:05:00Z',
      resolvedAt: '2026-04-10T11:06:00Z',
    }),
    buildAllocation({
      allocationId: 'alloc-same-job-open',
      createdAt: '2026-04-10T11:00:00Z',
      resolvedAt: '',
    }),
    buildAllocation({
      allocationId: 'alloc-in-stock',
      boxId: 'IL1-101',
      createdAt: '2026-04-10T10:55:00Z',
      resolvedAt: '',
    }),
  ];
  const boxById = {
    'IL1-100': buildBox(),
    'IL1-101': buildBox({
      boxId: 'IL1-101',
      status: 'IN_STOCK',
      lastCheckoutJob: '',
    }),
  };

  const plan = buildFilmCheckoutActionPlan(allocations, boxById, '000123');

  assert.deepEqual(plan, [
    {
      action: 'RESOLVE_ONLY',
      allocationId: 'alloc-same-job-open',
      boxId: 'IL1-100',
    },
    {
      action: 'CHECK_OUT',
      allocationId: 'alloc-in-stock',
      boxId: 'IL1-101',
    },
  ]);
});

test('pending-transfer checkout denial applies only when no requested work was handled', () => {
  assert.deepEqual(
    getPendingTransferCheckoutDenial({
      successfullyHandledCount: 0,
      blockedFilmCount: 1,
      blockedCaulkCount: 0,
    }),
    {
      statusCode: 409,
      code: PENDING_TRANSFER_CHECKOUT_BLOCKED_CODE,
      message: PENDING_TRANSFER_CHECKOUT_BLOCKED_MESSAGE,
    },
  );
  assert.deepEqual(
    getPendingTransferCheckoutDenial({
      successfullyHandledCount: 0,
      blockedFilmCount: 0,
      blockedCaulkCount: 2,
    }),
    {
      statusCode: 409,
      code: PENDING_TRANSFER_CHECKOUT_BLOCKED_CODE,
      message: PENDING_TRANSFER_CHECKOUT_BLOCKED_MESSAGE,
    },
  );
  assert.equal(
    getPendingTransferCheckoutDenial({
      successfullyHandledCount: 1,
      blockedFilmCount: 1,
      blockedCaulkCount: 1,
    }),
    null,
  );
  assert.equal(
    getPendingTransferCheckoutDenial({
      successfullyHandledCount: 0,
      blockedFilmCount: 0,
      blockedCaulkCount: 0,
    }),
    null,
  );
});

test('pending-transfer checkout conflict recognition is limited to reviewed structured outcomes and exact messages', () => {
  const reviewedErrors = [
    { statusCode: 400, message: 'Box BOX-1 is pending transfer and must be received before it can be checked out.' },
    { statusCode: 400, message: 'Box BOX-1 has a pending transfer and can only be received or have the transfer cancelled.' },
    { statusCode: 409, message: 'Box BOX-1 has a pending transfer and can only be received, cancelled, or have its linked claim released.' },
    { statusCode: 409, message: 'A pending-transfer allocation cannot be fulfilled before receipt.' },
    { statusCode: 400, message: 'Receive or cancel transfer TRANSFER-1 before checking out this allocation.' },
    { details: { code: PENDING_TRANSFER_CHECKOUT_BLOCKED_CODE } },
  ];

  for (const error of reviewedErrors) {
    assert.equal(isPendingTransferCheckoutConflict(error), true);
  }

  const unrelatedErrors = [
    { statusCode: 409, message: 'Concurrent update conflict. Retry the request.' },
    { statusCode: 409, message: 'A pending transfer exists.' },
    { statusCode: 500, message: 'A pending-transfer allocation cannot be fulfilled before receipt.' },
    { statusCode: 400, message: 'Receive or cancel transfer before checking out this allocation.' },
    { statusCode: 400, message: 'Receive or cancel transfer TRANSFER-1 before editing this allocation.' },
  ];

  for (const error of unrelatedErrors) {
    assert.equal(isPendingTransferCheckoutConflict(error), false);
  }
});
