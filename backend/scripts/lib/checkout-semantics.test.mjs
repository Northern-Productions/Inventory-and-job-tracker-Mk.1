import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPublicAllocationEntriesForJob } from '../../src/app/services/runtime/runtimeJobSummaries.mjs';
import { buildFilmCheckoutActionPlan } from '../../../shared/checkoutSemantics.mjs';

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
