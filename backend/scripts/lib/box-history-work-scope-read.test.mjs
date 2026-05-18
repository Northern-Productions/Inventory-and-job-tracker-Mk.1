import assert from 'node:assert/strict';
import test from 'node:test';

import { buildJobScopeFieldsByJobId } from '../../src/app/handlers/readHandlers.mjs';

test('buildJobScopeFieldsByJobId enriches scope by job id only', async () => {
  const calls = [];
  const scopeFieldsByJobId = await buildJobScopeFieldsByJobId(
    {},
    'org-1',
    [
      {
        jobId: '11111111-1111-4111-8111-111111111111',
        jobNumber: '4953',
      },
      {
        jobId: '',
        jobNumber: '16242',
      },
      {
        jobNumber: '7777',
      },
    ],
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
  assert.deepEqual(scopeFieldsByJobId.get('11111111-1111-4111-8111-111111111111'), {
    workScope: 'Sections 4, 5',
    sections: 'Sections 4, 5',
  });
  assert.equal(scopeFieldsByJobId.has('16242'), false);
});

test('buildJobScopeFieldsByJobId keeps legacy and unresolved rows compatible', async () => {
  const scopeFieldsByJobId = await buildJobScopeFieldsByJobId(
    {},
    'org-1',
    [
      {
        jobId: '22222222-2222-4222-8222-222222222222',
        jobNumber: '16242',
      },
      {
        jobId: null,
        jobNumber: '4953',
      },
    ],
    {
      findJobById: async () => null,
    }
  );

  assert.deepEqual(scopeFieldsByJobId.get('22222222-2222-4222-8222-222222222222'), {});
  assert.equal(scopeFieldsByJobId.has('4953'), false);
});

test('buildJobScopeFieldsByJobId deduplicates repeated job id lookups', async () => {
  let callCount = 0;
  const scopeFieldsByJobId = await buildJobScopeFieldsByJobId(
    {},
    'org-1',
    [
      {
        jobId: '33333333-3333-4333-8333-333333333333',
        jobNumber: '4803',
      },
      {
        jobId: '33333333-3333-4333-8333-333333333333',
        jobNumber: '4803',
      },
    ],
    {
      findJobById: async () => {
        callCount += 1;
        return {
          sections: 'Lobby Phase',
        };
      },
    }
  );

  assert.equal(callCount, 1);
  assert.deepEqual(scopeFieldsByJobId.get('33333333-3333-4333-8333-333333333333'), {
    workScope: 'Lobby Phase',
    sections: 'Lobby Phase',
  });
});
