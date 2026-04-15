import test from 'node:test';
import assert from 'node:assert/strict';

import {
  enrichOpenFilmOrdersWithJobSchedule,
  isFilmOrderNeedingAttention,
} from '../../src/app/services/runtime/runtimeFilmOrderSchedule.mjs';

test('treats scheduled FILM_ORDER entries with remaining feet as needing attention', () => {
  assert.equal(
    isFilmOrderNeedingAttention({
      status: 'FILM_ORDER',
      remainingToOrderFeet: 24,
      installDate: '2026-04-13',
    }),
    true,
  );
});

test('does not treat unscheduled FILM_ORDER entries as needing attention', () => {
  assert.equal(
    isFilmOrderNeedingAttention({
      status: 'FILM_ORDER',
      remainingToOrderFeet: 24,
    }),
    false,
  );
});

test('does not treat FILM_ORDER entries with no remaining feet as needing attention', () => {
  assert.equal(
    isFilmOrderNeedingAttention({
      status: 'FILM_ORDER',
      remainingToOrderFeet: 0,
      installDate: '2026-04-13',
    }),
    false,
  );
});

test('ignores FILM_ON_THE_WAY and resolved statuses', () => {
  assert.equal(
    isFilmOrderNeedingAttention({
      status: 'FILM_ON_THE_WAY',
      remainingToOrderFeet: 0,
      installDate: '2026-04-13',
    }),
    false,
  );
  assert.equal(
    isFilmOrderNeedingAttention({
      status: 'FULFILLED',
      remainingToOrderFeet: 0,
      installDate: '2026-04-13',
    }),
    false,
  );
});

test('serializes schedule lookups on a shared client while enriching missing schedule fields', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const lookedUpJobNumbers = [];
  const fakeClient = {
    async query(_text, params = []) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const jobNumber = String(params[1] || '').trim();
      lookedUpJobNumbers.push(jobNumber);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        rows: [
          {
            id: `job-${jobNumber}`,
            org_id: 'org-1',
            job_number: jobNumber,
            warehouse: 'IL1',
            sections: '',
            due_date: '2026-04-22',
            crew_leader: `Crew ${jobNumber}`,
            lifecycle_status: 'ACTIVE',
            is_labor_only: false,
            is_staged_for_pickup: false,
            notes: '',
            created_at: '2026-04-10T00:00:00Z',
            created_by: 'tester',
            updated_at: '2026-04-10T00:00:00Z',
            updated_by: 'tester',
          },
        ],
      };
    },
  };

  const entries = await enrichOpenFilmOrdersWithJobSchedule(fakeClient, 'org-1', [
    {
      filmOrderId: 'fo-1',
      jobNumber: '1001',
      status: 'FILM_ORDER',
      installDate: '',
      crewLeader: '',
    },
    {
      filmOrderId: 'fo-2',
      jobNumber: '1002',
      status: 'FILM_ON_THE_WAY',
      installDate: '',
      crewLeader: '',
    },
    {
      filmOrderId: 'fo-3',
      jobNumber: '1001',
      status: 'FILM_ORDER',
      installDate: '',
      crewLeader: '',
    },
    {
      filmOrderId: 'fo-4',
      jobNumber: '1003',
      status: 'FULFILLED',
      installDate: '',
      crewLeader: '',
    },
  ]);

  assert.equal(maxInFlight, 1);
  assert.deepEqual(lookedUpJobNumbers, ['1001', '1002']);
  assert.deepEqual(
    entries.map((entry) => ({
      filmOrderId: entry.filmOrderId,
      installDate: entry.installDate,
      crewLeader: entry.crewLeader,
    })),
    [
      { filmOrderId: 'fo-1', installDate: '2026-04-22', crewLeader: 'Crew 1001' },
      { filmOrderId: 'fo-2', installDate: '2026-04-22', crewLeader: 'Crew 1002' },
      { filmOrderId: 'fo-3', installDate: '2026-04-22', crewLeader: 'Crew 1001' },
      { filmOrderId: 'fo-4', installDate: '', crewLeader: '' },
    ],
  );
});
