import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  READ_PATHS,
  ROUTE_FEATURE_MAP,
  inferFeatureForRoute,
  isReadRoute,
} from '../../../shared/domain/runtimeContract.mjs';
import {
  collectRuntimeContractParity,
  extractRoutesFromFrontendClient,
} from './runtime-contract-parity.mjs';

test('runtime contract covers safe next BoxID suggestion as an inventory read route', () => {
  assert.equal(ROUTE_FEATURE_MAP['/boxes/suggest-next-id'], 'inventory');
  assert.equal(inferFeatureForRoute('/boxes/suggest-next-id'), 'inventory');
  assert.equal(READ_PATHS.includes('/boxes/suggest-next-id'), true);
  assert.equal(isReadRoute('/boxes/suggest-next-id'), true);
});

test('frontend route extractor detects requestReadWithFallback first-argument routes', () => {
  const routes = extractRoutesFromFrontendClient(`
    await requestReadWithFallback<SuggestedBoxIdResponse>(
      '/boxes/suggest-next-id',
      { warehouse },
      { warehouse }
    );
    await requestReadWithFallback('/boxes/search', {}, {});
  `);

  assert.deepEqual([...routes].sort(), ['/boxes/search', '/boxes/suggest-next-id']);
});

test('runtime parity guard includes frontend, local backend, and Edge route registrations', () => {
  const parity = collectRuntimeContractParity();

  assert.equal(parity.clientRoutes.includes('/boxes/suggest-next-id'), true);
  assert.equal(parity.backendRoutes.includes('/boxes/suggest-next-id'), true);
  assert.equal(parity.edgeRoutes.includes('/boxes/suggest-next-id'), true);
  assert.deepEqual(parity.clientNotInContract, []);
  assert.deepEqual(parity.backendNotInContract, []);
  assert.deepEqual(parity.edgeNotInContract, []);
  assert.deepEqual(parity.backendMissingInEdge, []);
  assert.deepEqual(parity.edgeMissingInBackend, []);
  assert.deepEqual(parity.mismatches, []);
});
