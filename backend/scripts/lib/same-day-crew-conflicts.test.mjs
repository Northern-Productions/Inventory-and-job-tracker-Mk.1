import test from 'node:test';
import assert from 'node:assert/strict';

import { getCheckoutCrewConflictJobs } from '../../src/app/services/runtime/runtimeAllocationLinks.mjs';
import {
  getSameDayCrewConflictJobs,
  hasSameDayCrewConflict,
} from '../../../shared/domain/sameDayCrewConflicts.mjs';

function buildTargetJobContext(overrides = {}) {
  return {
    jobNumber: '4690',
    installDate: '2026-04-24',
    crewLeader: 'Napo',
    ...overrides,
  };
}

function buildAllocation(overrides = {}) {
  return {
    allocationId: 'alloc-1',
    boxId: 'IL1-6923',
    jobNumber: '4449',
    installDate: '2026-04-24',
    crewLeader: 'Another Crew',
    status: 'ACTIVE',
    resolvedAt: '',
    ...overrides,
  };
}

test('getCheckoutCrewConflictJobs blocks active allocations on the same install date for a different crew', () => {
  const conflicts = getCheckoutCrewConflictJobs(buildTargetJobContext(), [
    buildAllocation({ jobNumber: '4449' }),
    buildAllocation({ jobNumber: '4447', crewLeader: 'Install Team B' }),
  ]);

  assert.deepEqual(conflicts, ['4449', '4447']);
});

test('getCheckoutCrewConflictJobs allows same-day allocations for the same crew leader', () => {
  const conflicts = getCheckoutCrewConflictJobs(buildTargetJobContext(), [
    buildAllocation({ jobNumber: '4449', crewLeader: 'Napo' }),
  ]);

  assert.deepEqual(conflicts, []);
});

test('getCheckoutCrewConflictJobs allows different install dates and placeholder allocations', () => {
  const conflicts = getCheckoutCrewConflictJobs(buildTargetJobContext(), [
    buildAllocation({ jobNumber: '4449', installDate: '' }),
    buildAllocation({ jobNumber: '4447', installDate: '2026-04-25' }),
  ]);

  assert.deepEqual(conflicts, []);
});

test('getCheckoutCrewConflictJobs ignores cancelled and resolved allocations', () => {
  const conflicts = getCheckoutCrewConflictJobs(buildTargetJobContext(), [
    buildAllocation({ jobNumber: '4449', status: 'CANCELLED' }),
    buildAllocation({ jobNumber: '4447', resolvedAt: '2026-04-16T18:00:00Z' }),
  ]);

  assert.deepEqual(conflicts, []);
});

test('same-day conflict helpers respect the active box filter used by job summaries', () => {
  const targetJobContext = buildTargetJobContext();
  const allocations = [
    buildAllocation({ jobNumber: '4449', boxId: 'IL1-6923' }),
    buildAllocation({ jobNumber: '4450', boxId: 'IL1-6482' }),
  ];

  assert.deepEqual(getSameDayCrewConflictJobs(targetJobContext, allocations, { boxIds: ['IL1-6482'] }), ['4450']);
  assert.equal(
    hasSameDayCrewConflict(targetJobContext, allocations, { boxIds: { 'IL1-6923': true } }),
    true
  );
  assert.equal(
    hasSameDayCrewConflict(targetJobContext, allocations, { boxIds: { 'IL1-9999': true } }),
    false
  );
});
