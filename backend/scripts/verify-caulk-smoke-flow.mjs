import '../load-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { chromium } from 'playwright-core';
import { buildSmokeAuthSetupMessage, resolveSmokeAuthToken } from './lib/smoke-auth.mjs';
import { cleanupCaulkSmokeArtifacts } from './cleanup-caulk-smoke-artifacts.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const runlogsDir = path.join(repoRoot, '.codex-runlogs');
const DEFAULT_FRONTEND_BASE_URL = asTrimmedString(process.env.SMOKE_FRONTEND_URL) || 'http://127.0.0.1:5173';
const DEFAULT_SOURCE_WAREHOUSE = asTrimmedString(process.env.SMOKE_SOURCE_WAREHOUSE || 'IL1').toUpperCase();
const DEFAULT_DESTINATION_WAREHOUSE = asTrimmedString(process.env.SMOKE_DESTINATION_WAREHOUSE || 'MS1').toUpperCase();

function asTrimmedString(value) {
  return String(value || '').trim();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function requireDatabaseUrl() {
  const databaseUrl = asTrimmedString(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);
  assert(databaseUrl, 'DATABASE_URL or SUPABASE_DB_URL is required.');
  return databaseUrl;
}

function requireOrgId() {
  const orgId = asTrimmedString(process.env.DEFAULT_ORG_ID || process.env.VERIFY_DB_PARITY_ORG_ID);
  assert(orgId, 'DEFAULT_ORG_ID or VERIFY_DB_PARITY_ORG_ID is required.');
  return orgId;
}

function requireSmokeCredentials() {
  const email = asTrimmedString(process.env.SMOKE_USER_EMAIL);
  const password = asTrimmedString(process.env.SMOKE_USER_PASSWORD);
  assert(
    email && password,
    `${buildSmokeAuthSetupMessage('the caulk smoke browser flow')} Browser verification also requires SMOKE_USER_EMAIL and SMOKE_USER_PASSWORD.`
  );
  return { email, password };
}

function buildSmokeTag() {
  const stamp = new Date().toISOString().replace(/[.]/g, '-').replace(/[TZ]/g, '_').replace(/:+/g, '-');
  return `SMOKE_CAULK_20260416_${stamp}_${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0')}`;
}

function buildShortTag(tag) {
  return tag.replace(/^SMOKE_CAULK_/, '').replace(/[^A-Z0-9]/gi, '').slice(-10).toUpperCase() || 'SMOKE';
}

function buildJobNumbers() {
  const suffix = `${Date.now()}`.slice(-5);
  return {
    jobA: `98${suffix}`,
    jobB: `97${suffix}`
  };
}

function buildDisplayedJobLabel(jobNumber, warehouse) {
  const normalizedJobNumber = asTrimmedString(jobNumber);
  const normalizedWarehouse = asTrimmedString(warehouse).toUpperCase();
  if (!normalizedJobNumber) {
    return 'Job';
  }
  return normalizedWarehouse ? `Job ${normalizedWarehouse}-${normalizedJobNumber}` : `Job ${normalizedJobNumber}`;
}

function normalizeApiBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  const normalizedPath = url.pathname.replace(/\/+$/g, '');
  if (/\/functions\/v1\/api$/i.test(normalizedPath) || /\/api$/i.test(normalizedPath)) {
    url.pathname = normalizedPath || '/';
    return url.toString();
  }
  url.pathname = `${normalizedPath || ''}/api`;
  return url.toString();
}

function resolveApiBaseUrl(edgeMode) {
  const explicitApiBase = asTrimmedString(process.env.SMOKE_API_BASE_URL);
  if (explicitApiBase) {
    return normalizeApiBaseUrl(explicitApiBase);
  }

  if (edgeMode) {
    const edgeApiBase = asTrimmedString(
      process.env.VERIFY_EDGE_URL || process.env.EDGE_API_BASE_URL || process.env.VITE_API_BASE_URL
    );
    if (edgeApiBase) {
      return normalizeApiBaseUrl(edgeApiBase);
    }

    const supabaseUrl = asTrimmedString(process.env.SUPABASE_URL).replace(/\/+$/g, '');
    assert(supabaseUrl, 'SUPABASE_URL (or SMOKE_API_BASE_URL / VERIFY_EDGE_URL) is required for --edge smoke runs.');
    return `${supabaseUrl}/functions/v1/api`;
  }

  const localBackendBase = asTrimmedString(process.env.SMOKE_BACKEND_URL) || 'http://127.0.0.1:3000';
  return normalizeApiBaseUrl(localBackendBase);
}

function buildApiUrl(baseUrl, logicalPath, query = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('path', logicalPath);
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

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload = null;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = null;
  }

  return {
    statusCode: response.status,
    payload,
    text
  };
}

function isRefreshableAuthSession(value) {
  return Boolean(value && typeof value === 'object' && 'requiredFor' in value);
}

async function resolveRequestToken(tokenOrSession) {
  if (!isRefreshableAuthSession(tokenOrSession)) {
    return asTrimmedString(tokenOrSession);
  }

  if (asTrimmedString(tokenOrSession.token)) {
    return asTrimmedString(tokenOrSession.token);
  }

  const refreshed = await resolveSmokeAuthToken({
    required: true,
    requiredFor: tokenOrSession.requiredFor
  });
  tokenOrSession.token = asTrimmedString(refreshed.token);
  tokenOrSession.source = asTrimmedString(refreshed.source);
  return tokenOrSession.token;
}

async function refreshRequestToken(tokenSession) {
  const refreshed = await resolveSmokeAuthToken({
    required: true,
    requiredFor: tokenSession.requiredFor
  });
  tokenSession.token = asTrimmedString(refreshed.token);
  tokenSession.source = asTrimmedString(refreshed.source);
  return tokenSession.token;
}

async function apiRequest(method, baseUrl, logicalPath, tokenOrSession, { query = {}, body } = {}) {
  const send = async (token) => {
    const headers = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
    }
    return fetchJson(buildApiUrl(baseUrl, logicalPath, query), {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body || {})
    });
  };

  let token = await resolveRequestToken(tokenOrSession);
  let response = await send(token);

  if (response.statusCode === 401 && isRefreshableAuthSession(tokenOrSession)) {
    token = await refreshRequestToken(tokenOrSession);
    response = await send(token);
  }

  return response;
}

async function apiGet(baseUrl, logicalPath, tokenOrSession, query = {}) {
  return apiRequest('GET', baseUrl, logicalPath, tokenOrSession, { query });
}

async function apiPost(baseUrl, logicalPath, tokenOrSession, body = {}) {
  return apiRequest('POST', baseUrl, logicalPath, tokenOrSession, { body });
}

function assertOkEnvelope(response, label) {
  assert(
    response.statusCode === 200,
    `${label} expected HTTP 200, received ${response.statusCode}${response.payload?.error ? `: ${response.payload.error}` : ''}.`
  );
  assert(response.payload?.ok === true, `${label} expected ok=true.`);
  return response.payload.data;
}

function assertErrorEnvelope(response, expectedStatus, messagePattern, label) {
  assert(
    response.statusCode === expectedStatus,
    `${label} expected HTTP ${expectedStatus}, received ${response.statusCode}.`
  );
  const message =
    asTrimmedString(response.payload?.error) || asTrimmedString(response.payload?.message) || response.text;
  assert(message, `${label} expected an error message.`);
  if (messagePattern) {
    assert(messagePattern.test(message), `${label} failed with unexpected error: ${message}`);
  }
  return message;
}

async function connectClient() {
  const connectionString = requireDatabaseUrl();
  const client = new Client({
    connectionString,
    ssl: /localhost|127\.0\.0\.1/i.test(connectionString)
      ? undefined
      : { rejectUnauthorized: false }
  });
  await client.connect();
  return client;
}

async function ensureFrontendReachable(frontendBaseUrl) {
  const response = await fetchJson(frontendBaseUrl, { method: 'GET' });
  assert(response.statusCode === 200, `Frontend ${frontendBaseUrl} is unreachable.`);
}

async function ensureBackendHealthy(apiBaseUrl) {
  const response = await fetchJson(buildApiUrl(apiBaseUrl, '/health'), { method: 'GET' });
  const data = assertOkEnvelope(response, 'GET /health');
  assert(typeof data.apiBuildSha === 'string', '/health must include apiBuildSha.');
  assert(typeof data.apiBuiltAt === 'string', '/health must include apiBuiltAt.');
}

async function ensureWarehousesExist(client, orgId, warehouses) {
  const result = await client.query(
    `
      select code::text as code
      from app.warehouses
      where org_id = $1::uuid
      order by code
    `,
    [orgId]
  );
  const available = new Set(result.rows.map((row) => asTrimmedString(row.code).toUpperCase()).filter(Boolean));
  for (const warehouse of warehouses) {
    assert(available.has(warehouse), `Required smoke warehouse ${warehouse} is not configured for org ${orgId}.`);
  }
}

async function find3mManufacturer(backendBaseUrl, token) {
  const response = await apiGet(backendBaseUrl, '/caulk/manufacturers/list', token);
  const data = assertOkEnvelope(response, 'GET /caulk/manufacturers/list');
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const match = entries.find((entry) => asTrimmedString(entry?.name).toUpperCase() === '3M');
  assert(match?.manufacturerId, 'Caulk manufacturer 3M was not found.');
  return match;
}

async function getStockEntry(backendBaseUrl, token, warehouse, productId) {
  const response = await apiGet(backendBaseUrl, '/caulk/stock/list', token, {
    warehouse,
    productId
  });
  const data = assertOkEnvelope(response, `GET /caulk/stock/list (${warehouse})`);
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const entry = entries.find(
    (candidate) =>
      asTrimmedString(candidate?.warehouse).toUpperCase() === warehouse &&
      asTrimmedString(candidate?.productId) === productId
  );
  assert(entry, `Stock row for ${productId} in ${warehouse} was not found.`);
  return entry;
}

async function getPendingTransfers(backendBaseUrl, token, warehouse, productId) {
  const response = await apiGet(backendBaseUrl, '/caulk/transfers/list', token, {
    warehouse,
    productId
  });
  const data = assertOkEnvelope(response, `GET /caulk/transfers/list (${warehouse})`);
  return Array.isArray(data.entries) ? data.entries : [];
}

async function getAllocationJobDetail(backendBaseUrl, token, jobNumber) {
  const response = await apiGet(backendBaseUrl, '/allocations/by-job', token, { jobNumber });
  return assertOkEnvelope(response, `GET /allocations/by-job (${jobNumber})`);
}

function findCaulkRequirement(detail, productId) {
  return (Array.isArray(detail?.caulkRequirements) ? detail.caulkRequirements : []).find(
    (entry) => asTrimmedString(entry?.productId) === productId
  );
}

function findCaulkAllocation(detail, productId) {
  return (Array.isArray(detail?.caulkAllocations) ? detail.caulkAllocations : []).find(
    (entry) => asTrimmedString(entry?.productId) === productId
  );
}

function resolveBrowserExecutablePath() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Microsoft Edge or Google Chrome is required for browser smoke verification.');
}

async function ensureSignedIn(page, frontendBaseUrl, credentials) {
  await page.goto(`${frontendBaseUrl}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});

  const signInHeading = page.getByRole('heading', {
    name: /Sign in to open Window Film Inventory/i
  });
  if (await signInHeading.isVisible().catch(() => false)) {
    await page.getByLabel('Email').fill(credentials.email);
    await page.getByLabel('Password').fill(credentials.password);
    await page.getByRole('button', { name: /^Sign In$/i }).click();
  }

  await page.waitForFunction(
    () =>
      !document.body.innerText.includes('Sign in to open Window Film Inventory') &&
      document.body.innerText.includes('Inventory'),
    null,
    { timeout: 30_000 }
  );
}

async function gotoCaulkInventory(page, frontendBaseUrl) {
  await page.goto(`${frontendBaseUrl}/?smokeNav=${Date.now()}#/?inventoryView=caulk`, {
    waitUntil: 'domcontentloaded'
  });
  await page.getByRole('heading', { name: 'Caulk Inventory' }).waitFor({ timeout: 20_000 });
}

async function gotoCaulkDetailsPage(page, frontendBaseUrl, warehouse, productId) {
  await page.goto(
    `${frontendBaseUrl}/?smokeNav=${Date.now()}#/caulk/${encodeURIComponent(warehouse)}/${encodeURIComponent(productId)}`,
    { waitUntil: 'domcontentloaded' }
  );
  await page.getByRole('heading', { name: 'Caulk Details' }).waitFor({ timeout: 20_000 });
}

async function gotoAllocationJobPage(page, frontendBaseUrl, jobNumber) {
  await page.goto(`${frontendBaseUrl}/?smokeNav=${Date.now()}#/allocations/${encodeURIComponent(jobNumber)}`, {
    waitUntil: 'domcontentloaded'
  });
  await page.getByRole('heading', { name: 'Caulk Allocations' }).waitFor({ timeout: 20_000 });
}

async function expectStockRow(page, productName, warehouse, expectedTubes) {
  const row = page.locator('tbody tr').filter({ hasText: productName }).first();
  await row.waitFor({ timeout: 20_000 });
  const text = (await row.textContent()) || '';
  assert(text.includes(warehouse), `Caulk inventory row for ${productName} does not include warehouse ${warehouse}.`);
  assert(
    text.includes(String(expectedTubes)),
    `Caulk inventory row for ${productName} does not include ${expectedTubes} tubes.`
  );
  return row;
}

async function clickStockRowDetails(row, warehouse) {
  await row.getByRole('link', { name: warehouse }).click();
}

async function screenshotOnFailure(page, smokeTag) {
  if (!page) {
    return '';
  }

  fs.mkdirSync(runlogsDir, { recursive: true });
  const screenshotPath = path.join(runlogsDir, `caulk-smoke-failure-${smokeTag}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  return screenshotPath;
}

async function assertCleanupResidue(client, orgId, smokeTag) {
  const queries = [
    {
      label: 'caulk_products',
      sql: 'select count(*)::integer as count from app.caulk_products where org_id = $1::uuid and notes = $2::text'
    },
    {
      label: 'jobs',
      sql: 'select count(*)::integer as count from app.jobs where org_id = $1::uuid and notes = $2::text'
    }
  ];

  for (const entry of queries) {
    const result = await client.query(entry.sql, [orgId, smokeTag]);
    const count = Number(result.rows[0]?.count || 0);
    assert(count === 0, `Cleanup left ${count} ${entry.label} row(s) behind for tag ${smokeTag}.`);
  }
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let cleanupOnly = false;
  let edge = false;
  let tag = '';

  for (let index = 0; index < args.length; index += 1) {
    const entry = asTrimmedString(args[index]);
    if (entry === '--cleanup-only') {
      cleanupOnly = true;
      continue;
    }
    if (entry === '--edge') {
      edge = true;
      continue;
    }
    if (entry === '--tag') {
      tag = asTrimmedString(args[index + 1]);
      index += 1;
    }
  }

  return { cleanupOnly, edge, tag };
}

async function main() {
  const { cleanupOnly, edge, tag: cleanupTag } = parseArgs(process.argv.slice(2));
  let client;
  let browser;
  let context;
  let page;
  let smokeTag = cleanupTag || '';
  let failureScreenshotPath = '';

  if (cleanupOnly) {
    const cleanupSummary = await cleanupCaulkSmokeArtifacts({ tag: cleanupTag });
    console.log(JSON.stringify(cleanupSummary, null, 2));
    return;
  }

  const orgId = requireOrgId();
  const frontendBaseUrl = DEFAULT_FRONTEND_BASE_URL;
  const apiBaseUrl = resolveApiBaseUrl(edge);
  const browserCredentials = requireSmokeCredentials();
  const authSession = {
    requiredFor: edge ? 'the live Edge caulk smoke API flow' : 'the caulk smoke API flow',
    token: '',
    source: ''
  };

  const tokenResult = await resolveSmokeAuthToken({
    required: true,
    requiredFor: authSession.requiredFor
  });
  authSession.token = asTrimmedString(tokenResult.token);
  authSession.source = asTrimmedString(tokenResult.source);

  try {
    smokeTag = buildSmokeTag();
    const shortTag = buildShortTag(smokeTag);
    const { jobA, jobB } = buildJobNumbers();
    const productName = `Smoke Caulk ${smokeTag}`;
    const productCode = `SMK-${shortTag}`;
    const sourceWarehouse = DEFAULT_SOURCE_WAREHOUSE;
    const destinationWarehouse = DEFAULT_DESTINATION_WAREHOUSE;

    console.log(`[caulk-smoke] tag=${smokeTag}`);
    console.log(`[caulk-smoke] product=${productCode} jobs=${jobA},${jobB}`);

    client = await connectClient();
    await ensureFrontendReachable(frontendBaseUrl);
    await ensureBackendHealthy(apiBaseUrl);
    await ensureWarehousesExist(client, orgId, [sourceWarehouse, destinationWarehouse]);

    const manufacturer3m = await find3mManufacturer(apiBaseUrl, authSession);
    const upsertProductData = assertOkEnvelope(
      await apiPost(apiBaseUrl, '/caulk/products/upsert', authSession, {
        manufacturerId: manufacturer3m.manufacturerId,
        productName,
        productCode,
        warehouse: destinationWarehouse,
        tubesPerCase: 16,
        notes: smokeTag
      }),
      'POST /caulk/products/upsert'
    );
    const productId = asTrimmedString(upsertProductData.productId);
    assert(productId, 'Product creation did not return productId.');

    const ms1InitialStock = await getStockEntry(apiBaseUrl, authSession, destinationWarehouse, productId);
    assert(
      Number(ms1InitialStock.tubesOnHand || 0) === 0,
      `Expected ${destinationWarehouse} to start at 0 tubes, received ${ms1InitialStock.tubesOnHand}.`
    );

    browser = await chromium.launch({
      headless: asTrimmedString(process.env.SMOKE_HEADLESS || 'true').toLowerCase() !== 'false',
      executablePath: resolveBrowserExecutablePath()
    });
    context = await browser.newContext();
    page = await context.newPage();
    await ensureSignedIn(page, frontendBaseUrl, browserCredentials);

    await gotoCaulkInventory(page, frontendBaseUrl);
    const productRow = await expectStockRow(page, productName, destinationWarehouse, 0);
    await clickStockRowDetails(productRow, destinationWarehouse);
    await page.getByText(productName, { exact: false }).first().waitFor({ timeout: 20_000 });

    assertOkEnvelope(
      await apiPost(apiBaseUrl, '/caulk/mutate', authSession, {
        action: 'RECEIVE',
        productId,
        warehouse: sourceWarehouse,
        deltaTubes: 6,
        reason: `Smoke seed ${shortTag}`,
        notes: smokeTag
      }),
      'POST /caulk/mutate'
    );

    const il1SeedStock = await getStockEntry(apiBaseUrl, authSession, sourceWarehouse, productId);
    assert(
      Number(il1SeedStock.tubesOnHand || 0) === 6,
      `Expected ${sourceWarehouse} to have 6 tubes after seed, received ${il1SeedStock.tubesOnHand}.`
    );

    const jobAData = assertOkEnvelope(
      await apiPost(apiBaseUrl, '/jobs/create', authSession, {
        jobNumber: jobA,
        warehouse: destinationWarehouse,
        installDate: '2026-04-16',
        crewLeader: smokeTag,
        notes: smokeTag,
        requirements: [],
        caulkRequirements: [{ productId, requiredTubes: 3 }]
      }),
      'POST /jobs/create (job A)'
    );
    const jobARequirement = findCaulkRequirement(jobAData, productId);
    assert(jobARequirement?.requirementId, 'Job A requirementId was not returned.');

    assertOkEnvelope(
      await apiPost(apiBaseUrl, '/allocations/caulk/add', authSession, {
        jobNumber: jobA,
        requirementId: jobARequirement.requirementId,
        productId,
        warehouse: destinationWarehouse,
        transferFromWarehouse: sourceWarehouse,
        allocatedTubes: 3,
        notes: smokeTag
      }),
      'POST /allocations/caulk/add (job A)'
    );

    const pendingJobADetail = await getAllocationJobDetail(apiBaseUrl, authSession, jobA);
    const pendingJobAAllocation = findCaulkAllocation(pendingJobADetail, productId);
    const displayedJobALabel = buildDisplayedJobLabel(jobA, destinationWarehouse);
    assert(
      Array.isArray(pendingJobADetail.caulkTransferAlerts) &&
        pendingJobADetail.caulkTransferAlerts.length === 1 &&
        pendingJobADetail.caulkTransferAlerts[0].state === 'TRANSFER_PENDING',
      'Job A should show one TRANSFER_PENDING caulk transfer alert.'
    );
    assert(
      pendingJobAAllocation?.pendingTransfer?.transferId,
      'Job A allocation should include pending transfer metadata.'
    );

    const pendingTransferIdA = asTrimmedString(pendingJobAAllocation.pendingTransfer.transferId);
    const pendingTransfersA = await getPendingTransfers(
      apiBaseUrl,
      authSession,
      destinationWarehouse,
      productId
    );
    assert(
      pendingTransfersA.some((entry) => asTrimmedString(entry.transferId) === pendingTransferIdA),
      'Destination inbound transfer list is missing job A pending transfer.'
    );

    const il1AfterPendingA = await getStockEntry(apiBaseUrl, authSession, sourceWarehouse, productId);
    const ms1AfterPendingA = await getStockEntry(apiBaseUrl, authSession, destinationWarehouse, productId);
    assert(
      Number(il1AfterPendingA.tubesOnHand || 0) === 3,
      `Expected ${sourceWarehouse} to drop to 3 tubes after pending transfer, received ${il1AfterPendingA.tubesOnHand}.`
    );
    assert(
      Number(ms1AfterPendingA.tubesOnHand || 0) === 0,
      `Expected ${destinationWarehouse} to remain at 0 before receive, received ${ms1AfterPendingA.tubesOnHand}.`
    );

    assertErrorEnvelope(
      await apiPost(apiBaseUrl, '/jobs/checkout-all', authSession, { jobNumber: jobA }),
      400,
      /Receive transferred caulk before checking out this job\./i,
      'POST /jobs/checkout-all before receive'
    );
    assertErrorEnvelope(
      await apiPost(apiBaseUrl, '/jobs/set-staged-pickup', authSession, {
        jobNumber: jobA,
        isStagedForPickup: true
      }),
      400,
      /Receive transferred caulk before staging this job\./i,
      'POST /jobs/set-staged-pickup before receive'
    );

    await gotoAllocationJobPage(page, frontendBaseUrl, jobA);
    await page.getByText('Caulk Transfer Alerts').first().waitFor({ timeout: 20_000 });
    await page.getByText(productName, { exact: false }).first().waitFor({ timeout: 20_000 });
    await page.getByText('Transfer Pending').first().waitFor({ timeout: 20_000 });

    await gotoCaulkDetailsPage(page, frontendBaseUrl, destinationWarehouse, productId);
    await page.getByRole('heading', { name: 'Inbound Transfers' }).waitFor({ timeout: 20_000 });
    await page.getByText(displayedJobALabel).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Receive' }).click();
    await page.getByText(displayedJobALabel).waitFor({ state: 'detached', timeout: 20_000 }).catch(async () => {
      const inboundRows = page.locator('.job-transfer-alert-row').filter({ hasText: displayedJobALabel });
      await inboundRows.first().waitFor({ state: 'detached', timeout: 20_000 });
    });

    const transfersAfterReceiveA = await getPendingTransfers(
      apiBaseUrl,
      authSession,
      destinationWarehouse,
      productId
    );
    assert(
      !transfersAfterReceiveA.some((entry) => asTrimmedString(entry.transferId) === pendingTransferIdA),
      'Job A pending transfer still exists after receive.'
    );
    const receivedJobADetail = await getAllocationJobDetail(apiBaseUrl, authSession, jobA);
    const receivedJobAAllocation = findCaulkAllocation(receivedJobADetail, productId);
    assert(
      !Array.isArray(receivedJobADetail.caulkTransferAlerts) ||
        receivedJobADetail.caulkTransferAlerts.length === 0,
      'Job A caulk transfer alerts should clear after receive.'
    );
    assert(
      !receivedJobAAllocation?.pendingTransfer,
      'Job A allocation should no longer carry pending transfer metadata after receive.'
    );

    assertOkEnvelope(
      await apiPost(apiBaseUrl, '/jobs/checkout-all', authSession, { jobNumber: jobA }),
      'POST /jobs/checkout-all after receive'
    );
    const stagedJobA = assertOkEnvelope(
      await apiPost(apiBaseUrl, '/jobs/set-staged-pickup', authSession, {
        jobNumber: jobA,
        isStagedForPickup: true,
        autoCheckoutRemaining: true
      }),
      'POST /jobs/set-staged-pickup after receive'
    );
    assert(
      stagedJobA.summary?.isStagedForPickup === true,
      'Job A should be marked staged for pickup after receive + checkout.'
    );

    const jobBData = assertOkEnvelope(
      await apiPost(apiBaseUrl, '/jobs/create', authSession, {
        jobNumber: jobB,
        warehouse: destinationWarehouse,
        installDate: '2026-04-16',
        crewLeader: smokeTag,
        notes: smokeTag,
        requirements: [],
        caulkRequirements: [{ productId, requiredTubes: 2 }]
      }),
      'POST /jobs/create (job B)'
    );
    const jobBRequirement = findCaulkRequirement(jobBData, productId);
    assert(jobBRequirement?.requirementId, 'Job B requirementId was not returned.');

    assertOkEnvelope(
      await apiPost(apiBaseUrl, '/allocations/caulk/add', authSession, {
        jobNumber: jobB,
        requirementId: jobBRequirement.requirementId,
        productId,
        warehouse: destinationWarehouse,
        transferFromWarehouse: sourceWarehouse,
        allocatedTubes: 2,
        notes: smokeTag
      }),
      'POST /allocations/caulk/add (job B)'
    );

    const pendingJobBDetail = await getAllocationJobDetail(apiBaseUrl, authSession, jobB);
    const pendingJobBAllocation = findCaulkAllocation(pendingJobBDetail, productId);
    assert(
      pendingJobBAllocation?.pendingTransfer?.transferId,
      'Job B allocation should include a pending transfer before cancel.'
    );
    const il1AfterPendingB = await getStockEntry(apiBaseUrl, authSession, sourceWarehouse, productId);
    assert(
      Number(il1AfterPendingB.tubesOnHand || 0) === 1,
      `Expected ${sourceWarehouse} to have 1 tube after job B pending transfer, received ${il1AfterPendingB.tubesOnHand}.`
    );

    await gotoAllocationJobPage(page, frontendBaseUrl, jobB);
    await page.getByText('Caulk Transfer Alerts').first().waitFor({ timeout: 20_000 });
    await page.getByText('Transfer Pending').first().waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Cancel Transfer' }).click();
    await page.getByText('Needs Transfer').first().waitFor({ timeout: 20_000 });

    const afterCancelJobBDetail = await getAllocationJobDetail(apiBaseUrl, authSession, jobB);
    const afterCancelJobBAllocation = findCaulkAllocation(afterCancelJobBDetail, productId);
    assert(
      Array.isArray(afterCancelJobBDetail.caulkTransferAlerts) &&
        afterCancelJobBDetail.caulkTransferAlerts.length === 1 &&
        afterCancelJobBDetail.caulkTransferAlerts[0].state === 'NEEDS_TRANSFER',
      'Job B should fall back to a NEEDS_TRANSFER alert after cancelling the pending transfer.'
    );
    assert(
      !afterCancelJobBAllocation?.pendingTransfer,
      'Job B allocation should not carry pending transfer metadata after cancel.'
    );

    const afterCancelTransfers = await getPendingTransfers(
      apiBaseUrl,
      authSession,
      destinationWarehouse,
      productId
    );
    assert(afterCancelTransfers.length === 0, 'Destination inbound transfer list should be empty after cancel.');

    const il1AfterCancelB = await getStockEntry(apiBaseUrl, authSession, sourceWarehouse, productId);
    assert(
      Number(il1AfterCancelB.tubesOnHand || 0) === 3,
      `Expected ${sourceWarehouse} stock to restore to 3 after cancel, received ${il1AfterCancelB.tubesOnHand}.`
    );

    assertErrorEnvelope(
      await apiPost(apiBaseUrl, '/jobs/checkout-all', authSession, { jobNumber: jobB }),
      400,
      /caulk/i,
      'POST /jobs/checkout-all after cancel'
    );
    assertErrorEnvelope(
      await apiPost(apiBaseUrl, '/jobs/set-staged-pickup', authSession, {
        jobNumber: jobB,
        isStagedForPickup: true
      }),
      400,
      /caulk/i,
      'POST /jobs/set-staged-pickup after cancel'
    );

    console.log('[caulk-smoke] scenarios passed, starting cleanup');
  } catch (error) {
    failureScreenshotPath = await screenshotOnFailure(page, smokeTag || 'unknown');
    if (failureScreenshotPath) {
      console.error(`[caulk-smoke] failure screenshot: ${failureScreenshotPath}`);
    }
    throw error;
  } finally {
    try {
      if (smokeTag) {
        const cleanupSummary = await cleanupCaulkSmokeArtifacts({
          client,
          orgId,
          tag: smokeTag
        });
        console.log(JSON.stringify(cleanupSummary, null, 2));
        if (client) {
          await assertCleanupResidue(client, orgId, smokeTag);
        }
      }
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
      await client?.end().catch(() => {});
    }
  }

  console.log('[caulk-smoke] complete');
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('[caulk-smoke] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
