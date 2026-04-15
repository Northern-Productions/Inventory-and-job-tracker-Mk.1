import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldUseLocalFallbackRoute } from '../../src/routes/localFallbackRoutes.mjs';

test('uses local fallback for localhost job and film-order write paths that must preserve write labels', () => {
  assert.equal(shouldUseLocalFallbackRoute('POST', '/jobs/create'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/jobs/update'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/jobs/set-staged-pickup'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/jobs/checkout-all'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/film-orders/create'), true);
});

test('keeps unrelated mutation routes on their previous execution path', () => {
  assert.equal(shouldUseLocalFallbackRoute('POST', '/jobs/reopen'), false);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/boxes/set-status'), false);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/film-orders/list'), false);
});
