// Purpose: Lightweight backend contract smoke checks for route wiring and response envelopes.
import '../load-env.mjs';
import { handleSupabaseRequest } from '../supabase-backend.mjs';
import { queryRows, withReadClient } from '../src/db/client.mjs';
import { buildSmokeAuthSetupMessage, resolveSmokeAuthToken } from './lib/smoke-auth.mjs';

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

function extractWarehouseFromBoxId(boxId) {
  const normalized = String(boxId || '').trim().toUpperCase();
  const match = normalized.match(/^([A-Z]{2}[1-9][0-9]{0,6})-/);
  return match ? match[1] : '';
}

function buildTemporarySmokeBoxId(warehouse) {
  const uniqueToken = `${Date.now()}${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0')}`.slice(-10);
  return `${warehouse}-${uniqueToken}`;
}

function buildTodayDateString(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

async function resolveTransferSmokeSourceWarehouse(token, preferredWarehouse, destinationWarehouse) {
  const normalizedPreferred = String(preferredWarehouse || '').trim().toUpperCase();
  const normalizedDestination = String(destinationWarehouse || '').trim().toUpperCase();
  const orgId = String(process.env.DEFAULT_ORG_ID || '').trim();

  const entries = orgId
    ? await withReadClient((client) =>
        queryRows(
          client,
          `
            select
              code,
              box_id_prefix
            from app.warehouses
            where org_id = $1
            order by code
          `,
          [orgId]
        )
      )
    : [];

  const preferredEntry =
    entries.find((entry) => {
      const code = String(entry?.code || '').trim().toUpperCase();
      return code === normalizedPreferred && code && code !== normalizedDestination;
    }) ||
    entries.find((entry) => {
      const code = String(entry?.code || '').trim().toUpperCase();
      const boxIdPrefix = String(entry?.boxIdPrefix || '').trim().toUpperCase();
      return boxIdPrefix === normalizedPreferred && code && code !== normalizedDestination;
    });
  if (preferredEntry) {
    return String(preferredEntry.code || '').trim().toUpperCase();
  }

  const fallbackEntry = entries.find((entry) => {
    const code = String(entry?.code || '').trim().toUpperCase();
    return code && code !== normalizedDestination;
  });
  if (fallbackEntry) {
    return String(fallbackEntry.code || '').trim().toUpperCase();
  }

  if (normalizedPreferred && normalizedPreferred !== normalizedDestination) {
    return normalizedPreferred;
  }

  return '';
}

async function createTemporaryTransferSmokeBox(token, sourceWarehouse) {
  const today = buildTodayDateString();
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const boxId = buildTemporarySmokeBoxId(sourceWarehouse);
    try {
      const response = await runCase(
        {
          method: 'POST',
          path: '/boxes/add',
          body: {
            boxId,
            warehouse: sourceWarehouse,
            manufacturer: '3M Solar',
            filmName: 'Night Vision 25',
            widthIn: 36,
            initialFeet: 25,
            feetAvailable: 25,
            orderDate: today,
            receivedDate: today,
            notes: 'Temporary transfer smoke box.',
            auditNote: 'Temporary transfer smoke box created for backend route verification.'
          },
          expectedStatuses: [200]
        },
        token
      );

      return { boxId, response };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Unable to create a temporary transfer smoke box.');
}

async function resolveTransferSmokeContext(token, configuredBoxId, destinationWarehouse) {
  const normalizedConfiguredBoxId = String(configuredBoxId || '').trim().toUpperCase();
  const sourceWarehouse = await resolveTransferSmokeSourceWarehouse(
    token,
    extractWarehouseFromBoxId(normalizedConfiguredBoxId),
    destinationWarehouse
  );

  if (!sourceWarehouse) {
    throw new Error(
      `Unable to resolve a transfer smoke source warehouse for destination ${destinationWarehouse || '<empty>'}.`
    );
  }

  if (normalizedConfiguredBoxId) {
    const previewResponse = await runCase(
      {
        method: 'GET',
        path: '/boxes/transfer/plan',
        query: {
          boxId: normalizedConfiguredBoxId,
          toWarehouse: destinationWarehouse
        },
        expectedStatuses: [200, 400, 404]
      },
      token
    );

    if (previewResponse.statusCode === 200) {
      return {
        sourceWarehouse,
        boxId: normalizedConfiguredBoxId,
        temporaryBoxId: '',
        previewResponse
      };
    }

    const previewError = String(previewResponse.payload?.error || '').trim();
    // eslint-disable-next-line no-console
    console.log(
      `INFO configured transfer smoke box ${normalizedConfiguredBoxId} is unavailable (${previewResponse.statusCode}${previewError ? `: ${previewError}` : ''}). Falling back to a temporary smoke box.`
    );
  }

  const temporaryBox = await createTemporaryTransferSmokeBox(token, sourceWarehouse);
  // eslint-disable-next-line no-console
  console.log(`INFO created temporary transfer smoke box ${temporaryBox.boxId} in ${sourceWarehouse}.`);

  return {
    sourceWarehouse,
    boxId: temporaryBox.boxId,
    temporaryBoxId: temporaryBox.boxId,
    previewResponse: null
  };
}

async function cleanupTemporaryTransferSmokeContext(token, pendingTransferId, activeBoxId, temporaryBoxId) {
  const normalizedTemporaryBoxId = String(temporaryBoxId || '').trim().toUpperCase();
  if (!normalizedTemporaryBoxId) {
    return;
  }

  const normalizedPendingTransferId = String(pendingTransferId || '').trim().toUpperCase();
  if (normalizedPendingTransferId) {
    const cancelResponse = await runCase(
      {
        method: 'POST',
        path: '/boxes/transfer/cancel',
        body: {
          transferId: normalizedPendingTransferId,
          reason: 'Temporary transfer smoke cleanup.'
        },
        expectedStatuses: [200, 400, 404]
      },
      token
    );
    // eslint-disable-next-line no-console
    console.log(`CLEANUP POST /boxes/transfer/cancel -> ${cancelResponse.statusCode}`);
  }

  const candidateBoxIds = [activeBoxId, normalizedTemporaryBoxId];
  const attemptedBoxIds = new Set();

  for (let index = 0; index < candidateBoxIds.length; index += 1) {
    const candidateBoxId = String(candidateBoxIds[index] || '').trim().toUpperCase();
    if (!candidateBoxId || attemptedBoxIds.has(candidateBoxId)) {
      continue;
    }
    attemptedBoxIds.add(candidateBoxId);

    const deleteResponse = await runCase(
      {
        method: 'POST',
        path: '/boxes/delete',
        body: {
          boxId: candidateBoxId,
          reason: 'Temporary transfer smoke cleanup.'
        },
        expectedStatuses: [200, 404]
      },
      token
    );

    if (deleteResponse.statusCode === 200) {
      // eslint-disable-next-line no-console
      console.log(`CLEANUP POST /boxes/delete (${candidateBoxId}) -> ${deleteResponse.statusCode}`);
      return;
    }
  }

  // eslint-disable-next-line no-console
  console.log(`INFO temporary transfer smoke box ${normalizedTemporaryBoxId} was already removed.`);
}

async function main() {
  const { token, source } = await resolveSmokeAuthToken({
    required: false,
    requiredFor: 'authenticated backend smoke routes'
  });
  const includeMutations = String(process.env.SMOKE_INCLUDE_MUTATIONS || '').trim().toLowerCase() === 'true';
  const transferBoxId = String(process.env.SMOKE_TRANSFER_BOX_ID || '').trim().toUpperCase();
  const transferDestinationWarehouse = String(process.env.SMOKE_TRANSFER_DEST_WAREHOUSE || '')
    .trim()
    .toUpperCase();
  const transferRoundTrip = String(process.env.SMOKE_TRANSFER_ROUNDTRIP || '').trim().toLowerCase() === 'true';
  const verifyJobInstallDate = String(process.env.SMOKE_VERIFY_JOB_INSTALL_DATE || '').trim().toLowerCase() === 'true';
  const smokeJobNumber = String(process.env.SMOKE_JOB_NUMBER || '').trim();
  const smokeJobInstallDate = String(process.env.SMOKE_JOB_INSTALL_DATE || '').trim();
  const smokeJobWarehouse = String(process.env.SMOKE_JOB_WAREHOUSE || '').trim().toUpperCase();
  const smokeJobSections = String(process.env.SMOKE_JOB_SECTIONS || '').trim();
  const smokeJobCrewLeader = String(process.env.SMOKE_JOB_CREW_LEADER || '').trim();

  if (token && source === 'SMOKE_USER_EMAIL') {
    // eslint-disable-next-line no-console
    console.log('INFO authenticated smoke routes will use a token minted from SMOKE_USER_EMAIL.');
  }

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
    {
      method: 'GET',
      path: '/boxes/transfer/plan',
      expectedStatuses: [400],
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
      console.log(
        `SKIP ${testCase.method} ${testCase.path} (${buildSmokeAuthSetupMessage('authenticated backend smoke routes')})`
      );
      continue;
    }

    const response = await runCase(testCase, token);
    passed += 1;
    // eslint-disable-next-line no-console
    console.log(`PASS ${testCase.method} ${testCase.path} -> ${response.statusCode}`);
  }

  if (includeMutations) {
    if (token && transferDestinationWarehouse) {
      let smokeTransferBoxId = '';
      let temporaryTransferBoxId = '';
      let activeTransferBoxId = '';
      let activePendingTransferId = '';

      try {
        const transferContext = await resolveTransferSmokeContext(token, transferBoxId, transferDestinationWarehouse);
        smokeTransferBoxId = transferContext.boxId;
        temporaryTransferBoxId = transferContext.temporaryBoxId;
        activeTransferBoxId = transferContext.boxId;

        const previewTransferResponse =
          transferContext.previewResponse ||
          (await runCase(
            {
              method: 'GET',
              path: '/boxes/transfer/plan',
              query: {
                boxId: smokeTransferBoxId,
                toWarehouse: transferDestinationWarehouse
              },
              expectedStatuses: [200]
            },
            token
          ));
        passed += 1;
        const previewDestinationBoxId = String(
          previewTransferResponse.payload?.data?.destinationBoxId || ''
        ).trim().toUpperCase();
        if (!previewDestinationBoxId) {
          throw new Error('/boxes/transfer/plan: expected destinationBoxId in payload.data.destinationBoxId');
        }
        // eslint-disable-next-line no-console
        console.log(`PASS GET /boxes/transfer/plan -> ${previewTransferResponse.statusCode}`);

        const transferNote = `Smoke transfer ${new Date().toISOString()}`;
        const startTransferResponse = await runCase(
          {
            method: 'POST',
            path: '/boxes/transfer/start',
            body: {
              boxId: smokeTransferBoxId,
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
        activePendingTransferId = transferId;

        const transferLookupResponse = await runCase(
          {
            method: 'GET',
            path: '/boxes/transfer/by-box',
            query: { boxId: smokeTransferBoxId },
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

        if (transferRoundTrip) {
          const receiveTransferResponse = await runCase(
            {
              method: 'POST',
              path: '/boxes/transfer/receive',
              body: { transferId },
              expectedStatuses: [200]
            },
            token
          );
          passed += 1;
          activePendingTransferId = '';
          // eslint-disable-next-line no-console
          console.log(`PASS POST /boxes/transfer/receive -> ${receiveTransferResponse.statusCode}`);

          const receivedBoxId = String(
            receiveTransferResponse.payload?.data?.transfer?.destinationBoxId || ''
          ).trim().toUpperCase();
          const sourceWarehouse = String(
            receiveTransferResponse.payload?.data?.transfer?.sourceWarehouse || ''
          ).trim().toUpperCase();
          if (!receivedBoxId || !sourceWarehouse) {
            throw new Error(
              '/boxes/transfer/receive: expected payload.data.transfer.destinationBoxId and sourceWarehouse'
            );
          }
          activeTransferBoxId = receivedBoxId;

          const returnTransferResponse = await runCase(
            {
              method: 'POST',
              path: '/boxes/transfer/start',
              body: {
                boxId: receivedBoxId,
                toWarehouse: sourceWarehouse,
                notes: `Smoke return ${new Date().toISOString()}`
              },
              expectedStatuses: [200]
            },
            token
          );
          passed += 1;
          // eslint-disable-next-line no-console
          console.log(`PASS POST /boxes/transfer/start (return) -> ${returnTransferResponse.statusCode}`);

          const returnTransferId = String(
            returnTransferResponse.payload?.data?.transfer?.transferId || ''
          ).trim().toUpperCase();
          if (!returnTransferId) {
            throw new Error('/boxes/transfer/start (return): expected transferId in payload.data.transfer.transferId');
          }
          activePendingTransferId = returnTransferId;

          const receiveReturnResponse = await runCase(
            {
              method: 'POST',
              path: '/boxes/transfer/receive',
              body: { transferId: returnTransferId },
              expectedStatuses: [200]
            },
            token
          );
          passed += 1;
          activePendingTransferId = '';
          const returnedBoxId = String(
            receiveReturnResponse.payload?.data?.transfer?.destinationBoxId || ''
          ).trim().toUpperCase();
          if (returnedBoxId !== smokeTransferBoxId) {
            throw new Error(
              `/boxes/transfer/receive (return): expected destinationBoxId ${smokeTransferBoxId}, received ${returnedBoxId || '<empty>'}`
            );
          }
          activeTransferBoxId = returnedBoxId;
          // eslint-disable-next-line no-console
          console.log(`PASS POST /boxes/transfer/receive (return) -> ${receiveReturnResponse.statusCode}`);
        } else {
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
          activePendingTransferId = '';
          // eslint-disable-next-line no-console
          console.log(`PASS POST /boxes/transfer/cancel -> ${cancelTransferResponse.statusCode}`);
        }
      } finally {
        if (temporaryTransferBoxId) {
          await cleanupTemporaryTransferSmokeContext(
            token,
            activePendingTransferId,
            activeTransferBoxId || smokeTransferBoxId,
            temporaryTransferBoxId
          );
        }
      }
    } else {
      skipped += 1;
      // eslint-disable-next-line no-console
      console.log(
        'SKIP transfer mutation smoke (' +
          `${buildSmokeAuthSetupMessage('authenticated backend smoke routes')} ` +
          'Also set SMOKE_TRANSFER_DEST_WAREHOUSE.)'
      );
    }

    if (verifyJobInstallDate) {
      if (token && smokeJobNumber && smokeJobInstallDate) {
        const updateBody = {
          jobNumber: smokeJobNumber,
          installDate: smokeJobInstallDate
        };
        if (smokeJobWarehouse) {
          updateBody.warehouse = smokeJobWarehouse;
        }
        if (smokeJobSections) {
          updateBody.sections = smokeJobSections;
        }
        if (smokeJobCrewLeader) {
          updateBody.crewLeader = smokeJobCrewLeader;
        }

        const updateResponse = await runCase(
          {
            method: 'POST',
            path: '/jobs/update',
            body: updateBody,
            expectedStatuses: [200]
          },
          token
        );
        passed += 1;
        // eslint-disable-next-line no-console
        console.log(`PASS POST /jobs/update (installDate smoke) -> ${updateResponse.statusCode}`);

        const getResponse = await runCase(
          {
            method: 'GET',
            path: '/jobs/get',
            query: { jobNumber: smokeJobNumber },
            expectedStatuses: [200]
          },
          token
        );
        passed += 1;

        const persistedInstallDate = String(
          getResponse.payload?.data?.summary?.installDate || ''
        ).trim();
        if (persistedInstallDate !== smokeJobInstallDate) {
          throw new Error(
            `/jobs/get: expected summary.installDate ${smokeJobInstallDate}, received ${persistedInstallDate || '<empty>'}`
          );
        }

        // eslint-disable-next-line no-console
        console.log(`PASS GET /jobs/get (installDate smoke) -> ${getResponse.statusCode}`);
      } else {
        skipped += 1;
        // eslint-disable-next-line no-console
        console.log(
          'SKIP job install-date smoke (' +
            `${buildSmokeAuthSetupMessage('authenticated backend smoke routes')} ` +
            'Also set SMOKE_JOB_NUMBER and SMOKE_JOB_INSTALL_DATE. ' +
            'Set SMOKE_JOB_WAREHOUSE too if the smoke job may need to be created.)'
        );
      }
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
