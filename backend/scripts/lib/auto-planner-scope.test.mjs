import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildAutoPlannerScope,
  getJobNumberForPlannerDetailReload,
  normalizePlannerWarnings,
} from '../../src/app/services/runtime/runtimeAutoAllocationPlanner.mjs';

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

test('buildAutoPlannerScope ignores routes that do not affect material planning', () => {
  assert.equal(buildAutoPlannerScope('/profile/username', {}, {}), null);
});

test('buildAutoPlannerScope leaves suppression resume to its SQL mutation wrapper', () => {
  assert.equal(
    buildAutoPlannerScope('/allocations/planner-suppression/clear', { jobNumber: '18722' }, {}),
    null
  );
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
