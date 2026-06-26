#!/usr/bin/env node

import crypto from 'node:crypto';

import {
  asText,
  loadDevFixtureConfig,
  normalizeFixtureTag,
  parseArgs,
} from './dev-fixtures/lib/dev-fixture-guard.mjs';
import { readManifest, writeManifest } from './dev-fixtures/lib/dev-fixture-manifest.mjs';

function assertOk(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function shortTag(tag) {
  return asText(tag).replace(/[^A-Z0-9]/gi, '').slice(-10);
}

function buildJobNumber(tag, offset = 0) {
  const digits = shortTag(tag).replace(/\D/g, '').slice(-6).padStart(6, '0');
  const base = Number(digits) || Math.floor(Math.random() * 900000) + 100000;
  return String(88_000_000 + ((base + offset) % 1_000_000));
}

function boxId(warehouse, token, tag) {
  return `${warehouse}-${token}-${shortTag(tag).slice(-7)}`.toUpperCase();
}

async function chooseWarehouse(client, orgId) {
  const result = await client.query(
    `
      select code::text as code
      from app.warehouses
      where org_id = $1::uuid
      order by case when upper(code::text) = 'IL1' then 0 else 1 end, code asc
      limit 1
    `,
    [orgId]
  );
  const warehouse = asText(result.rows[0]?.code).toUpperCase();
  assertOk(warehouse, 'No configured DEV warehouse was found.');
  return warehouse;
}

async function seedOwnerCompanies(client, orgId) {
  const result = await client.query(
    `
      select id::text as id, code::text as code, display_name::text as display_name, is_active
      from app.owner_companies
      where org_id = $1::uuid
        and lookup_key in ('mgt', 'edh', 'kam')
      order by code
    `,
    [orgId]
  );
  const byCode = new Map(result.rows.map((row) => [asText(row.code).toUpperCase(), row]));
  for (const code of ['MGT', 'EDH', 'KAM']) {
    assertOk(byCode.get(code)?.id, `Required seed owner company ${code} was not found.`);
    assertOk(byCode.get(code)?.is_active === true, `Required seed owner company ${code} is not active.`);
  }
  return byCode;
}

async function resolveOwnerUserId(client, orgId) {
  const result = await client.query(
    `
      select user_id::text as user_id
      from app.organization_members
      where org_id = $1::uuid
        and lower(role) = 'owner'
      order by created_at asc nulls first, user_id asc
      limit 1
    `,
    [orgId]
  );
  const userId = asText(result.rows[0]?.user_id);
  assertOk(userId, `No owner membership was found for org ${orgId}.`);
  return userId;
}

async function setRpcAuthContext(client, userId, email) {
  const claims = JSON.stringify({
    sub: userId,
    email,
    role: 'authenticated',
  });
  await client.query(
    `
      select
        set_config('request.jwt.claim.sub', $1::text, false),
        set_config('request.jwt.claim.role', 'authenticated', false),
        set_config('request.jwt.claim.email', $2::text, false),
        set_config('request.jwt.claims', $3::text, false)
    `,
    [userId, email, claims]
  );
}

async function expectFailure(client, label, callback, expectedMessage) {
  const savepointName = `sp_${label.replace(/[^a-z0-9_]+/gi, '_').slice(0, 40)}`;
  await client.query(`savepoint ${savepointName}`);
  try {
    await callback();
  } catch (error) {
    await client.query(`rollback to savepoint ${savepointName}`);
    await client.query(`release savepoint ${savepointName}`);
    const message = error instanceof Error ? error.message : String(error);
    if (expectedMessage) {
      assertOk(
        message.toLowerCase().includes(expectedMessage.toLowerCase()),
        `${label} failed with an unexpected message: ${message}`
      );
    }
    return message;
  }
  await client.query(`rollback to savepoint ${savepointName}`);
  await client.query(`release savepoint ${savepointName}`);
  throw new Error(`${label} unexpectedly succeeded.`);
}

async function ownerCompanyRpc(client, functionName, orgId, actor, payload) {
  const result = await client.query(
    `
      select public.${functionName}($1::uuid, $2::text, $3::jsonb) as result
    `,
    [orgId, actor, JSON.stringify(payload || {})]
  );
  return result.rows[0]?.result || null;
}

async function ownershipRpc(client, functionName, orgId, actor, payload) {
  const result = await client.query(
    `
      select public.${functionName}($1::uuid, $2::text, $3::jsonb) as result
    `,
    [orgId, actor, JSON.stringify(payload || {})]
  );
  return result.rows[0]?.result || null;
}

async function listOwnerCompanyRows(client, orgId, includeInactive) {
  const result = await client.query(
    `
      select *
      from public.api_acl_owner_companies_list($1::uuid, $2::boolean)
    `,
    [orgId, includeInactive]
  );
  return result.rows;
}

function buildBoxPayload({ boxId, warehouse, ownerCompanyId, tag, filmNameToken = 'Ownership Fixture', feet = 40 }) {
  const date = today();
  return {
    boxId,
    warehouse,
    ownerCompanyId,
    dealer: 'Codex Fixture Dealer',
    manufacturer: 'Codex Fixture',
    filmName: `${filmNameToken} ${shortTag(tag)}`,
    widthIn: 60,
    initialFeet: feet,
    orderDate: date,
    receivedDate: date,
    coreType: 'White plastic',
    initialWeightLbs: 20,
    lastRollWeightLbs: 20,
    lastWeighedDate: date,
    lotRun: tag,
    notes: tag,
    auditNote: tag,
  };
}

function buildJobPayload({ tag, warehouse, manufacturer, filmName }) {
  const installDate = addDays(today(), 3);
  return {
    jobNumber: buildJobNumber(tag, 1),
    warehouse,
    installDate,
    crewLeader: `Codex ${shortTag(tag)}`,
    workScope: tag,
    notes: tag,
    phases: [
      {
        phaseNumber: 1,
        workScope: tag,
        installDate,
        crewLeader: `Codex ${shortTag(tag)}`,
        workflowStatus: 'ACTIVE',
        requirements: [
          {
            manufacturer,
            filmName,
            widthIn: 60,
            requiredFeet: 5,
            notes: tag,
          },
        ],
      },
    ],
  };
}

async function fetchBoxSnapshot(client, orgId, boxIdValue) {
  const result = await client.query(
    `
      select
        box_id::text as box_id,
        warehouse::text as warehouse,
        status::text as status,
        owner_company_id::text as owner_company_id,
        initial_feet::integer as initial_feet,
        feet_available::integer as feet_available
      from app.boxes
      where org_id = $1::uuid
        and box_id = $2::text
      limit 1
    `,
    [orgId, boxIdValue]
  );
  return result.rows[0] || null;
}

async function fetchStockSnapshot(client, orgId, stockId) {
  const result = await client.query(
    `
      select
        id::text as stock_id,
        product_id::text as product_id,
        warehouse::text as warehouse,
        owner_company_id::text as owner_company_id,
        tubes_on_hand::integer as tubes_on_hand
      from app.caulk_stock
      where org_id = $1::uuid
        and id = $2::uuid
      limit 1
    `,
    [orgId, stockId]
  );
  return result.rows[0] || null;
}

async function fixtureCounts(client, orgId, tag, ids = {}) {
  const result = await client.query(
    `
      select jsonb_build_object(
        'ownerCompanies', (select count(*)::integer from app.owner_companies where org_id = $1::uuid and (id = any($2::uuid[]) or created_by = $9::text or updated_by = $9::text or display_name ilike ('%' || $9::text || '%'))),
        'boxes', (select count(*)::integer from app.boxes where org_id = $1::uuid and (box_id = any($3::text[]) or notes = $9::text or lot_run = $9::text)),
        'jobs', (select count(*)::integer from app.jobs where org_id = $1::uuid and (id = any($4::uuid[]) or job_number = any($5::text[]) or notes = $9::text or created_by = $9::text)),
        'allocations', (select count(*)::integer from app.caulk_job_allocations where org_id = $1::uuid and (id = any($6::uuid[]) or job_id = any($4::uuid[]) or notes = $9::text or created_by = $9::text)),
        'caulkManufacturers', (select count(*)::integer from app.caulk_manufacturers where org_id = $1::uuid and (id = any($7::uuid[]) or name ilike ('%' || $9::text || '%'))),
        'caulkProducts', (select count(*)::integer from app.caulk_products where org_id = $1::uuid and (id = any($8::uuid[]) or notes = $9::text)),
        'caulkStock', (select count(*)::integer from app.caulk_stock where org_id = $1::uuid and (id = any($10::uuid[]) or product_id = any($8::uuid[]))),
        'caulkTransactions', (select count(*)::integer from app.caulk_transactions where org_id = $1::uuid and (product_id = any($8::uuid[]) or notes = $9::text or source_box_id = $9::text)),
        'ownershipEvents', (select count(*)::integer from app.inventory_ownership_events where org_id = $1::uuid and (actor = $9::text or resource_id = any($3::text[]) or resource_id = any($10::text[]) or note = $9::text or batch_id = any($11::text[]))),
        'audit', (select count(*)::integer from app.audit_log where org_id = $1::uuid and (box_id = any($3::text[]) or actor = $9::text or notes = $9::text)),
        'members', (select count(*)::integer from app.organization_members where org_id = $1::uuid and user_id = any($12::uuid[]))
      ) as counts
    `,
    [
      orgId,
      ids.ownerCompanyIds || [],
      ids.boxIds || [],
      ids.jobIds || [],
      ids.jobNumbers || [],
      ids.caulkAllocationRowIds || [],
      ids.caulkManufacturerIds || [],
      ids.caulkProductIds || [],
      tag,
      ids.caulkStockIds || [],
      ids.batchIds || [],
      ids.memberUserIds || [],
    ]
  );
  return result.rows[0]?.counts || {};
}

async function cleanupInventoryOwnershipFixture(client, orgId, tag, ids = {}) {
  const statements = [
    {
      label: 'inventory_ownership_events',
      sql: `delete from app.inventory_ownership_events where org_id = $1::uuid and (actor = $2::text or resource_id = any($3::text[]) or resource_id = any($4::text[]) or note = $2::text or batch_id = any($5::text[]))`,
      params: [orgId, tag, ids.boxIds || [], ids.caulkStockIds || [], ids.batchIds || []],
    },
    {
      label: 'audit_log',
      sql: `delete from app.audit_log where org_id = $1::uuid and (box_id = any($2::text[]) or actor = $3::text or notes = $3::text)`,
      params: [orgId, ids.boxIds || [], tag],
    },
    {
      label: 'caulk_job_allocations',
      sql: `delete from app.caulk_job_allocations where org_id = $1::uuid and (id = any($2::uuid[]) or job_id = any($3::uuid[]) or notes = $4::text or created_by = $4::text)`,
      params: [orgId, ids.caulkAllocationRowIds || [], ids.jobIds || [], tag],
    },
    {
      label: 'caulk_transactions',
      sql: `delete from app.caulk_transactions where org_id = $1::uuid and (product_id = any($2::uuid[]) or notes = $3::text or source_box_id = $3::text)`,
      params: [orgId, ids.caulkProductIds || [], tag],
    },
    {
      label: 'caulk_stock',
      sql: `delete from app.caulk_stock where org_id = $1::uuid and (id = any($2::uuid[]) or product_id = any($3::uuid[]))`,
      params: [orgId, ids.caulkStockIds || [], ids.caulkProductIds || []],
    },
    {
      label: 'caulk_products',
      sql: `delete from app.caulk_products where org_id = $1::uuid and (id = any($2::uuid[]) or notes = $3::text)`,
      params: [orgId, ids.caulkProductIds || [], tag],
    },
    {
      label: 'caulk_manufacturers',
      sql: `delete from app.caulk_manufacturers where org_id = $1::uuid and (id = any($2::uuid[]) or name ilike ('%' || $3::text || '%'))`,
      params: [orgId, ids.caulkManufacturerIds || [], tag],
    },
    {
      label: 'film_catalog',
      sql: `delete from app.film_catalog where org_id = $1::uuid and (source_box_id = any($2::text[]) or notes = $3::text)`,
      params: [orgId, ids.boxIds || [], tag],
    },
    {
      label: 'roll_weight_log',
      sql: `delete from app.roll_weight_log where org_id = $1::uuid and (box_id = any($2::text[]) or job_id = any($3::uuid[]) or job_number = any($4::text[]) or notes = $5::text)`,
      params: [orgId, ids.boxIds || [], ids.jobIds || [], ids.jobNumbers || [], tag],
    },
    {
      label: 'allocations',
      sql: `delete from app.allocations where org_id = $1::uuid and (job_id = any($2::uuid[]) or box_id = any($3::text[]) or notes = $4::text or created_by = $4::text)`,
      params: [orgId, ids.jobIds || [], ids.boxIds || [], tag],
    },
    {
      label: 'job_requirements',
      sql: `delete from app.job_requirements where org_id = $1::uuid and (job_id = any($2::uuid[]) or notes = $3::text or created_by = $3::text)`,
      params: [orgId, ids.jobIds || [], tag],
    },
    {
      label: 'job_caulk_requirements',
      sql: `delete from app.job_caulk_requirements where org_id = $1::uuid and job_id = any($2::uuid[])`,
      params: [orgId, ids.jobIds || []],
    },
    {
      label: 'job_phases',
      sql: `delete from app.job_phases where org_id = $1::uuid and (job_id = any($2::uuid[]) or sections = $3::text or created_by = $3::text)`,
      params: [orgId, ids.jobIds || [], tag],
    },
    {
      label: 'jobs',
      sql: `delete from app.jobs where org_id = $1::uuid and (id = any($2::uuid[]) or job_number = any($3::text[]) or notes = $4::text or created_by = $4::text)`,
      params: [orgId, ids.jobIds || [], ids.jobNumbers || [], tag],
    },
    {
      label: 'boxes',
      sql: `delete from app.boxes where org_id = $1::uuid and (box_id = any($2::text[]) or notes = $3::text or lot_run = $3::text)`,
      params: [orgId, ids.boxIds || [], tag],
    },
    {
      label: 'owner_companies',
      sql: `delete from app.owner_companies where org_id = $1::uuid and (id = any($2::uuid[]) or created_by = $3::text or updated_by = $3::text or display_name ilike ('%' || $3::text || '%')) and lookup_key not in ('mgt', 'edh', 'kam')`,
      params: [orgId, ids.ownerCompanyIds || [], tag],
    },
    {
      label: 'access_requests',
      sql: `delete from app.access_requests where org_id = $1::uuid and user_id = any($2::uuid[])`,
      params: [orgId, ids.memberUserIds || []],
    },
    {
      label: 'organization_members',
      sql: `delete from app.organization_members where org_id = $1::uuid and user_id = any($2::uuid[])`,
      params: [orgId, ids.memberUserIds || []],
    },
  ];

  const deleted = {};
  for (const statement of statements) {
    const result = await client.query(statement.sql, statement.params);
    const label = statement.label;
    deleted[label] = (deleted[label] || 0) + integer(result.rowCount);
  }
  return deleted;
}

async function verifyInventoryOwnership(config, { tag, keep }) {
  const {
    withMutation,
    queryRow,
  } = await import('../src/db/client.mjs');
  const { createJob } = await import('../src/app/services/jobs.mjs');
  const { addBox } = await import('../src/app/services/boxes.mjs');
  const {
    ownerUpsertCaulkManufacturer,
    upsertCaulkProduct,
    mutateCaulkStock,
    listCaulkStock,
  } = await import('../src/app/services/caulk.mjs');
  const { addCaulkAllocation } = await import('../src/app/services/caulkAllocations.mjs');

  return withMutation(async (client) => {
    const ids = {
      ownerCompanyIds: [],
      boxIds: [],
      jobIds: [],
      jobNumbers: [],
      caulkAllocationRowIds: [],
      caulkManufacturerIds: [],
      caulkProductIds: [],
      caulkStockIds: [],
      batchIds: [],
      memberUserIds: [],
    };

    await cleanupInventoryOwnershipFixture(client, config.orgId, tag, ids);

    const seedOwners = await seedOwnerCompanies(client, config.orgId);
    const mgt = seedOwners.get('MGT');
    const edh = seedOwners.get('EDH');
    const kam = seedOwners.get('KAM');
    const warehouse = await chooseWarehouse(client, config.orgId);
    const actor = tag;
    const suffix = shortTag(tag).replace(/\D/g, '').slice(-8).padStart(8, '0');
    const ownerUserId = await resolveOwnerUserId(client, config.orgId);
    const memberUserId = crypto.randomUUID();
    ids.memberUserIds.push(memberUserId);
    await client.query(
      `
        insert into app.organization_members (org_id, user_id, role)
        values ($1::uuid, $2::uuid, 'member')
        on conflict (org_id, user_id) do update set role = 'member'
      `,
      [config.orgId, memberUserId]
    );

    await setRpcAuthContext(client, memberUserId, `codex-member-${suffix}@example.local`);
    const nonOwnerDeniedMessage = await expectFailure(
      client,
      'non_owner_owner_company_upsert',
      () =>
        ownerCompanyRpc(client, 'api_acl_owner_companies_upsert', config.orgId, actor, {
          code: `NX${suffix}`,
          displayName: `Denied ${tag}`,
        }),
      'Owner access is required'
    );

    await setRpcAuthContext(client, ownerUserId, `codex-owner-${suffix}@example.local`);
    const activeOwnerRaw = await ownerCompanyRpc(client, 'api_acl_owner_companies_upsert', config.orgId, actor, {
      code: `CX${suffix}`,
      displayName: `Codex Fixture Owner ${suffix}`,
    });
    const retiredOwnerRaw = await ownerCompanyRpc(client, 'api_acl_owner_companies_upsert', config.orgId, actor, {
      code: `CR${suffix}`,
      displayName: `Codex Retired Owner ${suffix}`,
    });
    ids.ownerCompanyIds.push(activeOwnerRaw.id, retiredOwnerRaw.id);

    const activeOwners = await listOwnerCompanyRows(client, config.orgId, false);
    assertOk(activeOwners.some((row) => row.id === activeOwnerRaw.id), 'New active owner was not selectable.');

    const filmBox = boxId(warehouse, 'COWN', tag);
    ids.boxIds.push(filmBox);
    await expectFailure(
      client,
      'add_box_without_owner',
      () =>
        addBox(
          client,
          config.orgId,
          buildBoxPayload({
            boxId: boxId(warehouse, 'CMISS', tag),
            warehouse,
            ownerCompanyId: '',
            tag,
          }),
          actor
        ),
      'OwnerCompanyId'
    );
    const addedBox = await addBox(
      client,
      config.orgId,
      buildBoxPayload({ boxId: filmBox, warehouse, ownerCompanyId: mgt.id, tag }),
      actor
    );
    assertOk(addedBox.data?.box?.ownerCompanyCode === 'MGT' || addedBox.ownerCompanyCode === 'MGT', 'Added box did not use MGT owner.');

    const retiredBox = boxId(warehouse, 'CRET', tag);
    ids.boxIds.push(retiredBox);
    await addBox(
      client,
      config.orgId,
      buildBoxPayload({
        boxId: retiredBox,
        warehouse,
        ownerCompanyId: retiredOwnerRaw.id,
        tag,
        filmNameToken: 'Retired Owner Display',
      }),
      actor
    );

    const beforeFilm = await fetchBoxSnapshot(client, config.orgId, filmBox);
    const filmChange = await ownershipRpc(client, 'api_acl_inventory_ownership_update_box', config.orgId, actor, {
      boxId: filmBox,
      ownerCompanyId: activeOwnerRaw.id,
      note: tag,
    });
    ids.batchIds.push(asText(filmChange?.batchId));
    const afterFilm = await fetchBoxSnapshot(client, config.orgId, filmBox);
    assertOk(filmChange?.changedCount === 1, 'Film owner change did not report one changed item.');
    assertOk(afterFilm.owner_company_id === activeOwnerRaw.id, 'Film owner change did not persist.');
    assertOk(afterFilm.warehouse === beforeFilm.warehouse, 'Film owner change altered warehouse.');
    assertOk(afterFilm.status === beforeFilm.status, 'Film owner change altered status.');
    assertOk(afterFilm.feet_available === beforeFilm.feet_available, 'Film owner change altered LF.');

    await ownerCompanyRpc(client, 'api_acl_owner_companies_deactivate', config.orgId, actor, {
      ownerCompanyId: retiredOwnerRaw.id,
    });
    const inactiveIncluded = await listOwnerCompanyRows(client, config.orgId, true);
    const activeAfterDeactivate = await listOwnerCompanyRows(client, config.orgId, false);
    assertOk(inactiveIncluded.some((row) => row.id === retiredOwnerRaw.id && row.is_active === false), 'Deactivated owner was not visible when inactive owners were included.');
    assertOk(!activeAfterDeactivate.some((row) => row.id === retiredOwnerRaw.id), 'Deactivated owner remained selectable in the active list.');

    const retiredBoxDisplay = await queryRow(
      client,
      `
        select b.box_id::text, oc.code::text as owner_code, oc.is_active
        from app.boxes b
        join app.owner_companies oc
          on oc.org_id = b.org_id
         and oc.id = b.owner_company_id
        where b.org_id = $1::uuid
          and b.box_id = $2::text
        limit 1
      `,
      [config.orgId, retiredBox]
    );
    assertOk(retiredBoxDisplay?.owner_code === asText(retiredOwnerRaw.code), 'Existing inventory did not retain deactivated owner display.');
    assertOk(retiredBoxDisplay?.is_active === false, 'Existing inventory owner did not show inactive state.');

    const bulkFilmBox = boxId(warehouse, 'CBULK', tag);
    ids.boxIds.push(bulkFilmBox);
    await addBox(
      client,
      config.orgId,
      buildBoxPayload({
        boxId: bulkFilmBox,
        warehouse,
        ownerCompanyId: mgt.id,
        tag,
        filmNameToken: 'Bulk Ownership Film',
      }),
      actor
    );

    const manufacturer = await ownerUpsertCaulkManufacturer(client, config.orgId, actor, {
      name: `Codex ${tag} Caulk`,
      isActive: true,
    });
    ids.caulkManufacturerIds.push(manufacturer.manufacturerId);

    const product = await upsertCaulkProduct(client, config.orgId, actor, {
      manufacturerId: manufacturer.manufacturerId,
      productName: `Ownership Caulk ${shortTag(tag)}`,
      productCode: `OWN-${suffix.slice(-6)}`,
      tubesPerCase: 12,
      warehouse,
      ownerCompanyId: mgt.id,
      notes: tag,
    });
    ids.caulkProductIds.push(product.productId);

    await mutateCaulkStock(client, config.orgId, actor, {
      productId: product.productId,
      warehouse,
      ownerCompanyId: mgt.id,
      action: 'RECEIVE',
      cases: 0,
      tubes: 10,
      reason: tag,
      notes: tag,
    });
    await mutateCaulkStock(client, config.orgId, actor, {
      productId: product.productId,
      warehouse,
      ownerCompanyId: edh.id,
      action: 'RECEIVE',
      cases: 0,
      tubes: 8,
      reason: tag,
      notes: tag,
    });
    const caulkRows = await listCaulkStock(client, config.orgId, { productId: product.productId, warehouse });
    const mgtStock = caulkRows.find((row) => row.ownerCompanyCode === 'MGT');
    const edhStock = caulkRows.find((row) => row.ownerCompanyCode === 'EDH');
    assertOk(mgtStock?.stockId && edhStock?.stockId, 'Expected separate MGT and EDH caulk owner rows.');
    ids.caulkStockIds.push(mgtStock.stockId, edhStock.stockId);

    const job = await createJob(
      client,
      config.orgId,
      buildJobPayload({
        tag,
        warehouse,
        manufacturer: 'Codex Fixture',
        filmName: `Ownership Fixture ${shortTag(tag)}`,
      }),
      actor
    );
    ids.jobIds.push(job.data.summary.jobId);
    ids.jobNumbers.push(job.data.summary.jobNumber);

    await setRpcAuthContext(client, ownerUserId, `codex-owner-${suffix}@example.local`);
    const ambiguousCaulkMessage = await expectFailure(
      client,
      'ambiguous_caulk_allocation',
      () =>
        addCaulkAllocation(
          client,
          config.orgId,
          actor,
          {
            jobId: job.data.summary.jobId,
            jobNumber: job.data.summary.jobNumber,
            productId: product.productId,
            warehouse,
            allocatedTubes: 1,
            notes: tag,
          }
        ),
      'Multiple owner rows exist'
    );

    const beforeMgtStock = await fetchStockSnapshot(client, config.orgId, mgtStock.stockId);
    const beforeEdhStock = await fetchStockSnapshot(client, config.orgId, edhStock.stockId);
    const allocationResult = await addCaulkAllocation(
      client,
      config.orgId,
      actor,
      {
        jobId: job.data.summary.jobId,
        jobNumber: job.data.summary.jobNumber,
        productId: product.productId,
        warehouse,
        stockId: mgtStock.stockId,
        allocatedTubes: 2,
        notes: tag,
      }
    );
    const allocationId =
      allocationResult?.result?.caulkAllocationId ||
      allocationResult?.data?.caulkAllocationId ||
      allocationResult?.caulkAllocationId;
    assertOk(allocationId, 'Caulk allocation mutation returned no allocation identifier.');
    const allocationRow = await queryRow(
      client,
      `
        select id::text as id, owner_company_id::text as owner_company_id
        from app.caulk_job_allocations
        where org_id = $1::uuid
          and caulk_allocation_id = $2::text
        limit 1
      `,
      [config.orgId, allocationId]
    );
    ids.caulkAllocationRowIds.push(allocationRow.id);
    const afterMgtStock = await fetchStockSnapshot(client, config.orgId, mgtStock.stockId);
    const afterEdhStock = await fetchStockSnapshot(client, config.orgId, edhStock.stockId);
    assertOk(allocationRow.owner_company_id === mgt.id, 'Caulk allocation did not retain selected owner row.');
    assertOk(afterMgtStock.tubes_on_hand === beforeMgtStock.tubes_on_hand - 2, 'Selected MGT stock row was not decremented.');
    assertOk(afterEdhStock.tubes_on_hand === beforeEdhStock.tubes_on_hand, 'Unselected EDH stock row changed.');

    const beforeEdhOwnerChange = await fetchStockSnapshot(client, config.orgId, edhStock.stockId);
    const caulkOwnerChange = await ownershipRpc(client, 'api_acl_inventory_ownership_update_caulk_stock', config.orgId, actor, {
      stockId: edhStock.stockId,
      ownerCompanyId: activeOwnerRaw.id,
      note: tag,
    });
    ids.batchIds.push(asText(caulkOwnerChange?.batchId));
    const afterEdhOwnerChange = await fetchStockSnapshot(client, config.orgId, edhStock.stockId);
    assertOk(caulkOwnerChange?.changedCount === 1, 'Caulk owner change did not report one changed item.');
    assertOk(afterEdhOwnerChange.owner_company_id === activeOwnerRaw.id, 'Caulk owner change did not persist.');
    assertOk(afterEdhOwnerChange.tubes_on_hand === beforeEdhOwnerChange.tubes_on_hand, 'Caulk owner change altered tubes.');

    const bulkProduct = await upsertCaulkProduct(client, config.orgId, actor, {
      manufacturerId: manufacturer.manufacturerId,
      productName: `Bulk Ownership Caulk ${shortTag(tag)}`,
      productCode: `OBK-${suffix.slice(-6)}`,
      tubesPerCase: 12,
      warehouse,
      ownerCompanyId: mgt.id,
      notes: tag,
    });
    ids.caulkProductIds.push(bulkProduct.productId);
    await mutateCaulkStock(client, config.orgId, actor, {
      productId: bulkProduct.productId,
      warehouse,
      ownerCompanyId: mgt.id,
      action: 'RECEIVE',
      cases: 0,
      tubes: 5,
      reason: tag,
      notes: tag,
    });
    const bulkStock = (await listCaulkStock(client, config.orgId, { productId: bulkProduct.productId, warehouse }))
      .find((row) => row.ownerCompanyCode === 'MGT');
    assertOk(bulkStock?.stockId, 'Bulk transfer caulk stock row was not created.');
    ids.caulkStockIds.push(bulkStock.stockId);

    const bulkResult = await ownershipRpc(client, 'api_acl_inventory_ownership_bulk_transfer', config.orgId, actor, {
      filmBoxIds: [bulkFilmBox],
      caulkStockIds: [bulkStock.stockId],
      ownerCompanyId: kam.id,
      note: tag,
    });
    ids.batchIds.push(asText(bulkResult?.batchId));
    assertOk(bulkResult?.changedCount === 2, 'Bulk ownership transfer did not update exactly two items.');
    const bulkFilmAfter = await fetchBoxSnapshot(client, config.orgId, bulkFilmBox);
    const bulkStockAfter = await fetchStockSnapshot(client, config.orgId, bulkStock.stockId);
    assertOk(bulkFilmAfter.owner_company_id === kam.id, 'Bulk film owner did not change to KAM.');
    assertOk(bulkStockAfter.owner_company_id === kam.id, 'Bulk caulk owner did not change to KAM.');
    assertOk(bulkStockAfter.tubes_on_hand === 5, 'Bulk caulk ownership transfer altered tubes.');

    const eventResult = await client.query(
      `
        select
          count(*)::integer as total_events,
          count(*) filter (where resource_type = 'film_box')::integer as film_events,
          count(*) filter (where resource_type = 'caulk_stock')::integer as caulk_events,
          count(distinct batch_id)::integer as batch_count
        from app.inventory_ownership_events
        where org_id = $1::uuid
          and (actor = $2::text or batch_id = any($3::text[]))
      `,
      [config.orgId, tag, ids.batchIds]
    );
    const auditResult = await client.query(
      `
        select count(*)::integer as owner_change_audits
        from app.audit_log
        where org_id = $1::uuid
          and action = 'OWNER_CHANGE'
          and box_id = any($2::text[])
      `,
      [config.orgId, ids.boxIds]
    );
    assertOk(integer(eventResult.rows[0]?.total_events) >= 4, 'Expected ownership events were not recorded.');
    assertOk(integer(eventResult.rows[0]?.film_events) >= 2, 'Expected film ownership events were not recorded.');
    assertOk(integer(eventResult.rows[0]?.caulk_events) >= 2, 'Expected caulk ownership events were not recorded.');
    assertOk(integer(auditResult.rows[0]?.owner_change_audits) >= 2, 'Expected film OWNER_CHANGE audit entries were not recorded.');

    const beforeCleanupCounts = await fixtureCounts(client, config.orgId, tag, ids);
    const evidence = {
      seedOwners: ['MGT', 'EDH', 'KAM'],
      ownerCompanies: {
        createdActiveCode: asText(activeOwnerRaw.code),
        deactivatedCode: asText(retiredOwnerRaw.code),
        activeOwnerSelectable: true,
        deactivatedOwnerSelectable: false,
        deactivatedOwnerStillDisplays: true,
      },
      permissions: {
        nonOwnerDeniedMessage,
        ownerRpcSucceeded: true,
      },
      film: {
        addBoxOwnerRequired: true,
        boxId: filmBox,
        ownerBefore: 'MGT',
        ownerAfter: asText(activeOwnerRaw.code),
        unchanged: {
          warehouse: afterFilm.warehouse === beforeFilm.warehouse,
          status: afterFilm.status === beforeFilm.status,
          feetAvailable: afterFilm.feet_available === beforeFilm.feet_available,
        },
      },
      caulk: {
        productId: product.productId,
        ownerRows: [
          { stockId: mgtStock.stockId, owner: 'MGT' },
          { stockId: edhStock.stockId, owner: 'EDH' },
        ],
        ambiguousMutationBlocked: ambiguousCaulkMessage,
        exactRowMutation: {
          selectedOwner: 'MGT',
          selectedBeforeTubes: beforeMgtStock.tubes_on_hand,
          selectedAfterTubes: afterMgtStock.tubes_on_hand,
          unselectedBeforeTubes: beforeEdhStock.tubes_on_hand,
          unselectedAfterTubes: afterEdhStock.tubes_on_hand,
        },
        ownerChange: {
          stockId: edhStock.stockId,
          beforeOwner: 'EDH',
          afterOwner: asText(activeOwnerRaw.code),
          tubesUnchanged: afterEdhOwnerChange.tubes_on_hand === beforeEdhOwnerChange.tubes_on_hand,
        },
      },
      bulkTransfer: {
        batchId: bulkResult.batchId,
        changedCount: bulkResult.changedCount,
        filmBoxId: bulkFilmBox,
        caulkStockId: bulkStock.stockId,
        targetOwner: 'KAM',
      },
      audit: {
        ownershipEvents: integer(eventResult.rows[0]?.total_events),
        filmEvents: integer(eventResult.rows[0]?.film_events),
        caulkEvents: integer(eventResult.rows[0]?.caulk_events),
        ownerChangeAuditEntries: integer(auditResult.rows[0]?.owner_change_audits),
      },
      counts: beforeCleanupCounts,
    };

    const manifest = {
      tag,
      scenario: 'inventory-ownership',
      createdAt: new Date().toISOString(),
      projectRef: config.projectRef,
      orgId: config.orgId,
      ids,
      routes: {
        boxDetails: ids.boxIds.map((entry) => `/#/inventory/${encodeURIComponent(entry)}`),
        caulkDetails: ids.caulkStockIds.map((entry) => `/#/caulk/stock/${encodeURIComponent(entry)}`),
        ownerCompanies: '/#/owner/companies',
        bulkOwnershipTransfer: '/#/owner/bulk-ownership-transfer',
      },
      summary: evidence,
    };

    let cleanup = null;
    if (!keep) {
      const deleted = await cleanupInventoryOwnershipFixture(client, config.orgId, tag, ids);
      const after = await fixtureCounts(client, config.orgId, tag, ids);
      cleanup = {
        ok: Object.values(after).every((value) => integer(value) === 0),
        deleted,
        after,
      };
      assertOk(cleanup.ok, 'Inventory ownership fixture cleanup left residue.');
    }

    return {
      ok: true,
      projectRef: config.projectRef,
      tag,
      ids,
      routes: manifest.routes,
      evidence,
      cleanup,
      manifest,
    };
  });
}

async function cleanupOnly(config, tag) {
  const {
    withMutation,
  } = await import('../src/db/client.mjs');

  return withMutation(async (client) => {
    const { manifest } = readManifest(config, tag);
    const ids = manifest?.ids || {};
    const before = await fixtureCounts(client, config.orgId, tag, ids);
    const deleted = await cleanupInventoryOwnershipFixture(client, config.orgId, tag, ids);
    const after = await fixtureCounts(client, config.orgId, tag, ids);
    const ok = Object.values(after).every((value) => integer(value) === 0);
    return {
      ok,
      projectRef: config.projectRef,
      tag,
      before,
      deleted,
      after,
    };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(`Usage:
  node backend/scripts/verify-inventory-ownership-dev.mjs [--tag CODEX_DEV_FIXTURE_INVENTORY_OWNERSHIP_...] [--keep]
  node backend/scripts/verify-inventory-ownership-dev.mjs --cleanup --tag CODEX_DEV_FIXTURE_INVENTORY_OWNERSHIP_...`);
    return;
  }

  const tag = normalizeFixtureTag(args.tag, 'inventory-ownership');
  const config = loadDevFixtureConfig(args);

  if (args.cleanup) {
    const result = await cleanupOnly(config, tag);
    console.log(JSON.stringify({
      ok: result.ok,
      action: 'cleanup',
      projectRef: result.projectRef,
      tag: result.tag,
      before: result.before,
      deleted: result.deleted,
      after: result.after,
    }, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  const result = await verifyInventoryOwnership(config, { tag, keep: Boolean(args.keep) });
  let manifestPath = '';
  if (args.keep) {
    const written = writeManifest(config, result.manifest);
    manifestPath = written.manifestPath.replace(/\\/g, '/');
  }
  console.log(JSON.stringify({
    ok: result.ok,
    action: 'verify',
    keptForBrowser: Boolean(args.keep),
    projectRef: result.projectRef,
    tag: result.tag,
    manifestPath,
    ids: result.ids,
    routes: result.routes,
    evidence: result.evidence,
    cleanup: result.cleanup,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack || error.message) : error);
  process.exit(1);
});
