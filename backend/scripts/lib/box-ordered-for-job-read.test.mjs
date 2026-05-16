import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOrderedForJobsForBox } from '../../src/app/handlers/readHandlers.mjs';
import { toPublicBox } from '../../src/app/repositories/mappers.mjs';

test('buildOrderedForJobsForBox returns structured ordered-for job data', async () => {
  const calls = [];
  const result = await buildOrderedForJobsForBox({}, 'org-1', 'IL1-1234', {
    listFilmOrderLinksByBoxId: async (_client, orgId, boxId) => {
      calls.push(`links:${orgId}:${boxId}`);
      return [
        { filmOrderId: 'FO-1', orderedFeet: 120 },
        { filmOrderId: 'FO-2', orderedFeet: 48 },
      ];
    },
    findFilmOrderById: async (_client, orgId, filmOrderId) => {
      calls.push(`order:${orgId}:${filmOrderId}`);
      return filmOrderId === 'FO-1'
        ? { filmOrderId, jobId: '11111111-1111-4111-8111-111111111111', jobNumber: '4953' }
        : { filmOrderId, jobId: null, jobNumber: '16242' };
    },
  });

  assert.deepEqual(calls, ['links:org-1:IL1-1234', 'order:org-1:FO-1', 'order:org-1:FO-2']);
  assert.deepEqual(result, [
    {
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '4953',
      filmOrderId: 'FO-1',
      orderedFeet: 120,
    },
    { jobNumber: '16242', filmOrderId: 'FO-2', orderedFeet: 48 },
  ]);
});

test('buildOrderedForJobsForBox skips links without structured job numbers', async () => {
  const result = await buildOrderedForJobsForBox({}, 'org-1', 'IL1-1234', {
    listFilmOrderLinksByBoxId: async () => [
      { filmOrderId: 'FO-NOTES-ONLY', orderedFeet: 100 },
      { filmOrderId: '', orderedFeet: 100 },
    ],
    findFilmOrderById: async () => ({ filmOrderId: 'FO-NOTES-ONLY', jobNumber: '' }),
  });

  assert.deepEqual(result, []);
});

test('buildOrderedForJobsForBox deduplicates repeated film-order job links', async () => {
  const result = await buildOrderedForJobsForBox({}, 'org-1', 'IL1-1234', {
    listFilmOrderLinksByBoxId: async () => [
      { filmOrderId: 'FO-1', orderedFeet: 120 },
      { filmOrderId: 'FO-1', orderedFeet: 120 },
    ],
    findFilmOrderById: async () => ({ filmOrderId: 'FO-1', jobNumber: '4953' }),
  });

  assert.deepEqual(result, [{ jobNumber: '4953', filmOrderId: 'FO-1', orderedFeet: 120 }]);
});

test('toPublicBox preserves optional ordered-for job ids additively', () => {
  const result = toPublicBox({
    boxId: 'IL1-1234',
    warehouse: 'IL1',
    manufacturer: '3M',
    filmName: 'Solar Film',
    widthIn: 60,
    initialFeet: 500,
    feetAvailable: 420,
    activeAllocatedFeet: 0,
    allocationPlanningFeet: 420,
    status: 'IN_STOCK',
    orderedForJobs: [
      {
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '4953',
        filmOrderId: 'FO-1',
        orderedFeet: '120.9',
      },
      {
        jobId: '',
        jobNumber: '16242',
        filmOrderId: 'FO-2',
        orderedFeet: 48,
      },
    ],
  });

  assert.deepEqual(result.orderedForJobs, [
    {
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '4953',
      filmOrderId: 'FO-1',
      orderedFeet: 120,
    },
    {
      jobNumber: '16242',
      filmOrderId: 'FO-2',
      orderedFeet: 48,
    },
  ]);
});
