import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCAL_FALLBACK_MUTATION_PATHS,
  LOCAL_FALLBACK_READ_PATHS,
  shouldUseLocalFallbackRoute,
} from '../../src/routes/localFallbackRoutes.mjs';
import { extractRoutesFromHandlerSource } from './runtime-contract-parity.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDir, '..', '..');

function readHandlerRoutes(relativePath) {
  return extractRoutesFromHandlerSource(
    fs.readFileSync(path.join(backendRoot, relativePath), 'utf8')
  );
}

function missingRoutes(selectedRoutes, implementedRoutes, exceptions = new Set()) {
  return [...selectedRoutes]
    .filter((route) => !implementedRoutes.has(route) && !exceptions.has(route))
    .sort();
}

test('uses local fallback for localhost inventory, job, film-order, and caulk write paths used by the safe test environment', () => {
  assert.equal(shouldUseLocalFallbackRoute('POST', '/profile/default-warehouse'), true);
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
  assert.equal(shouldUseLocalFallbackRoute('POST', '/film-orders/manual-fulfill'), true);
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
  assert.equal(shouldUseLocalFallbackRoute('GET', '/film-orders/get'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/film-data/catalog'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/reports/summary'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/jobs/check-duplicate'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/jobs/get-by-id'), true);
  assert.equal(shouldUseLocalFallbackRoute('GET', '/roll-history/by-box'), true);
});

test('keeps unrelated auth and profile routes on their previous execution path', () => {
  assert.equal(shouldUseLocalFallbackRoute('GET', '/auth/context'), true);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/profile/username'), false);
});

test('does not select the stale admin feature permissions route for local fallback', () => {
  assert.equal(shouldUseLocalFallbackRoute('GET', '/admin/feature-permissions'), false);
  assert.equal(shouldUseLocalFallbackRoute('POST', '/admin/feature-permissions'), false);
});

test('keeps local fallback selectors backed by method-matching local handlers', () => {
  const readHandlers = readHandlerRoutes('src/app/handlers/readHandlers.mjs');
  const mutationHandlers = readHandlerRoutes('src/app/handlers/mutationHandlers.mjs');

  // Auth reads are handled directly before the read-handler dispatcher.
  const readRouteExceptions = new Set(['/auth/context', '/auth/organizations']);

  assert.deepEqual(
    missingRoutes(LOCAL_FALLBACK_READ_PATHS, readHandlers, readRouteExceptions),
    []
  );
  assert.deepEqual(missingRoutes(LOCAL_FALLBACK_MUTATION_PATHS, mutationHandlers), []);
});
