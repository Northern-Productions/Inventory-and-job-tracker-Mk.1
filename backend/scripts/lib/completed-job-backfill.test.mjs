import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLegacyCompletedJobCandidate,
  normalizeCompletedJobBackfillCandidate
} from './completed-job-backfill.mjs';

test('marks legacy jobs as completed candidates only when safe closed signals are present', () => {
  assert.equal(
    isLegacyCompletedJobCandidate({
      activeAllocationCount: 0,
      openFilmOrderCount: 0,
      fulfilledRecordCount: 1
    }),
    true
  );

  assert.equal(
    isLegacyCompletedJobCandidate({
      activeAllocationCount: 1,
      openFilmOrderCount: 0,
      fulfilledRecordCount: 3
    }),
    false
  );

  assert.equal(
    isLegacyCompletedJobCandidate({
      activeAllocationCount: 0,
      openFilmOrderCount: 2,
      fulfilledRecordCount: 3
    }),
    false
  );

  assert.equal(
    isLegacyCompletedJobCandidate({
      activeAllocationCount: 0,
      openFilmOrderCount: 0,
      fulfilledRecordCount: 0
    }),
    false
  );
});

test('normalizes aggregate rows into reusable backfill candidates', () => {
  const candidate = normalizeCompletedJobBackfillCandidate({
    id: 'job-id-1',
    job_number: '19339',
    due_date: '2026-03-17',
    lifecycle_status: 'active',
    active_allocation_count: '0',
    open_film_order_count: 0,
    fulfilled_allocation_count: 1,
    fulfilled_film_order_count: '1'
  });

  assert.deepEqual(candidate, {
    id: 'job-id-1',
    jobNumber: '19339',
    installDate: '2026-03-17',
    lifecycleStatus: 'ACTIVE',
    activeAllocationCount: 0,
    openFilmOrderCount: 0,
    fulfilledAllocationCount: 1,
    fulfilledFilmOrderCount: 1,
    fulfilledRecordCount: 2,
    shouldBackfill: true
  });
});
