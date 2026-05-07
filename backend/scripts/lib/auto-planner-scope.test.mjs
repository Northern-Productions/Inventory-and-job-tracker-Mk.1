import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildAutoPlannerScope,
  getJobNumberForPlannerDetailReload,
  normalizePlannerWarnings,
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

  assert.match(source, /materialType:\s*payload\.materialType/);
  assert.match(source, /material_type:\s*payload\.material_type/);
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

test('normalizePlannerWarnings keeps only meaningful warning text', () => {
  assert.deepEqual(normalizePlannerWarnings({ warnings: ['one', '', null, ' two '] }), ['one', 'two']);
});
