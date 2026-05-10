import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldUseLocalFallbackRoute } from '../../src/routes/localFallbackRoutes.mjs';

test('uses local fallback for localhost inventory, job, film-order, and caulk write paths used by the safe test environment', () => {
  assert.equal(shouldUseLocalFallbackRoute('POST', '/owner/caulk/manufacturers/upsert'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/caulk/products/upsert'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/caulk/mutate'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/caulk/transfer'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/allocations/caulk/add'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/allocations/caulk/update'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/allocations/caulk/checkout'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/allocations/caulk/checkin'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/allocations/caulk/remove'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/allocations/planner-suppression/clear'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/boxes/delete'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/boxes/receive'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/boxes/labels/mark-printed'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/boxes/transfer/start'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/boxes/transfer/receive'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/boxes/transfer/cancel'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/jobs/create'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/jobs/update'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/jobs/set-staged-pickup'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/jobs/checkout-all'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/jobs/reopen'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/boxes/set-status'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/film-orders/create'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/audit/undo'), true);
});

test('uses local fallback for localhost film, allocation, audit, and caulk reads in the safe test environment', () => {
  assert.equal(shouldUseLocalFallbackRoute('GET', '/boxes/transfer/by-box'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/audit/list'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/audit/by-box'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/caulk/manufacturers/list'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/caulk/products/list'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/caulk/stock/list'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/film-orders/list'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/film-data/catalog'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/reports/summary'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/jobs/get-by-id'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/roll-history/by-box'), true);
});

test('keeps unrelated auth and profile routes on their previous execution path', () => {
  assert.equal(shouldUseLocalFallbackRoute('GET', '/auth/context'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/profile/username'), false);
});
