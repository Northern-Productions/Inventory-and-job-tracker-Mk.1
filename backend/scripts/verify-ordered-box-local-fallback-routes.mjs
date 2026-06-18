import { shouldUseLocalFallbackRoute } from '../src/routes/localFallbackRoutes.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const REQUIRED_READ_PATHS = [
  '/warehouses/list',
  '/box-dealers/list',
  '/boxes/search',
  '/boxes/get',
  '/boxes/transfer/plan',
  '/allocations/by-box',
  '/allocations/preview',
  '/allocations/by-job',
  '/allocations/jobs',
  '/jobs/get',
  '/jobs/list',
  '/jobs/search',
  '/caulk/transactions/list'
];

const REQUIRED_MUTATION_PATHS = [
  '/owner/warehouses/add',
  '/box-dealers/upsert',
  '/boxes/add',
  '/boxes/update',
  '/boxes/receive',
  '/allocations/apply',
  '/allocations/remove-box',
  '/jobs/create',
  '/jobs/update',
  '/jobs/set-staged-pickup',
  '/jobs/checkout-all',
  '/jobs/complete',
  '/jobs/delete',
  '/film-orders/create',
  '/film-orders/cancel',
  '/film-orders/delete',
  '/film-orders/manual-fulfill'
];

for (const path of REQUIRED_READ_PATHS) {
  assert(shouldUseLocalFallbackRoute('GET', path), `Expected GET ${path} to use local fallback.`);
}

for (const path of REQUIRED_MUTATION_PATHS) {
  assert(shouldUseLocalFallbackRoute('POST', path), `Expected POST ${path} to use local fallback.`);
}

console.log('Ordered box local fallback routes OK.');
