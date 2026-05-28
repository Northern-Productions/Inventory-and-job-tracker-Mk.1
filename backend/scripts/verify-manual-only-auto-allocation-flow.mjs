import '../load-env.mjs';
import crypto from 'node:crypto';
import { Client } from 'pg';
import { resolveSmokeAuthToken } from './lib/smoke-auth.mjs';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3000/api';
const DEV_PROJECT_REF = 'uxiltcpbhthhinonttrc';

function asText(value) {
  return String(value ?? '').trim();
}

function integer(value) {
  return Math.max(0, Math.floor(Number(value || 0)));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeApiBaseUrl(value) {
  const url = new URL(asText(value) || DEFAULT_API_BASE_URL);
  const path = url.pathname.replace(/\/+$/g, '');
  if (!/\/api$/i.test(path)) {
    url.pathname = `${path || ''}/api`;
  }
  return url.toString();
}

function buildApiUrl(baseUrl, logicalPath, query = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('path', logicalPath);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
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
  return { statusCode: response.status, payload, text };
}

async function apiRequest(method, baseUrl, logicalPath, token, { query = {}, body } = {}) {
  const response = await fetchJson(buildApiUrl(baseUrl, logicalPath, query), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  });
  return response;
}

async function apiGet(baseUrl, logicalPath, token, query = {}) {
  return apiRequest('GET', baseUrl, logicalPath, token, { query });
}

async function apiPost(baseUrl, logicalPath, token, body = {}) {
  return apiRequest('POST', baseUrl, logicalPath, token, { body });
}

function assertOkEnvelope(response, label) {
  const errorText =
    asText(response.payload?.error) ||
    asText(response.payload?.message) ||
    asText(response.payload?.details) ||
    asText(response.text).slice(0, 180);
  assert(
    response.statusCode >= 200 && response.statusCode < 300 && response.payload?.ok !== false,
    `${label} failed (${response.statusCode})${errorText ? `: ${errorText}` : ''}`
  );
  return response.payload?.data ?? response.payload;
}

async function expectBusinessError(promise, label, pattern) {
  const response = await promise;
  const message =
    asText(response.payload?.error) ||
    asText(response.payload?.message) ||
    asText(response.payload?.details) ||
    asText(response.text);
  assert(response.statusCode >= 400, `${label} should have failed with a business error.`);
  assert(pattern.test(message), `${label} returned unexpected error: ${message}`);
  return message;
}

function requireDatabaseUrl() {
  const databaseUrl = asText(process.env.DEV_DATABASE_URL || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);
  assert(databaseUrl, 'DEV_DATABASE_URL, DATABASE_URL, or SUPABASE_DB_URL is required.');
  assert(
    databaseUrl.includes(DEV_PROJECT_REF),
    `Refusing DEV workflow verification because the database target is not ${DEV_PROJECT_REF}.`
  );
  return databaseUrl;
}

function requireOrgId() {
  const orgId = asText(process.env.VERIFY_DB_PARITY_ORG_ID || process.env.DEFAULT_ORG_ID);
  assert(orgId, 'VERIFY_DB_PARITY_ORG_ID or DEFAULT_ORG_ID is required.');
  return orgId;
}

async function connectClient() {
  const databaseUrl = requireDatabaseUrl();
  const client = new Client({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function listWarehouses(client, orgId) {
  const result = await client.query(
    `
      select code::text as code
      from app.warehouses
      where org_id = $1::uuid
      order by code
    `,
    [orgId]
  );
  return result.rows.map((row) => asText(row.code).toUpperCase()).filter(Boolean);
}

async function getBoxState(client, orgId, boxId) {
  const result = await client.query(
    `
      select
        b.box_id::text as box_id,
        b.warehouse::text as warehouse,
        b.status::text as status,
        b.initial_feet::integer as initial_feet,
        b.feet_available::integer as feet_available,
        app_api.box_allocatable_now_feet(b)::integer as allocatable_now_feet,
        coalesce((
          select sum(a.allocated_feet)::integer
          from app.allocations a
          where a.org_id = b.org_id
            and a.box_id = b.box_id
            and upper(coalesce(a.status::text, '')) = 'ACTIVE'
        ), 0)::integer as active_allocated_feet
      from app.boxes b
      where b.org_id = $1::uuid
        and b.box_id = $2::text
    `,
    [orgId, boxId]
  );
  assert(result.rows[0], `Box ${boxId} was not found.`);
  return {
    boxId: result.rows[0].box_id,
    warehouse: result.rows[0].warehouse,
    status: result.rows[0].status,
    initialFeet: integer(result.rows[0].initial_feet),
    feetAvailable: integer(result.rows[0].feet_available),
    activeAllocatedFeet: integer(result.rows[0].active_allocated_feet),
    allocatableNowFeet: integer(result.rows[0].allocatable_now_feet),
  };
}

async function getCaulkStockState(client, orgId, productId, warehouse) {
  const result = await client.query(
    `
      select
        coalesce(s.tubes_on_hand, 0)::integer as tubes_on_hand,
        coalesce((
          select sum(a.reserved_tubes_remaining)::integer
          from app.caulk_job_allocations a
          where a.org_id = $1::uuid
            and a.product_id = $2::uuid
            and upper(trim(a.warehouse::text)) = upper(trim($3::text))
            and upper(coalesce(a.status::text, '')) = 'ACTIVE'
        ), 0)::integer as active_reserved_tubes
      from app.caulk_stock s
      where s.org_id = $1::uuid
        and s.product_id = $2::uuid
        and upper(trim(s.warehouse::text)) = upper(trim($3::text))
    `,
    [orgId, productId, warehouse]
  );
  const row = result.rows[0] || {};
  return {
    warehouse,
    tubesOnHand: integer(row.tubes_on_hand),
    activeReservedTubes: integer(row.active_reserved_tubes),
  };
}

async function getActiveAllocationCounts(client, orgId, jobId) {
  const result = await client.query(
    `
      select
        (select count(*)::integer
         from app.allocations
         where org_id = $1::uuid
           and job_id = $2::uuid
           and upper(coalesce(status::text, '')) = 'ACTIVE') as film_active,
        (select count(*)::integer
         from app.allocations
         where org_id = $1::uuid
           and job_id = $2::uuid
           and upper(coalesce(status::text, '')) = 'ACTIVE'
           and coalesce(allocation_source::text, 'MANUAL') = 'AUTO_PLANNED') as film_auto_planned,
        (select count(*)::integer
         from app.caulk_job_allocations
         where org_id = $1::uuid
           and job_id = $2::uuid
           and upper(coalesce(status::text, '')) = 'ACTIVE') as caulk_active,
        (select count(*)::integer
         from app.caulk_job_allocations
         where org_id = $1::uuid
           and job_id = $2::uuid
           and upper(coalesce(status::text, '')) = 'ACTIVE'
           and coalesce(allocation_source::text, 'MANUAL') = 'AUTO_PLANNED') as caulk_auto_planned
    `,
    [orgId, jobId]
  );
  const row = result.rows[0] || {};
  return {
    filmActive: integer(row.film_active),
    filmAutoPlanned: integer(row.film_auto_planned),
    caulkActive: integer(row.caulk_active),
    caulkAutoPlanned: integer(row.caulk_auto_planned),
  };
}

async function callPlannerNoop(client, orgId, actor, jobId, jobNumber) {
  const result = await client.query(
    `
      select app_api.reconcile_auto_planned_allocations(
        $1::uuid,
        $2::text,
        jsonb_build_object('jobIds', jsonb_build_array($3::text), 'jobNumbers', jsonb_build_array($4::text))
      ) as result
    `,
    [orgId, actor, jobId, jobNumber]
  );
  return result.rows[0]?.result || {};
}

async function find3mManufacturer(apiBaseUrl, token) {
  const data = assertOkEnvelope(
    await apiGet(apiBaseUrl, '/caulk/manufacturers/list', token),
    'GET /caulk/manufacturers/list'
  );
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const match = entries.find((entry) => asText(entry?.name).toUpperCase() === '3M');
  assert(match?.manufacturerId, 'Caulk manufacturer 3M was not found.');
  return match;
}

async function getJobDetailById(apiBaseUrl, token, jobId) {
  return assertOkEnvelope(
    await apiGet(apiBaseUrl, '/jobs/get-by-id', token, { jobId }),
    `GET /jobs/get-by-id ${jobId}`
  );
}

function findRequirement(detail, predicate, label) {
  const match = (detail.requirements || []).find(predicate);
  assert(match?.requirementId, `${label} requirement was not found.`);
  return match;
}

function findCaulkRequirement(detail, predicate, label) {
  const match = (detail.caulkRequirements || []).find(predicate);
  assert(match?.requirementId, `${label} caulk requirement was not found.`);
  return match;
}

function buildBoxPayload({ boxId, warehouse, filmName, initialFeet, tag, today }) {
  return {
    boxId,
    warehouse,
    dealer: 'Eastman Performance Films',
    manufacturer: '3M Solar',
    filmName,
    widthIn: 60,
    initialFeet,
    orderDate: today,
    receivedDate: today,
    coreType: 'White plastic',
    initialWeightLbs: 18,
    notes: tag,
    auditNote: tag,
  };
}

async function main() {
  const apiBaseUrl = normalizeApiBaseUrl(process.env.SMOKE_BACKEND_URL || DEFAULT_API_BASE_URL);
  const tokenSession = await resolveSmokeAuthToken({
    required: true,
    requiredFor: 'manual-only auto-allocation DEV workflow verification',
  });
  const token = tokenSession.token;
  const orgId = requireOrgId();
  const actor = 'manual-only-auto-allocation-verifier';
  const client = await connectClient();

  try {
    const warehouses = await listWarehouses(client, orgId);
    const jobWarehouse = warehouses.includes('IL1') ? 'IL1' : warehouses[0];
    const otherWarehouse = warehouses.find((entry) => entry !== jobWarehouse);
    assert(jobWarehouse && otherWarehouse, 'At least two warehouses are required for cross-warehouse verification.');

    const suffix = `${Date.now().toString().slice(-7)}${crypto.randomInt(0, 1000).toString().padStart(3, '0')}`;
    const tag = `CODEX_MANUAL_ONLY_AUTO_ALLOC_${suffix}`;
    const today = new Date().toISOString().slice(0, 10);
    const jobNumber = `88${suffix.slice(-6)}`;
    const jobBoxId = `${jobWarehouse}-MAA-${suffix.slice(-7)}`;
    const otherBoxId = `${otherWarehouse}-MAA-${suffix.slice(-7)}`;
    const newReqBoxId = `${jobWarehouse}-MAB-${suffix.slice(-7)}`;

    console.log(`[manual-only-verification] tag=${tag}`);
    console.log(`[manual-only-verification] warehouses job=${jobWarehouse} other=${otherWarehouse}`);

    const manufacturer3m = await find3mManufacturer(apiBaseUrl, token);
    const product = assertOkEnvelope(
      await apiPost(apiBaseUrl, '/caulk/products/upsert', token, {
        manufacturerId: manufacturer3m.manufacturerId,
        productName: `Codex Manual Only Caulk ${suffix}`,
        productCode: `CMO-${suffix.slice(-8)}`,
        warehouse: jobWarehouse,
        tubesPerCase: 12,
        notes: tag,
      }),
      'POST /caulk/products/upsert'
    );
    const productId = asText(product.productId);
    assert(productId, 'Caulk product creation did not return productId.');

    await apiPost(apiBaseUrl, '/caulk/mutate', token, {
      action: 'RECEIVE',
      productId,
      warehouse: jobWarehouse,
      deltaTubes: 5,
      reason: tag,
      notes: tag,
    }).then((response) => assertOkEnvelope(response, `POST /caulk/mutate ${jobWarehouse}`));
    await apiPost(apiBaseUrl, '/caulk/mutate', token, {
      action: 'RECEIVE',
      productId,
      warehouse: otherWarehouse,
      deltaTubes: 9,
      reason: tag,
      notes: tag,
    }).then((response) => assertOkEnvelope(response, `POST /caulk/mutate ${otherWarehouse}`));

    await apiPost(apiBaseUrl, '/boxes/add', token, buildBoxPayload({
      boxId: jobBoxId,
      warehouse: jobWarehouse,
      filmName: 'Prestige 60',
      initialFeet: 40,
      tag,
      today,
    })).then((response) => assertOkEnvelope(response, `POST /boxes/add ${jobBoxId}`));
    await apiPost(apiBaseUrl, '/boxes/add', token, buildBoxPayload({
      boxId: otherBoxId,
      warehouse: otherWarehouse,
      filmName: 'Prestige 60',
      initialFeet: 100,
      tag,
      today,
    })).then((response) => assertOkEnvelope(response, `POST /boxes/add ${otherBoxId}`));
    await apiPost(apiBaseUrl, '/boxes/add', token, buildBoxPayload({
      boxId: newReqBoxId,
      warehouse: jobWarehouse,
      filmName: 'Prestige 40',
      initialFeet: 30,
      tag,
      today,
    })).then((response) => assertOkEnvelope(response, `POST /boxes/add ${newReqBoxId}`));

    const createDetail = assertOkEnvelope(
      await apiPost(apiBaseUrl, '/jobs/create', token, {
        jobNumber,
        warehouse: jobWarehouse,
        installDate: today,
        crewLeader: tag,
        notes: tag,
        requirements: [
          {
            manufacturer: '3M Solar',
            filmName: 'Prestige 60',
            widthIn: 60,
            requiredFeet: 80,
          },
        ],
        caulkRequirements: [{ productId, requiredTubes: 8 }],
      }),
      'POST /jobs/create'
    );
    const jobId = asText(createDetail.summary?.jobId);
    assert(jobId, 'Created job did not return canonical jobId.');
    const createdFilmRequirement = findRequirement(
      createDetail,
      (entry) => asText(entry.filmName).toUpperCase().includes('PRESTIGE 60'),
      'created film'
    );
    const createdCaulkRequirement = findCaulkRequirement(
      createDetail,
      (entry) => asText(entry.productId) === productId,
      'created'
    );
    const afterCreateCounts = await getActiveAllocationCounts(client, orgId, jobId);
    assert(afterCreateCounts.filmActive === 0, `Expected no film allocations after create, got ${afterCreateCounts.filmActive}.`);
    assert(afterCreateCounts.caulkActive === 0, `Expected no caulk allocations after create, got ${afterCreateCounts.caulkActive}.`);
    assert(integer(createdFilmRequirement.allocatedFeet) === 0, 'Created film requirement should start unallocated.');
    assert(integer(createdFilmRequirement.remainingFeet) === 80, 'Created film requirement should expose 80 LF remaining.');
    assert(integer(createdCaulkRequirement.allocatedTubes) === 0, 'Created caulk requirement should start unallocated.');
    assert(integer(createdCaulkRequirement.remainingTubes) === 8, 'Created caulk requirement should expose 8 tubes remaining.');

    const plannerNoopResult = await callPlannerNoop(client, orgId, actor, jobId, jobNumber);
    assert(plannerNoopResult.manualOnly === true, 'Planner reconciler did not report manualOnly=true.');
    const afterPlannerNoopCounts = await getActiveAllocationCounts(client, orgId, jobId);
    assert(afterPlannerNoopCounts.filmActive === 0, 'No-op planner should not create film allocations.');
    assert(afterPlannerNoopCounts.caulkActive === 0, 'No-op planner should not create caulk allocations.');

    const rejectedCrossWarehouseMessage = await expectBusinessError(
      apiPost(apiBaseUrl, '/allocations/apply', token, {
        jobId,
        jobNumber,
        boxId: otherBoxId,
        requestedFeet: 10,
        requestedWidthIn: 60,
        requirementId: createdFilmRequirement.requirementId,
        selectedSuggestionBoxIds: [],
        extraAllocations: [],
        crossWarehouse: true,
        jobWarehouse: otherWarehouse,
        autoAllocate: true,
      }),
      'POST /allocations/apply cross-warehouse autoAllocate',
      /job warehouse/i
    );

    const beforeFilmBox = await getBoxState(client, orgId, jobBoxId);
    const beforeOtherBox = await getBoxState(client, orgId, otherBoxId);
    assertOkEnvelope(
      await apiPost(apiBaseUrl, '/allocations/apply', token, {
        jobId,
        jobNumber,
        boxId: jobBoxId,
        requestedFeet: 80,
        requestedWidthIn: 60,
        requirementId: createdFilmRequirement.requirementId,
        selectedSuggestionBoxIds: [],
        extraAllocations: [],
        crossWarehouse: true,
        jobWarehouse: otherWarehouse,
        autoAllocate: true,
      }),
      'POST /allocations/apply job-warehouse autoAllocate'
    );
    const filmApplyDetail = await getJobDetailById(apiBaseUrl, token, jobId);
    const filmRequirementAfterAllocate = findRequirement(
      filmApplyDetail,
      (entry) => entry.requirementId === createdFilmRequirement.requirementId,
      'film after allocate'
    );
    const afterFilmBox = await getBoxState(client, orgId, jobBoxId);
    const afterOtherBox = await getBoxState(client, orgId, otherBoxId);
    assert(integer(filmRequirementAfterAllocate.allocatedFeet) === 40, 'Manual film Auto Allocate should cover 40 LF from the job warehouse box.');
    assert(integer(filmRequirementAfterAllocate.remainingFeet) === 40, 'Manual film Auto Allocate should leave 40 LF remaining.');
    assert(afterFilmBox.activeAllocatedFeet === beforeFilmBox.activeAllocatedFeet + 40, 'Job-warehouse box active allocation should increase by 40 LF.');
    assert(afterFilmBox.allocatableNowFeet === Math.max(0, beforeFilmBox.allocatableNowFeet - 40), 'Job-warehouse box allocatable LF should decrease by 40.');
    assert(afterOtherBox.activeAllocatedFeet === beforeOtherBox.activeAllocatedFeet, 'Other-warehouse box should not be allocated.');
    assert(afterOtherBox.allocatableNowFeet === beforeOtherBox.allocatableNowFeet, 'Other-warehouse box allocatable LF should remain unchanged.');

    const beforeJobCaulkStock = await getCaulkStockState(client, orgId, productId, jobWarehouse);
    const beforeOtherCaulkStock = await getCaulkStockState(client, orgId, productId, otherWarehouse);
    assertOkEnvelope(
      await apiPost(apiBaseUrl, '/allocations/caulk/add', token, {
        jobId,
        jobNumber,
        requirementId: createdCaulkRequirement.requirementId,
        productId,
        warehouse: jobWarehouse,
        allocatedTubes: 5,
        notes: tag,
      }),
      'POST /allocations/caulk/add job warehouse'
    );
    const caulkApplyDetail = await getJobDetailById(apiBaseUrl, token, jobId);
    const caulkRequirementAfterAllocate = findCaulkRequirement(
      caulkApplyDetail,
      (entry) => entry.requirementId === createdCaulkRequirement.requirementId,
      'caulk after allocate'
    );
    const afterJobCaulkStock = await getCaulkStockState(client, orgId, productId, jobWarehouse);
    const afterOtherCaulkStock = await getCaulkStockState(client, orgId, productId, otherWarehouse);
    assert(integer(caulkRequirementAfterAllocate.allocatedTubes) === 5, 'Manual caulk Auto Allocate should reserve 5 tubes.');
    assert(integer(caulkRequirementAfterAllocate.remainingTubes) === 3, 'Manual caulk Auto Allocate should leave 3 tubes remaining.');
    assert(afterJobCaulkStock.tubesOnHand === Math.max(0, beforeJobCaulkStock.tubesOnHand - 5), 'Job-warehouse caulk stock should decrease by 5.');
    assert(afterJobCaulkStock.activeReservedTubes === beforeJobCaulkStock.activeReservedTubes + 5, 'Job-warehouse caulk reserved tubes should increase by 5.');
    assert(afterOtherCaulkStock.tubesOnHand === beforeOtherCaulkStock.tubesOnHand, 'Other-warehouse caulk stock should not be touched.');
    assert(afterOtherCaulkStock.activeReservedTubes === beforeOtherCaulkStock.activeReservedTubes, 'Other-warehouse caulk reserved tubes should not change.');

    const product2 = assertOkEnvelope(
      await apiPost(apiBaseUrl, '/caulk/products/upsert', token, {
        manufacturerId: manufacturer3m.manufacturerId,
        productName: `Codex Manual Only New Caulk ${suffix}`,
        productCode: `CMN-${suffix.slice(-8)}`,
        warehouse: jobWarehouse,
        tubesPerCase: 12,
        notes: tag,
      }),
      'POST /caulk/products/upsert second product'
    );
    const product2Id = asText(product2.productId);
    assert(product2Id, 'Second caulk product creation did not return productId.');
    await apiPost(apiBaseUrl, '/caulk/mutate', token, {
      action: 'RECEIVE',
      productId: product2Id,
      warehouse: jobWarehouse,
      deltaTubes: 4,
      reason: tag,
      notes: tag,
    }).then((response) => assertOkEnvelope(response, 'POST /caulk/mutate second product'));

    const beforeEditCounts = await getActiveAllocationCounts(client, orgId, jobId);
    const updateDetail = assertOkEnvelope(
      await apiPost(apiBaseUrl, '/jobs/update', token, {
        jobId,
        jobNumber,
        warehouse: jobWarehouse,
        installDate: today,
        crewLeader: `${tag} edit`,
        notes: `${tag} edit`,
        requirements: [
          {
            requirementId: createdFilmRequirement.requirementId,
            manufacturer: '3M Solar',
            filmName: 'Prestige 60',
            widthIn: 60,
            requiredFeet: 80,
          },
          {
            manufacturer: '3M Solar',
            filmName: 'Prestige 40',
            widthIn: 60,
            requiredFeet: 30,
          },
        ],
        caulkRequirements: [
          {
            requirementId: createdCaulkRequirement.requirementId,
            productId,
            requiredTubes: 8,
          },
          {
            productId: product2Id,
            requiredTubes: 4,
          },
        ],
      }),
      'POST /jobs/update'
    );
    const afterEditCounts = await getActiveAllocationCounts(client, orgId, jobId);
    const editedOriginalFilm = findRequirement(
      updateDetail,
      (entry) => entry.requirementId === createdFilmRequirement.requirementId,
      'edited original film'
    );
    const editedNewFilm = findRequirement(
      updateDetail,
      (entry) => asText(entry.filmName).toUpperCase().includes('PRESTIGE 40'),
      'new film'
    );
    const editedOriginalCaulk = findCaulkRequirement(
      updateDetail,
      (entry) => entry.requirementId === createdCaulkRequirement.requirementId,
      'edited original caulk'
    );
    const editedNewCaulk = findCaulkRequirement(
      updateDetail,
      (entry) => asText(entry.productId) === product2Id,
      'new caulk'
    );
    assert(afterEditCounts.filmActive === beforeEditCounts.filmActive, 'Job edit should preserve existing film allocations without adding new ones.');
    assert(afterEditCounts.caulkActive === beforeEditCounts.caulkActive, 'Job edit should preserve existing caulk allocations without adding new ones.');
    assert(afterEditCounts.filmAutoPlanned === 0, 'Job edit should not create AUTO_PLANNED film allocations.');
    assert(afterEditCounts.caulkAutoPlanned === 0, 'Job edit should not create AUTO_PLANNED caulk allocations.');
    assert(integer(editedOriginalFilm.allocatedFeet) === 40, 'Existing film allocation should remain on original requirement after edit.');
    assert(integer(editedOriginalFilm.remainingFeet) === 40, 'Original film remaining should stay 40 after edit.');
    assert(integer(editedNewFilm.allocatedFeet) === 0, 'New film requirement should not auto-allocate.');
    assert(integer(editedNewFilm.remainingFeet) === 30, 'New film requirement should show 30 LF remaining.');
    assert(integer(editedOriginalCaulk.allocatedTubes) === 5, 'Existing caulk allocation should remain after edit.');
    assert(integer(editedOriginalCaulk.remainingTubes) === 3, 'Original caulk remaining should stay 3 after edit.');
    assert(integer(editedNewCaulk.allocatedTubes) === 0, 'New caulk requirement should not auto-allocate.');
    assert(integer(editedNewCaulk.remainingTubes) === 4, 'New caulk requirement should show 4 tubes remaining.');

    const summary = {
      tag,
      jobNumber,
      jobId,
      jobWarehouse,
      otherWarehouse,
      productId,
      product2Id,
      boxes: {
        jobWarehouse: { before: beforeFilmBox, after: afterFilmBox },
        otherWarehouse: { before: beforeOtherBox, after: afterOtherBox },
      },
      creation: {
        filmActiveAllocations: afterCreateCounts.filmActive,
        caulkActiveAllocations: afterCreateCounts.caulkActive,
        filmRemainingFeet: integer(createdFilmRequirement.remainingFeet),
        caulkRemainingTubes: integer(createdCaulkRequirement.remainingTubes),
        plannerManualOnly: plannerNoopResult.manualOnly === true,
      },
      manualFilmAutoAllocate: {
        rejectedCrossWarehouseMessage,
        allocatedFeet: integer(filmRequirementAfterAllocate.allocatedFeet),
        remainingFeet: integer(filmRequirementAfterAllocate.remainingFeet),
      },
      manualCaulkAutoAllocate: {
        allocatedTubes: integer(caulkRequirementAfterAllocate.allocatedTubes),
        remainingTubes: integer(caulkRequirementAfterAllocate.remainingTubes),
        jobWarehouseStock: { before: beforeJobCaulkStock, after: afterJobCaulkStock },
        otherWarehouseStock: { before: beforeOtherCaulkStock, after: afterOtherCaulkStock },
      },
      editSave: {
        beforeCounts: beforeEditCounts,
        afterCounts: afterEditCounts,
        newFilmAllocatedFeet: integer(editedNewFilm.allocatedFeet),
        newFilmRemainingFeet: integer(editedNewFilm.remainingFeet),
        newCaulkAllocatedTubes: integer(editedNewCaulk.allocatedTubes),
        newCaulkRemainingTubes: integer(editedNewCaulk.remainingTubes),
      },
    };

    console.log('[manual-only-verification] PASS');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[manual-only-verification] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
