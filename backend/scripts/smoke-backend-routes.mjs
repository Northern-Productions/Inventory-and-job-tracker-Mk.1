// Purpose: Lightweight backend contract smoke checks for route wiring and response envelopes.
import { handleSupabaseRequest } from '../supabase-backend.mjs';

function buildRequestUrl(path, query = {}) {
  const url = new URL('http://localhost/api');
  url.searchParams.set('path', path);
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return url;
}

function assertEnvelope(path, response) {
  if (!response || typeof response !== 'object') {
    throw new Error(`${path}: missing response object`);
  }
  if (!Number.isInteger(response.statusCode)) {
    throw new Error(`${path}: missing numeric statusCode`);
  }
  if (!response.payload || typeof response.payload !== 'object') {
    throw new Error(`${path}: missing payload object`);
  }
  if (typeof response.payload.ok !== 'boolean') {
    throw new Error(`${path}: payload.ok must be boolean`);
  }
  if (!Array.isArray(response.payload.warnings)) {
    throw new Error(`${path}: payload.warnings must be an array`);
  }
}

async function runCase(testCase, token) {
  const { method, path, query, body, expectedStatuses } = testCase;
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await handleSupabaseRequest({
    method,
    logicalPath: path,
    requestUrl: buildRequestUrl(path, query),
    bodyJson: method === 'POST' ? body ?? {} : null,
    headers
  });

  assertEnvelope(path, response);
  if (!expectedStatuses.includes(response.statusCode)) {
    throw new Error(
      `${method} ${path}: expected status in [${expectedStatuses.join(', ')}], got ${response.statusCode}`
    );
  }

  return response.statusCode;
}

async function main() {
  const token = String(process.env.SMOKE_AUTH_TOKEN || '').trim();
  const includeMutations = String(process.env.SMOKE_INCLUDE_MUTATIONS || '').trim().toLowerCase() === 'true';

  const cases = [
    { method: 'GET', path: '/health', expectedStatuses: [200], requiresAuth: false },
    { method: 'GET', path: '/auth/context', expectedStatuses: token ? [200] : [401], requiresAuth: false },
    {
      method: 'GET',
      path: '/boxes/search',
      query: { warehouse: 'IL1' },
      expectedStatuses: [200],
      requiresAuth: true
    },
    { method: 'GET', path: '/jobs/list', expectedStatuses: [200], requiresAuth: true },
    { method: 'GET', path: '/jobs/search', query: { query: '4524', limit: 5 }, expectedStatuses: [200], requiresAuth: true },
    { method: 'GET', path: '/film-orders/list', expectedStatuses: [200], requiresAuth: true },
    { method: 'GET', path: '/film-data/catalog', expectedStatuses: [200], requiresAuth: true },
    { method: 'GET', path: '/reports/summary', expectedStatuses: [200], requiresAuth: true },
    { method: 'GET', path: '/allocations/jobs', expectedStatuses: [200], requiresAuth: true },
    {
      method: 'GET',
      path: '/allocations/by-job',
      query: { jobNumber: '99999999' },
      expectedStatuses: [200, 404],
      requiresAuth: true
    },
    { method: 'GET', path: '/audit/list', expectedStatuses: [200], requiresAuth: true },
    {
      method: 'GET',
      path: '/audit/by-box',
      query: { boxId: 'IL1-999999' },
      expectedStatuses: [200],
      requiresAuth: true
    },
    {
      method: 'GET',
      path: '/roll-history/by-box',
      query: { boxId: 'IL1-999999' },
      expectedStatuses: [200],
      requiresAuth: true
    },
    { method: 'GET', path: '/admin/access/requests', expectedStatuses: [200, 403], requiresAuth: true },
    { method: 'GET', path: '/admin/username-requests', expectedStatuses: [200, 403], requiresAuth: true },
    { method: 'GET', path: '/admin/member-permissions', expectedStatuses: [200, 403], requiresAuth: true },
    {
      method: 'GET',
      path: '/admin/user-permissions',
      query: { userId: '00000000-0000-0000-0000-000000000000' },
      expectedStatuses: [200, 400, 403, 404],
      requiresAuth: true
    },
    { method: 'GET', path: '/owner/admin-permissions', expectedStatuses: [200, 403], requiresAuth: true },
    { method: 'GET', path: '/owner/notification-preferences', expectedStatuses: [200, 403], requiresAuth: true },
    { method: 'GET', path: '/owner/reports/asset-total-cost', expectedStatuses: [200, 403], requiresAuth: true }
  ];

  const mutationCases = [
    {
      method: 'POST',
      path: '/allocations/preview',
      body: {},
      expectedStatuses: [400],
      requiresAuth: true,
      safe: true
    },
    {
      method: 'POST',
      path: '/jobs/update',
      body: {},
      expectedStatuses: [400],
      requiresAuth: true,
      safe: true
    },
    {
      method: 'POST',
      path: '/jobs/checkout-all',
      body: {},
      expectedStatuses: [400],
      requiresAuth: true,
      safe: true
    },
    {
      method: 'POST',
      path: '/film-orders/create',
      body: {},
      expectedStatuses: [400],
      requiresAuth: true,
      safe: true
    }
  ];

  if (includeMutations) {
    cases.push(...mutationCases);
  }

  let passed = 0;
  let skipped = 0;

  for (const testCase of cases) {
    if (testCase.requiresAuth && !token) {
      skipped += 1;
      // eslint-disable-next-line no-console
      console.log(`SKIP ${testCase.method} ${testCase.path} (set SMOKE_AUTH_TOKEN to include auth checks)`);
      continue;
    }

    const status = await runCase(testCase, token);
    passed += 1;
    // eslint-disable-next-line no-console
    console.log(`PASS ${testCase.method} ${testCase.path} -> ${status}`);
  }

  // eslint-disable-next-line no-console
  console.log(`Smoke checks complete. passed=${passed} skipped=${skipped}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Smoke checks failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
