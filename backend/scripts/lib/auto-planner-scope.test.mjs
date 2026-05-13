import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildAutoPlannerScope,
  getJobIdentityForPlannerDetailReload,
  getJobNumberForPlannerDetailReload,
  normalizePlannerWarnings,
  normalizeScope,
} from '../../src/app/services/runtime/runtimeAutoAllocationPlanner.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const runtimeJobsMutationsPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeJobsMutations.mjs'
);

test('buildAutoPlannerScope narrows job edits to the changed job', () => {
  assert.deepEqual(
    buildAutoPlannerScope('/jobs/update', { jobNumber: '18722' }, { jobNumber: '18722' }),
    { jobNumbers: ['18722'] }
  );
});

test('buildAutoPlannerScope preserves canonical jobId shadow metadata for job edits', () => {
  assert.deepEqual(
    buildAutoPlannerScope(
      '/jobs/update',
      { jobId: '11111111-1111-4111-8111-111111111111', jobNumber: '18722' },
      { jobNumber: '18722' }
    ),
    {
      jobNumbers: ['18722'],
      jobIds: ['11111111-1111-4111-8111-111111111111'],
    }
  );
});

test('buildAutoPlannerScope preserves canonical jobId shadow metadata for reopen', () => {
  assert.deepEqual(
    buildAutoPlannerScope(
      '/jobs/reopen',
      { jobId: '22222222-2222-4222-8222-222222222222', jobNumber: '18722' },
      { summary: { jobNumber: '18722' } }
    ),
    {
      jobNumbers: ['18722'],
      jobIds: ['22222222-2222-4222-8222-222222222222'],
    }
  );
});

test('buildAutoPlannerScope uses box scopes for inventory mutations', () => {
  assert.deepEqual(
    buildAutoPlannerScope('/boxes/set-status', { boxId: 'IL1-100' }, { box: { boxId: 'IL1-100' } }),
    { boxIds: ['IL1-100'] }
  );
});

test('buildAutoPlannerScope expands manual allocation responses to job and box scopes', () => {
  assert.deepEqual(
    buildAutoPlannerScope(
      '/allocations/apply',
      { jobNumber: '18722', boxId: 'IL1-100' },
      { allocations: [{ jobNumber: '18722', boxId: 'IL1-200' }] }
    ),
    { jobNumbers: ['18722'], boxIds: ['IL1-100', 'IL1-200'] }
  );
});

test('buildAutoPlannerScope captures caulk product warehouse pairs', () => {
  assert.deepEqual(
    buildAutoPlannerScope('/caulk/mutate', { productId: 'product-1', warehouse: 'il1' }, {}),
    { caulkProductWarehousePairs: [{ productId: 'product-1', warehouse: 'IL1' }] }
  );
});

test('buildAutoPlannerScope uses org-wide planning for lifecycle cleanup', () => {
  assert.deepEqual(buildAutoPlannerScope('/jobs/complete', { jobNumber: '18722' }, {}), {});
});

test('buildAutoPlannerScope scopes film order delete to the returned job only', () => {
  assert.deepEqual(
    buildAutoPlannerScope(
      '/film-orders/delete',
      { jobNumber: 'PAYLOAD-SHOULD-NOT-BE-USED' },
      { jobNumber: '18722' }
    ),
    { jobNumbers: ['18722'] }
  );
  assert.deepEqual(
    buildAutoPlannerScope(
      '/film-orders/delete',
      { jobNumber: 'PAYLOAD-SHOULD-NOT-BE-USED' },
      { jobNumber: ' 18722 ' }
    ),
    { jobNumbers: ['18722'] }
  );
});

test('buildAutoPlannerScope preserves canonical jobId shadow metadata for film order delete', () => {
  assert.deepEqual(
    buildAutoPlannerScope(
      '/film-orders/delete',
      { jobId: '33333333-3333-4333-8333-333333333333', jobNumber: 'PAYLOAD-SHOULD-NOT-BE-USED' },
      { jobNumber: '18722' }
    ),
    {
      jobNumbers: ['18722'],
      jobIds: ['33333333-3333-4333-8333-333333333333'],
    }
  );
});

test('buildAutoPlannerScope falls back org-wide for film order delete without returned job proof', () => {
  assert.deepEqual(
    buildAutoPlannerScope('/film-orders/delete', { jobNumber: 'PAYLOAD-SHOULD-NOT-BE-USED' }, {}),
    {}
  );
  assert.deepEqual(
    buildAutoPlannerScope('/film-orders/delete', { jobNumber: 'PAYLOAD-SHOULD-NOT-BE-USED' }, { jobNumber: null }),
    {}
  );
  assert.deepEqual(
    buildAutoPlannerScope('/film-orders/delete', { jobNumber: 'PAYLOAD-SHOULD-NOT-BE-USED' }, { jobNumber: '' }),
    {}
  );
  assert.deepEqual(
    buildAutoPlannerScope('/film-orders/delete', { jobNumber: 'PAYLOAD-SHOULD-NOT-BE-USED' }, { jobNumber: ' ' }),
    {}
  );
  assert.deepEqual(
    buildAutoPlannerScope('/film-orders/delete', { jobNumber: 'PAYLOAD-SHOULD-NOT-BE-USED' }, { jobNumber: 18722 }),
    {}
  );
  assert.deepEqual(
    buildAutoPlannerScope(
      '/film-orders/delete',
      { jobId: '33333333-3333-4333-8333-333333333333', jobNumber: 'PAYLOAD-SHOULD-NOT-BE-USED' },
      {}
    ),
    {}
  );
});

test('buildAutoPlannerScope keeps legacy jobNumber-only paths without jobIds', () => {
  assert.deepEqual(
    buildAutoPlannerScope('/jobs/reopen', { jobNumber: '18722' }, { summary: { jobNumber: '18722' } }),
    { jobNumbers: ['18722'] }
  );
  assert.deepEqual(
    buildAutoPlannerScope('/film-orders/delete', { jobNumber: 'PAYLOAD-SHOULD-NOT-BE-USED' }, { jobNumber: '18722' }),
    { jobNumbers: ['18722'] }
  );
});

test('buildAutoPlannerScope keeps film order cancel org-wide', () => {
  assert.deepEqual(
    buildAutoPlannerScope('/film-orders/cancel', { jobNumber: '18722' }, { jobNumber: '18722' }),
    {}
  );
});

test('buildAutoPlannerScope ignores routes that do not affect material planning', () => {
  assert.equal(buildAutoPlannerScope('/profile/username', {}, {}), null);
});

test('buildAutoPlannerScope leaves suppression resume to its SQL mutation wrapper', () => {
  assert.equal(
    buildAutoPlannerScope('/allocations/planner-suppression/clear', { jobNumber: '18722' }, {}),
    null
  );
});

test('buildAutoPlannerScope leaves caulk removal to its SQL mutation wrapper', () => {
  assert.equal(
    buildAutoPlannerScope(
      '/allocations/caulk/remove',
      { caulkAllocationId: 'caulk-1' },
      { jobNumber: '18722', productId: 'product-1', warehouse: 'IL1' }
    ),
    null
  );
});

test('local suppression resume forwards caulk material type to SQL owner', async () => {
  const source = await readFile(runtimeJobsMutationsPath, 'utf8');

  assert.match(
    source,
    /const materialType = normalizePlannerSuppressionMaterialType\(\s*payload\.materialType !== undefined\s*\?\s*payload\.materialType\s*:\s*payload\.material_type\s*\);/s
  );
  assert.match(source, /JSON\.stringify\(\{\s*jobNumber,\s*requirementId,\s*materialType,\s*reason\s*\}\)/s);
});

test('getJobNumberForPlannerDetailReload reloads only job detail mutation responses', () => {
  assert.equal(
    getJobNumberForPlannerDetailReload('/jobs/create', { jobNumber: '18722' }, {}),
    '18722'
  );
  assert.equal(
    getJobNumberForPlannerDetailReload('/boxes/update', { jobNumber: '18722' }, {}),
    ''
  );
});

test('getJobIdentityForPlannerDetailReload uses explicit payload jobId only', () => {
  assert.deepEqual(
    getJobIdentityForPlannerDetailReload(
      '/jobs/update',
      { jobNumber: '18722' },
      { summary: { jobId: '11111111-1111-4111-8111-111111111111', jobNumber: '18722' } }
    ),
    { jobId: '', jobNumber: '18722' }
  );
  assert.deepEqual(
    getJobIdentityForPlannerDetailReload(
      '/jobs/reopen',
      { jobId: '11111111-1111-4111-8111-111111111111', jobNumber: '18722' },
      { summary: { jobId: '11111111-1111-4111-8111-111111111111', jobNumber: '18722' } }
    ),
    { jobId: '11111111-1111-4111-8111-111111111111', jobNumber: '18722' }
  );
});

test('normalizeScope preserves and dedupes valid jobIds as shadow metadata', () => {
  assert.deepEqual(
    normalizeScope({
      jobNumbers: ['18722', ' 18722 ', '18888'],
      jobIds: [
        '11111111-1111-4111-8111-111111111111',
        ' 11111111-1111-4111-8111-111111111111 ',
        '22222222-2222-4222-8222-222222222222',
        '',
        'not-a-job-id',
        null,
      ],
      boxIds: ['IL1-100', ' IL1-100 ', 'IL1-200'],
      caulkProductWarehousePairs: [
        { productId: 'product-1', warehouse: 'il1' },
        { productId: 'product-1', warehouse: 'IL1' },
        { productId: '', warehouse: 'IL1' },
      ],
    }),
    {
      jobNumbers: ['18722', '18888'],
      jobIds: [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ],
      boxIds: ['IL1-100', 'IL1-200'],
      caulkProductWarehousePairs: [{ productId: 'product-1', warehouse: 'IL1' }],
    }
  );
});

test('normalizeScope ignores blank and invalid jobIds without affecting existing scope fields', () => {
  assert.deepEqual(
    normalizeScope({
      jobNumbers: ['18722'],
      jobIds: ['', ' ', 'not-a-job-id'],
      boxIds: ['IL1-100'],
    }),
    {
      jobNumbers: ['18722'],
      boxIds: ['IL1-100'],
    }
  );
});

test('normalizePlannerWarnings keeps only meaningful warning text', () => {
  assert.deepEqual(normalizePlannerWarnings({ warnings: ['one', '', null, ' two '] }), ['one', 'two']);
});
