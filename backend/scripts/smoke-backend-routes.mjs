// Purpose: Lightweight backend contract smoke checks for route wiring and response envelopes.
import '../load-env.mjs';
import { handleSupabaseRequest } from '../supabase-backend.mjs';

function buildRequestUrl(path, query = {}) {
  const url = new URL('http://localhost/api');
  url.searchParams.set('path', path);
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (entry === undefined || entry === null || entry === '') {
          return;
        }
        url.searchParams.append(key, String(entry));
      });
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

  if (path === '/health') {
    const data = response.payload.data;
    if (!data || typeof data !== 'object') {
      throw new Error('/health: payload.data must be an object');
    }
    if (typeof data.apiBuildSha !== 'string') {
      throw new Error('/health: data.apiBuildSha must be a string');
    }
    if (typeof data.apiBuiltAt !== 'string') {
      throw new Error('/health: data.apiBuiltAt must be a string');
    }
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

  return response;
}

async function main() {
  const token = String(process.env.SMOKE_AUTH_TOKEN || '').trim();
  const includeMutations = String(process.env.SMOKE_INCLUDE_MUTATIONS || '').trim().toLowerCase() === 'true';
  const transferBoxId = String(process.env.SMOKE_TRANSFER_BOX_ID || '').trim().toUpperCase();
  const transferDestinationWarehouse = String(process.env.SMOKE_TRANSFER_DEST_WAREHOUSE || '')
    .trim()
    .toUpperCase();

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
    {
      method: 'GET',
      path: '/boxes/search',
      query: { warehouses: ['IL1', 'MS1'] },
      expectedStatuses: [200],
      requiresAuth: true
    },
    {
      method: 'GET',
      path: '/boxes/search',
      query: { warehouse: 'ALL' },
      expectedStatuses: [200],
      requiresAuth: true
    },
    { method: 'GET', path: '/app/attention-summary', expectedStatuses: [200], requiresAuth: true },
    { method: 'GET', path: '/jobs/list', expectedStatuses: [200], requiresAuth: true },
    {
      method: 'GET',
      path: '/jobs/list',
      query: { limit: 0, jobNumbers: ['000123', '000124'] },
      expectedStatuses: [200],
      requiresAuth: true
    },
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
      method: 'GET',
      path: '/allocations/preview',
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

    const response = await runCase(testCase, token);
    passed += 1;
    // eslint-disable-next-line no-console
    console.log(`PASS ${testCase.method} ${testCase.path} -> ${response.statusCode}`);
  }

  if (includeMutations) {
    if (token && transferBoxId && transferDestinationWarehouse) {
      const transferNote = `Smoke transfer ${new Date().toISOString()}`;
      const startTransferResponse = await runCase(
        {
          method: 'POST',
          path: '/boxes/transfer/start',
          body: {
            boxId: transferBoxId,
            toWarehouse: transferDestinationWarehouse,
            notes: transferNote
          },
          expectedStatuses: [200]
        },
        token
      );
      passed += 1;
      // eslint-disable-next-line no-console
      console.log(`PASS POST /boxes/transfer/start -> ${startTransferResponse.statusCode}`);

      const transferId = String(startTransferResponse.payload?.data?.transfer?.transferId || '').trim().toUpperCase();
      if (!transferId) {
        throw new Error('/boxes/transfer/start: expected transferId in payload.data.transfer.transferId');
      }

      const transferLookupResponse = await runCase(
        {
          method: 'GET',
          path: '/boxes/transfer/by-box',
          query: { boxId: transferBoxId },
          expectedStatuses: [200]
        },
        token
      );
      passed += 1;
      const pendingTransferId = String(transferLookupResponse.payload?.data?.transferId || '').trim().toUpperCase();
      if (pendingTransferId !== transferId) {
        throw new Error(
          `/boxes/transfer/by-box: expected transferId ${transferId}, received ${pendingTransferId || '<empty>'}`
        );
      }
      // eslint-disable-next-line no-console
      console.log(`PASS GET /boxes/transfer/by-box -> ${transferLookupResponse.statusCode}`);

      const cancelTransferResponse = await runCase(
        {
          method: 'POST',
          path: '/boxes/transfer/cancel',
          body: { transferId },
          expectedStatuses: [200]
        },
        token
      );
      passed += 1;
      // eslint-disable-next-line no-console
      console.log(`PASS POST /boxes/transfer/cancel -> ${cancelTransferResponse.statusCode}`);
    } else {
      skipped += 1;
      // eslint-disable-next-line no-console
      console.log(
        'SKIP transfer mutation smoke (set SMOKE_AUTH_TOKEN, SMOKE_TRANSFER_BOX_ID, and SMOKE_TRANSFER_DEST_WAREHOUSE)'
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(`Smoke checks complete. passed=${passed} skipped=${skipped}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Smoke checks failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
