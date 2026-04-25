import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStaleAutoShortageFilmOrderCleanupCandidates } from '../../src/app/services/runtime/runtimeAllocationCleanup.mjs';

function buildRequirement(overrides = {}) {
  return {
    id: 'req-1',
    jobNumber: '019285',
    manufacturer: 'Security',
    filmName: 'Madico 12 MIL Frost Matte',
    widthIn: 60,
    requiredFeet: 25,
    ...overrides,
  };
}

function buildFilmOrder(overrides = {}) {
  return {
    filmOrderId: 'FO-1',
    jobNumber: '019285',
    manufacturer: 'Security',
    filmName: 'Madico 12 MIL Frost Matte',
    widthIn: 60,
    status: 'FILM_ORDER',
    sourceBoxId: 'IL1-6001',
    ...overrides,
  };
}

function collectCandidateIds(options) {
  return buildStaleAutoShortageFilmOrderCleanupCandidates(options).map((entry) => entry.filmOrderId);
}

test('preserves orphan auto shortage film orders after the requirement is fully covered', () => {
  const requirement = buildRequirement();
  const filmOrders = [buildFilmOrder()];

  assert.deepEqual(
    collectCandidateIds({
      jobNumber: '019285',
      requirement,
      remainingRequirementFeet: 0,
      filmOrders,
      filmOrderLinksById: { 'FO-1': [] },
      filmOrderAllocationsById: { 'FO-1': [] },
    }),
    [],
  );
});

test('preserves manual film orders even when the requirement is fulfilled', () => {
  const requirement = buildRequirement();
  const filmOrders = [buildFilmOrder({ sourceBoxId: '' })];

  assert.deepEqual(
    collectCandidateIds({
      jobNumber: '019285',
      requirement,
      remainingRequirementFeet: 0,
      filmOrders,
      filmOrderLinksById: { 'FO-1': [] },
      filmOrderAllocationsById: { 'FO-1': [] },
    }),
    [],
  );
});

test('preserves auto shortage film orders that already have linked boxes', () => {
  const requirement = buildRequirement();
  const filmOrders = [buildFilmOrder()];

  assert.deepEqual(
    collectCandidateIds({
      jobNumber: '019285',
      requirement,
      remainingRequirementFeet: 0,
      filmOrders,
      filmOrderLinksById: { 'FO-1': [{ boxId: 'IL1-6999' }] },
      filmOrderAllocationsById: { 'FO-1': [] },
    }),
    [],
  );
});

test('preserves auto shortage film orders that already have film-order allocations', () => {
  const requirement = buildRequirement();
  const filmOrders = [buildFilmOrder()];

  assert.deepEqual(
    collectCandidateIds({
      jobNumber: '019285',
      requirement,
      remainingRequirementFeet: 0,
      filmOrders,
      filmOrderLinksById: { 'FO-1': [] },
      filmOrderAllocationsById: { 'FO-1': [{ allocationId: 'alloc-1' }] },
    }),
    [],
  );
});

test('preserves shortage film orders when the requirement still has remaining feet', () => {
  const requirement = buildRequirement();
  const filmOrders = [buildFilmOrder()];

  assert.deepEqual(
    collectCandidateIds({
      jobNumber: '019285',
      requirement,
      remainingRequirementFeet: 5,
      filmOrders,
      filmOrderLinksById: { 'FO-1': [] },
      filmOrderAllocationsById: { 'FO-1': [] },
    }),
    [],
  );
});

test('preserves every orphan auto shortage order that matches the fulfilled merged requirement', () => {
  const requirement = buildRequirement();
  const filmOrders = [
    buildFilmOrder({ filmOrderId: 'FO-1' }),
    buildFilmOrder({ filmOrderId: 'FO-2' }),
    buildFilmOrder({ filmOrderId: 'FO-3', widthIn: 72 }),
  ];

  assert.deepEqual(
    collectCandidateIds({
      jobNumber: '019285',
      requirement,
      remainingRequirementFeet: 0,
      filmOrders,
      filmOrderLinksById: { 'FO-1': [], 'FO-2': [], 'FO-3': [] },
      filmOrderAllocationsById: { 'FO-1': [], 'FO-2': [], 'FO-3': [] },
    }),
    [],
  );
});
