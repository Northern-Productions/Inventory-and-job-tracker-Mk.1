import { shouldUseLocalFallbackRoute } from '../src/routes/localFallbackRoutes.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const REQUIRED_READ_PATHS = [
  '/boxes/search',
  '/boxes/get',
  '/allocations/by-box',
  '/allocations/preview',
  '/allocations/by-job',
  '/allocations/jobs',
  '/jobs/get',
  '/jobs/list',
  '/jobs/search'
];

const REQUIRED_MUTATION_PATHS = [
  '/boxes/add',
  '/boxes/update',
  '/allocations/apply',
  '/allocations/remove-box',
  '/jobs/set-staged-pickup',
  '/jobs/checkout-all',
  '/jobs/complete',
  '/jobs/delete',
  '/film-orders/cancel',
  '/film-orders/delete'
];

for (const path of REQUIRED_READ_PATHS) {
  assert(shouldUseLocalFallbackRoute('GET', path), `Expected GET ${path} to use local fallback.`);
}

for (const path of REQUIRED_MUTATION_PATHS) {
  assert(shouldUseLocalFallbackRoute('POST', path), `Expected POST ${path} to use local fallback.`);
}

console.log('Ordered box local fallback routes OK.');
