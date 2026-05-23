import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLastCheckoutScopeForBox,
  buildOrderedForJobsForBox,
} from '../../src/app/handlers/readHandlers.mjs';
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
    findJobById: async () => null,
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

test('buildOrderedForJobsForBox preserves scope from film orders and enriches by job id', async () => {
  const calls = [];
  const result = await buildOrderedForJobsForBox({}, 'org-1', 'IL1-1234', {
    listFilmOrderLinksByBoxId: async () => [
      { filmOrderId: 'FO-1', orderedFeet: 120 },
      { filmOrderId: 'FO-2', orderedFeet: 48 },
      { filmOrderId: 'FO-3', orderedFeet: 24 },
    ],
    findFilmOrderById: async (_client, _orgId, filmOrderId) => {
      calls.push(`order:${filmOrderId}`);
      if (filmOrderId === 'FO-1') {
        return {
          filmOrderId,
          jobId: '11111111-1111-4111-8111-111111111111',
          jobNumber: '4953',
          workScope: 'Sections 4, 5',
          sections: 'Sections 4, 5',
        };
      }
      if (filmOrderId === 'FO-2') {
        return {
          filmOrderId,
          jobId: '22222222-2222-4222-8222-222222222222',
          jobNumber: '16242',
        };
      }
      return { filmOrderId, jobNumber: '7777' };
    },
    findJobById: async (_client, _orgId, jobId) => {
      calls.push(`job:${jobId}`);
      return {
        id: jobId,
        jobNumber: '16242',
        workScope: 'Lobby Phase',
        sections: 'Lobby Phase',
      };
    },
  });

  assert.deepEqual(calls, [
    'order:FO-1',
    'order:FO-2',
    'job:22222222-2222-4222-8222-222222222222',
    'order:FO-3',
  ]);
  assert.deepEqual(result, [
    {
      jobId: '11111111-1111-4111-8111-111111111111',
      jobNumber: '4953',
      workScope: 'Sections 4, 5',
      sections: 'Sections 4, 5',
      filmOrderId: 'FO-1',
      orderedFeet: 120,
    },
    {
      jobId: '22222222-2222-4222-8222-222222222222',
      jobNumber: '16242',
      workScope: 'Lobby Phase',
      sections: 'Lobby Phase',
      filmOrderId: 'FO-2',
      orderedFeet: 48,
    },
    { jobNumber: '7777', filmOrderId: 'FO-3', orderedFeet: 24 },
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
        workScope: 'Sections 4, 5',
        sections: 'Sections 4, 5',
        phaseId: 'phase-1',
        phaseNumber: 1,
        filmOrderId: 'FO-1',
        orderedFeet: '120.9',
        orderedDate: '2026-05-18',
        receivedDate: '2026-05-20',
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
      workScope: 'Sections 4, 5',
      sections: 'Sections 4, 5',
      phaseId: 'phase-1',
      phaseNumber: 1,
      filmOrderId: 'FO-1',
      orderedFeet: 120,
      orderedDate: '2026-05-18',
      receivedDate: '2026-05-20',
    },
    {
      jobNumber: '16242',
      filmOrderId: 'FO-2',
      orderedFeet: 48,
    },
  ]);
});

test('toPublicBox preserves optional last checkout scope additively', () => {
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
    status: 'CHECKED_OUT',
    lastCheckoutJobId: '11111111-1111-4111-8111-111111111111',
    lastCheckoutJob: '4953',
    lastCheckoutWorkScope: 'Sections 4, 5',
    lastCheckoutSections: 'Sections 4, 5',
  });

  assert.equal(result.lastCheckoutWorkScope, 'Sections 4, 5');
  assert.equal(result.lastCheckoutSections, 'Sections 4, 5');
});

test('buildLastCheckoutScopeForBox enriches scope by last checkout job id only', async () => {
  const calls = [];
  const result = await buildLastCheckoutScopeForBox(
    {},
    'org-1',
    {
      lastCheckoutJobId: '11111111-1111-4111-8111-111111111111',
      lastCheckoutJob: '4953',
    },
    {
      findJobById: async (_client, orgId, jobId) => {
        calls.push(`job:${orgId}:${jobId}`);
        return {
          jobNumber: '4953',
          workScope: 'Sections 4, 5',
          sections: 'Sections 4, 5',
        };
      },
    }
  );

  assert.deepEqual(calls, ['job:org-1:11111111-1111-4111-8111-111111111111']);
  assert.deepEqual(result, {
    workScope: 'Sections 4, 5',
    sections: 'Sections 4, 5',
  });
});

test('buildLastCheckoutScopeForBox does not use job number fallback for scope', async () => {
  const result = await buildLastCheckoutScopeForBox(
    {},
    'org-1',
    {
      lastCheckoutJobId: '',
      lastCheckoutJob: '4953',
    },
    {
      findJobById: async () => {
        throw new Error('findJobById should not be called without a lastCheckoutJobId');
      },
    }
  );

  assert.deepEqual(result, {});
});
