import test from 'node:test';
import assert from 'node:assert/strict';

import { computeJobStatusFromRequirements } from '../../src/app/services/runtime/runtimeJobSummaries.mjs';

function buildRequirement(overrides = {}) {
  return {
    requirementId: '11111111-1111-4111-8111-111111111111',
    manufacturer: '3M',
    filmName: 'Prestige 40',
    widthIn: 60,
    requiredFeet: 50,
    ...overrides,
  };
}

function buildFilmOrder(overrides = {}) {
  return {
    filmOrderId: 'fo-1',
    requirementId: '11111111-1111-4111-8111-111111111111',
    jobNumber: '9001',
    manufacturer: '3M',
    filmName: 'Prestige 40',
    widthIn: 60,
    requestedFeet: 50,
    orderedFeet: 50,
    status: 'FILM_ON_THE_WAY',
    ...overrides,
  };
}

test('job status derives ORDERED when missing film is fully on the way', () => {
  const status = computeJobStatusFromRequirements(
    'ACTIVE',
    false,
    false,
    [buildRequirement()],
    [],
    [],
    [buildFilmOrder()],
    { jobNumber: '9001' }
  );

  assert.equal(status, 'ORDERED');
});

test('job status remains FILM_ORDER when on-the-way film does not cover the shortage', () => {
  const status = computeJobStatusFromRequirements(
    'ACTIVE',
    false,
    false,
    [buildRequirement()],
    [],
    [],
    [buildFilmOrder({ orderedFeet: 25, requestedFeet: 25 })],
    { jobNumber: '9001' }
  );

  assert.equal(status, 'FILM_ORDER');
});

test('job status uses orderedFeet before requestedFeet for on-the-way coverage', () => {
  const status = computeJobStatusFromRequirements(
    'ACTIVE',
    false,
    false,
    [buildRequirement()],
    [],
    [],
    [buildFilmOrder({ orderedFeet: 25, requestedFeet: 50 })],
    { jobNumber: '9001' }
  );

  assert.equal(status, 'FILM_ORDER');
});

test('job status does not match unbound on-the-way film orders to bound requirements', () => {
  const status = computeJobStatusFromRequirements(
    'ACTIVE',
    false,
    false,
    [buildRequirement()],
    [],
    [],
    [buildFilmOrder({ requirementId: '', orderedFeet: 50, requestedFeet: 50 })],
    { jobNumber: '9001' }
  );

  assert.equal(status, 'FILM_ORDER');
});

test('job status does not treat editable FILM_ORDER rows as ORDERED', () => {
  const status = computeJobStatusFromRequirements(
    'ACTIVE',
    false,
    false,
    [buildRequirement()],
    [],
    [],
    [buildFilmOrder({ status: 'FILM_ORDER', orderedFeet: 0 })],
    { jobNumber: '9001' }
  );

  assert.equal(status, 'FILM_ORDER');
});
