import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSchedulePayloadAliases } from '../../../shared/schedulePayloadAliases.mjs';

test('mirrors installDate into dueDate for job mutations without mutating the original payload', () => {
  const payload = {
    jobNumber: '19299',
    installDate: '2026-04-20'
  };

  const normalized = normalizeSchedulePayloadAliases('/jobs/update', payload);

  assert.deepEqual(normalized, {
    jobNumber: '19299',
    installDate: '2026-04-20',
    dueDate: '2026-04-20'
  });
  assert.deepEqual(payload, {
    jobNumber: '19299',
    installDate: '2026-04-20'
  });
});

test('mirrors dueDate into installDate for job mutations', () => {
  assert.deepEqual(
    normalizeSchedulePayloadAliases('/jobs/create', {
      jobNumber: '19299',
      dueDate: '2026-04-20'
    }),
    {
      jobNumber: '19299',
      installDate: '2026-04-20',
      dueDate: '2026-04-20'
    }
  );
});

test('mirrors installDate into jobDate for allocation mutations', () => {
  assert.deepEqual(
    normalizeSchedulePayloadAliases('/allocations/apply', {
      jobNumber: '19299',
      installDate: '2026-04-20'
    }),
    {
      jobNumber: '19299',
      installDate: '2026-04-20',
      jobDate: '2026-04-20'
    }
  );
});

test('mirrors jobDate into installDate for allocation mutations', () => {
  assert.deepEqual(
    normalizeSchedulePayloadAliases('/allocations/add', {
      jobNumber: '19299',
      jobDate: '2026-04-20'
    }),
    {
      jobNumber: '19299',
      installDate: '2026-04-20',
      jobDate: '2026-04-20'
    }
  );
});
