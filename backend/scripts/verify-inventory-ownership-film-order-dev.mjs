#!/usr/bin/env node

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

function buildJobNumber(tag) {
  const digits = shortTag(tag).replace(/\D/g, '').slice(-6).padStart(6, '0');
  const base = Number(digits) || Math.floor(Math.random() * 900000) + 100000;
  return String(97_000_000 + (base % 1_000_000));
}

function buildBoxId(warehouse, token, tag) {
  return `${warehouse}-${token}-${shortTag(tag).slice(-7)}`.toUpperCase();
}

function buildFilmOrderDetailsRoute(filmOrderId) {
  return `/#/film-orders/${encodeURIComponent(filmOrderId)}`;
}

function buildAddBoxIntakeRoute(order, workScope) {
  const params = new URLSearchParams({
    filmOrderId: order.filmOrderId,
    jobNumber: order.jobNumber,
    jobId: order.jobId,
    warehouse: order.warehouse,
    manufacturer: order.manufacturer,
    filmName: order.filmName,
    width: String(order.widthIn),
    remainingToOrderFeet: String(Math.max(order.remainingToOrderFeet, 0)),
    notes: `Ordered for job ${order.jobNumber} via ${order.filmOrderId}`,
    workScope,
  });

  return `/#/inventory/add?${params.toString()}`;
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

async function ownerCompanyRpc(client, functionName, orgId, actor, payload) {
  const result = await client.query(
    `
      select public.${functionName}($1::uuid, $2::text, $3::jsonb) as result
    `,
    [orgId, actor, JSON.stringify(payload || {})]
  );
  return result.rows[0]?.result || null;
}

async function fetchFixtureCounts(client, orgId, tag, ids = {}, summary = {}) {
  const ownerCompanyIds = summary.ownerCompanies?.createdIds || [];
  const result = await client.query(
    `
      select jsonb_build_object(
        'ownerCompanies', (
          select count(*)::integer
          from app.owner_companies
          where org_id = $1::uuid
            and (
              id = any($2::uuid[])
              or created_by = $9::text
              or updated_by = $9::text
              or display_name ilike ('%' || $9::text || '%')
            )
        ),
        'boxes', (
          select count(*)::integer
          from app.boxes
          where org_id = $1::uuid
            and (box_id = any($3::text[]) or notes = $9::text or lot_run = $9::text)
        ),
        'filmOrders', (
          select count(*)::integer
          from app.film_orders
          where org_id = $1::uuid
            and (film_order_id = any($4::text[]) or job_id = any($5::uuid[]) or created_by = $9::text)
        ),
        'filmOrderLinks', (
          select count(*)::integer
          from app.film_order_box_links
          where org_id = $1::uuid
            and (film_order_id = any($4::text[]) or box_id = any($3::text[]) or created_by = $9::text)
        ),
        'filmOrderEvents', (
          select count(*)::integer
          from app.film_order_events
          where org_id = $1::uuid
            and (film_order_id = any($4::text[]) or related_box_id = any($3::text[]) or actor = $9::text)
        ),
        'allocations', (
          select count(*)::integer
          from app.allocations
          where org_id = $1::uuid
            and (job_id = any($5::uuid[]) or box_id = any($3::text[]) or notes = $9::text or created_by = $9::text)
        ),
        'jobs', (
          select count(*)::integer
          from app.jobs
          where org_id = $1::uuid
            and (id = any($5::uuid[]) or job_number = any($6::text[]) or notes = $9::text or created_by = $9::text)
        ),
        'jobRequirements', (
          select count(*)::integer
          from app.job_requirements
          where org_id = $1::uuid
            and (job_id = any($5::uuid[]) or id = any($7::uuid[]) or notes = $9::text or created_by = $9::text)
        ),
        'jobPhases', (
          select count(*)::integer
          from app.job_phases
          where org_id = $1::uuid
            and (job_id = any($5::uuid[]) or id = any($8::uuid[]) or sections = $9::text or created_by = $9::text)
        ),
        'filmCatalog', (
          select count(*)::integer
          from app.film_catalog
          where org_id = $1::uuid
            and (source_box_id = any($3::text[]) or notes = $9::text)
        ),
        'rollWeightLog', (
          select count(*)::integer
          from app.roll_weight_log
          where org_id = $1::uuid
            and (box_id = any($3::text[]) or job_id = any($5::uuid[]) or job_number = any($6::text[]) or notes = $9::text)
        ),
        'auditLog', (
          select count(*)::integer
          from app.audit_log
          where org_id = $1::uuid
            and (box_id = any($3::text[]) or actor = $9::text or notes = $9::text)
        )
      ) as counts
    `,
    [
      orgId,
      ownerCompanyIds,
      ids.boxIds || [],
      ids.filmOrderIds || [],
      ids.jobIds || [],
      ids.jobNumbers || [],
      ids.requirementIds || [],
      ids.phaseIds || [],
      tag,
    ]
  );

  return result.rows[0]?.counts || {};
}

async function cleanupFilmOrderFixture(client, orgId, tag, ids = {}, summary = {}) {
  const ownerCompanyIds = summary.ownerCompanies?.createdIds || [];
  const statements = [
    {
      label: 'film_order_events_pre',
      sql: `delete from app.film_order_events where org_id = $1::uuid and (film_order_id = any($2::text[]) or related_box_id = any($3::text[]) or actor = $4::text)`,
      params: [orgId, ids.filmOrderIds || [], ids.boxIds || [], tag],
    },
    {
      label: 'film_order_box_links',
      sql: `delete from app.film_order_box_links where org_id = $1::uuid and (film_order_id = any($2::text[]) or box_id = any($3::text[]) or created_by = $4::text)`,
      params: [orgId, ids.filmOrderIds || [], ids.boxIds || [], tag],
    },
    {
      label: 'allocations',
      sql: `delete from app.allocations where org_id = $1::uuid and (job_id = any($2::uuid[]) or box_id = any($3::text[]) or notes = $4::text or created_by = $4::text)`,
      params: [orgId, ids.jobIds || [], ids.boxIds || [], tag],
    },
    {
      label: 'roll_weight_log',
      sql: `delete from app.roll_weight_log where org_id = $1::uuid and (box_id = any($2::text[]) or job_id = any($3::uuid[]) or job_number = any($4::text[]) or notes = $5::text)`,
      params: [orgId, ids.boxIds || [], ids.jobIds || [], ids.jobNumbers || [], tag],
    },
    {
      label: 'audit_log',
      sql: `delete from app.audit_log where org_id = $1::uuid and (box_id = any($2::text[]) or actor = $3::text or notes = $3::text)`,
      params: [orgId, ids.boxIds || [], tag],
    },
    {
      label: 'film_catalog',
      sql: `delete from app.film_catalog where org_id = $1::uuid and (source_box_id = any($2::text[]) or notes = $3::text)`,
      params: [orgId, ids.boxIds || [], tag],
    },
    {
      label: 'boxes',
      sql: `delete from app.boxes where org_id = $1::uuid and (box_id = any($2::text[]) or notes = $3::text or lot_run = $3::text)`,
      params: [orgId, ids.boxIds || [], tag],
    },
    {
      label: 'film_orders',
      sql: `delete from app.film_orders where org_id = $1::uuid and (film_order_id = any($2::text[]) or job_id = any($3::uuid[]) or created_by = $4::text)`,
      params: [orgId, ids.filmOrderIds || [], ids.jobIds || [], tag],
    },
    {
      label: 'film_order_events_post',
      sql: `delete from app.film_order_events where org_id = $1::uuid and (film_order_id = any($2::text[]) or related_box_id = any($3::text[]) or actor = $4::text)`,
      params: [orgId, ids.filmOrderIds || [], ids.boxIds || [], tag],
    },
    {
      label: 'job_requirements',
      sql: `delete from app.job_requirements where org_id = $1::uuid and (job_id = any($2::uuid[]) or id = any($3::uuid[]) or notes = $4::text or created_by = $4::text)`,
      params: [orgId, ids.jobIds || [], ids.requirementIds || [], tag],
    },
    {
      label: 'job_caulk_requirements',
      sql: `delete from app.job_caulk_requirements where org_id = $1::uuid and job_id = any($2::uuid[])`,
      params: [orgId, ids.jobIds || []],
    },
    {
      label: 'job_phases',
      sql: `delete from app.job_phases where org_id = $1::uuid and (job_id = any($2::uuid[]) or id = any($3::uuid[]) or sections = $4::text or created_by = $4::text)`,
      params: [orgId, ids.jobIds || [], ids.phaseIds || [], tag],
    },
    {
      label: 'jobs',
      sql: `delete from app.jobs where org_id = $1::uuid and (id = any($2::uuid[]) or job_number = any($3::text[]) or notes = $4::text or created_by = $4::text)`,
      params: [orgId, ids.jobIds || [], ids.jobNumbers || [], tag],
    },
    {
      label: 'owner_companies',
      sql: `delete from app.owner_companies where org_id = $1::uuid and (id = any($2::uuid[]) or created_by = $3::text or updated_by = $3::text or display_name ilike ('%' || $3::text || '%')) and lookup_key not in ('mgt', 'edh', 'kam')`,
      params: [orgId, ownerCompanyIds, tag],
    },
  ];

  const deleted = {};
  for (const statement of statements) {
    const result = await client.query(statement.sql, statement.params);
    deleted[statement.label] = (deleted[statement.label] || 0) + integer(result.rowCount);
  }
  return deleted;
}

async function findJobRequirements(client, orgId, jobId) {
  const result = await client.query(
    `
      select
        r.id::text as requirement_id,
        r.phase_id::text as phase_id,
        r.manufacturer::text as manufacturer,
        r.film_name::text as film_name,
        r.width_in::integer as width_in,
        r.required_feet::integer as required_feet
      from app.job_requirements r
      where r.org_id = $1::uuid
        and r.job_id = $2::uuid
      order by r.width_in asc, r.id asc
    `,
    [orgId, jobId]
  );
  return result.rows;
}

async function fetchBoxOwnerSnapshot(client, orgId, boxId) {
  const result = await client.query(
    `
      select
        b.box_id::text as box_id,
        b.status::text as status,
        b.warehouse::text as warehouse,
        b.owner_company_id::text as owner_company_id,
        coalesce(oc.code::text, '') as owner_company_code,
        b.initial_feet::integer as initial_feet,
        b.feet_available::integer as feet_available,
        b.received_date::text as received_date,
        b.has_label
      from app.boxes b
      left join app.owner_companies oc
        on oc.org_id = b.org_id
       and oc.id = b.owner_company_id
      where b.org_id = $1::uuid
        and b.box_id = $2::text
      limit 1
    `,
    [orgId, boxId]
  );
  return result.rows[0] || null;
}

async function fetchFilmOrderSnapshot(client, orgId, filmOrderId) {
  const result = await client.query(
    `
      select
        film_order_id::text as film_order_id,
        job_id::text as job_id,
        job_number::text as job_number,
        warehouse::text as warehouse,
        manufacturer::text as manufacturer,
        film_name::text as film_name,
        width_in::integer as width_in,
        requested_feet::integer as requested_feet,
        covered_feet::integer as covered_feet,
        ordered_feet::integer as ordered_feet,
        remaining_to_order_feet::integer as remaining_to_order_feet,
        status::text as status
      from app.film_orders
      where org_id = $1::uuid
        and film_order_id = $2::text
      limit 1
    `,
    [orgId, filmOrderId]
  );
  return result.rows[0] || null;
}

async function countFilmOrderLinks(client, orgId, filmOrderId, boxId) {
  const result = await client.query(
    `
      select count(*)::integer as link_count
      from app.film_order_box_links
      where org_id = $1::uuid
        and film_order_id = $2::text
        and box_id = $3::text
    `,
    [orgId, filmOrderId, boxId]
  );
  return integer(result.rows[0]?.link_count);
}

async function createFilmOrderFulfillmentFixture(config, { tag, keep }) {
  const { withMutation } = await import('../src/db/client.mjs');
  const { createJob } = await import('../src/app/services/jobs.mjs');
  const { createFilmOrder } = await import('../src/app/services/filmOrders.mjs');
  const { addBox, receiveOrderedBox } = await import('../src/app/services/boxes.mjs');

  return withMutation(async (client) => {
    const existing = readManifest(config, tag).manifest;
    if (existing) {
      await cleanupFilmOrderFixture(client, config.orgId, tag, existing.ids || {}, existing.summary || {});
    }

    const ids = {
      jobIds: [],
      jobNumbers: [],
      phaseIds: [],
      requirementIds: [],
      allocationIds: [],
      boxIds: [],
      filmOrderIds: [],
    };

    await cleanupFilmOrderFixture(client, config.orgId, tag, ids, {});

    const seedOwners = await seedOwnerCompanies(client, config.orgId);
    const edh = seedOwners.get('EDH');
    const warehouse = await chooseWarehouse(client, config.orgId);
    const actor = tag;
    const suffix = shortTag(tag).replace(/\D/g, '').slice(-8).padStart(8, '0');
    const ownerUserId = await resolveOwnerUserId(client, config.orgId);

    await setRpcAuthContext(client, ownerUserId, `codex-owner-film-order-${suffix}@example.local`);
    const inactiveOwnerCode = `FO${suffix}`.slice(0, 12).toUpperCase();
    const inactiveOwner = await ownerCompanyRpc(client, 'api_acl_owner_companies_upsert', config.orgId, actor, {
      code: inactiveOwnerCode,
      displayName: `Codex Film Order Inactive ${tag}`,
    });
    assertOk(inactiveOwner?.id, 'Could not create fixture inactive owner company.');
    await ownerCompanyRpc(client, 'api_acl_owner_companies_deactivate', config.orgId, actor, {
      ownerCompanyId: inactiveOwner.id,
    });

    const installDate = addDays(today(), 4);
    const jobPayload = {
      jobNumber: buildJobNumber(tag),
      warehouse,
      installDate,
      crewLeader: `Codex ${suffix}`,
      workScope: tag,
      notes: tag,
      phases: [
        {
          phaseNumber: 1,
          workScope: tag,
          installDate,
          crewLeader: `Codex ${suffix}`,
          workflowStatus: 'ACTIVE',
          requirements: [
            {
              manufacturer: 'Codex Fixture',
              filmName: `Film Order Owner New Box ${suffix}`,
              widthIn: 60,
              requiredFeet: 40,
              notes: tag,
            },
            {
              manufacturer: 'Codex Fixture',
              filmName: `Film Order Owner Receive Box ${suffix}`,
              widthIn: 72,
              requiredFeet: 35,
              notes: tag,
            },
          ],
        },
      ],
    };

    const job = await createJob(client, config.orgId, jobPayload, actor);
    const jobId = asText(job.data?.summary?.jobId);
    const jobNumber = asText(job.data?.summary?.jobNumber);
    assertOk(jobId && jobNumber, 'Fixture job creation did not return a canonical job identity.');
    ids.jobIds.push(jobId);
    ids.jobNumbers.push(jobNumber);

    const requirements = await findJobRequirements(client, config.orgId, jobId);
    for (const requirement of requirements) {
      ids.requirementIds.push(requirement.requirement_id);
      ids.phaseIds.push(requirement.phase_id);
    }
    const newBoxRequirement = requirements.find((entry) => entry.width_in === 60);
    const receiveRequirement = requirements.find((entry) => entry.width_in === 72);
    assertOk(newBoxRequirement?.requirement_id, 'New-box fixture requirement was not found.');
    assertOk(receiveRequirement?.requirement_id, 'Receive fixture requirement was not found.');

    const newBoxOrderResult = await createFilmOrder(
      client,
      config.orgId,
      {
        jobId,
        jobNumber,
        requirementId: newBoxRequirement.requirement_id,
        warehouse,
        manufacturer: newBoxRequirement.manufacturer,
        filmName: newBoxRequirement.film_name,
        widthIn: newBoxRequirement.width_in,
        requestedFeet: newBoxRequirement.required_feet,
      },
      actor
    );
    const newBoxOrder = newBoxOrderResult.data || newBoxOrderResult;
    assertOk(newBoxOrder?.filmOrderId, 'New-box film order was not created.');
    ids.filmOrderIds.push(newBoxOrder.filmOrderId);

    const receiveOrderResult = await createFilmOrder(
      client,
      config.orgId,
      {
        jobId,
        jobNumber,
        requirementId: receiveRequirement.requirement_id,
        warehouse,
        manufacturer: receiveRequirement.manufacturer,
        filmName: receiveRequirement.film_name,
        widthIn: receiveRequirement.width_in,
        requestedFeet: receiveRequirement.required_feet,
      },
      actor
    );
    const receiveOrder = receiveOrderResult.data || receiveOrderResult;
    assertOk(receiveOrder?.filmOrderId, 'Receive fixture film order was not created.');
    ids.filmOrderIds.push(receiveOrder.filmOrderId);

    const plannedNewBoxId = buildBoxId(warehouse, 'CFOF', tag);
    const orderedBoxId = buildBoxId(warehouse, 'CFOO', tag);
    ids.boxIds.push(plannedNewBoxId, orderedBoxId);

    await addBox(
      client,
      config.orgId,
      {
        boxId: orderedBoxId,
        warehouse,
        ownerCompanyId: edh.id,
        dealer: 'Codex Fixture Dealer',
        manufacturer: receiveRequirement.manufacturer,
        filmName: receiveRequirement.film_name,
        widthIn: receiveRequirement.width_in,
        initialFeet: receiveRequirement.required_feet,
        orderDate: today(),
        receivedDate: '',
        coreType: '',
        lotRun: tag,
        notes: tag,
        auditNote: tag,
        filmOrderId: receiveOrder.filmOrderId,
      },
      actor
    );

    const orderedBeforeReceive = await fetchBoxOwnerSnapshot(client, config.orgId, orderedBoxId);
    assertOk(orderedBeforeReceive?.status === 'ORDERED', 'Fixture ordered box was not in ORDERED status.');
    assertOk(orderedBeforeReceive?.owner_company_code === 'EDH', 'Fixture ordered box did not start with EDH owner.');

    await receiveOrderedBox(
      client,
      config.orgId,
      {
        boxId: orderedBoxId,
        currentFeetOnRoll: String(receiveRequirement.required_feet),
        receivedWeightLbs: '18.5',
        lotRun: tag,
        coreType: 'White plastic',
      },
      actor
    );

    const orderedAfterReceive = await fetchBoxOwnerSnapshot(client, config.orgId, orderedBoxId);
    assertOk(orderedAfterReceive?.status === 'IN_STOCK', 'Fixture ordered box was not received into stock.');
    assertOk(orderedAfterReceive?.owner_company_code === 'EDH', 'Receiving existing ordered box did not preserve owner.');
    assertOk(
      await countFilmOrderLinks(client, config.orgId, receiveOrder.filmOrderId, orderedBoxId) === 1,
      'Received ordered box did not keep its film order link.'
    );

    const newOrderSnapshot = await fetchFilmOrderSnapshot(client, config.orgId, newBoxOrder.filmOrderId);
    const receiveOrderSnapshot = await fetchFilmOrderSnapshot(client, config.orgId, receiveOrder.filmOrderId);
    const beforeCleanupCounts = await fetchFixtureCounts(client, config.orgId, tag, ids, {
      ownerCompanies: { createdIds: [inactiveOwner.id] },
    });

    const summary = {
      ownerCompanies: {
        seedOwnerCodes: ['MGT', 'EDH', 'KAM'],
        createdIds: [inactiveOwner.id],
        inactiveOwnerCode,
        inactiveOwnerSelectable: false,
      },
      job: {
        jobId,
        jobNumber,
        warehouse,
        workScope: tag,
      },
      newBoxFulfillment: {
        filmOrderId: newBoxOrder.filmOrderId,
        filmName: newBoxRequirement.film_name,
        manufacturer: newBoxRequirement.manufacturer,
        widthIn: newBoxRequirement.width_in,
        requestedFeet: newBoxRequirement.required_feet,
        browserBoxId: plannedNewBoxId,
        expectedOwnerCode: 'KAM',
        expectedCreatedFeet: 20,
        statusBeforeBrowser: newOrderSnapshot?.status,
      },
      orderedReceive: {
        filmOrderId: receiveOrder.filmOrderId,
        boxId: orderedBoxId,
        ownerBefore: orderedBeforeReceive.owner_company_code,
        ownerAfter: orderedAfterReceive.owner_company_code,
        statusBefore: orderedBeforeReceive.status,
        statusAfter: orderedAfterReceive.status,
        filmOrderStatusAfter: receiveOrderSnapshot?.status,
        ownerPreserved: orderedAfterReceive.owner_company_code === orderedBeforeReceive.owner_company_code,
      },
      routes: {
        filmOrders: '/#/film-orders',
        filmOrderDetails: buildFilmOrderDetailsRoute(newBoxOrder.filmOrderId),
        addBoxIntake: buildAddBoxIntakeRoute(
          {
            ...newBoxOrder,
            jobId,
            jobNumber,
            warehouse,
            remainingToOrderFeet: newBoxRequirement.required_feet,
          },
          tag
        ),
        newBoxDetails: `/#/inventory/${encodeURIComponent(plannedNewBoxId)}`,
        orderedBoxDetails: `/#/inventory/${encodeURIComponent(orderedBoxId)}`,
      },
      counts: beforeCleanupCounts,
    };

    const manifest = {
      tag,
      scenario: 'inventory-ownership-film-order',
      createdAt: new Date().toISOString(),
      projectRef: config.projectRef,
      orgId: config.orgId,
      ids,
      routes: {
        jobDetails: [`/#/allocations/jobs/${encodeURIComponent(jobId)}`],
        boxDetails: [
          `/#/inventory/${encodeURIComponent(plannedNewBoxId)}`,
          `/#/inventory/${encodeURIComponent(orderedBoxId)}`,
        ],
      },
      summary,
    };
    const written = writeManifest(config, manifest);

    let cleanup = null;
    if (!keep) {
      const deleted = await cleanupFilmOrderFixture(client, config.orgId, tag, ids, summary);
      const after = await fetchFixtureCounts(client, config.orgId, tag, ids, summary);
      cleanup = {
        ok: Object.values(after).every((value) => integer(value) === 0),
        deleted,
        after,
      };
      assertOk(cleanup.ok, 'Film order fixture cleanup left residue.');
    }

    return {
      ok: true,
      projectRef: config.projectRef,
      tag,
      ids,
      summary,
      cleanup,
      manifestPath: written.manifestPath,
    };
  });
}

async function assertFilmOrderFulfillmentResult(config, tag) {
  const { withMutation } = await import('../src/db/client.mjs');
  const { manifest } = readManifest(config, tag);
  assertOk(manifest, `Missing fixture manifest for ${tag}.`);

  return withMutation(async (client) => {
    const summary = manifest.summary || {};
    const newBox = summary.newBoxFulfillment || {};
    const orderedReceive = summary.orderedReceive || {};
    const newBoxSnapshot = await fetchBoxOwnerSnapshot(client, config.orgId, newBox.browserBoxId);
    const orderedBoxSnapshot = await fetchBoxOwnerSnapshot(client, config.orgId, orderedReceive.boxId);
    const newOrderSnapshot = await fetchFilmOrderSnapshot(client, config.orgId, newBox.filmOrderId);
    const newBoxLinkCount = await countFilmOrderLinks(
      client,
      config.orgId,
      newBox.filmOrderId,
      newBox.browserBoxId
    );
    const orderedLinkCount = await countFilmOrderLinks(
      client,
      config.orgId,
      orderedReceive.filmOrderId,
      orderedReceive.boxId
    );

    assertOk(newBoxSnapshot?.box_id === newBox.browserBoxId, 'Browser-created film order box was not found.');
    assertOk(newBoxSnapshot.owner_company_code === newBox.expectedOwnerCode, 'Browser-created box owner was not KAM.');
    assertOk(newBoxSnapshot.status === 'IN_STOCK', 'Browser-created box was not in stock.');
    assertOk(newBoxSnapshot.warehouse === summary.job?.warehouse, 'Browser-created box warehouse drifted.');
    assertOk(integer(newBoxSnapshot.initial_feet) === integer(newBox.expectedCreatedFeet), 'Browser-created box LF did not match fixture input.');
    assertOk(newBoxLinkCount === 1, 'Browser-created box is not linked to the fixture film order.');
    assertOk(newOrderSnapshot?.status !== 'CANCELLED', 'Fixture film order was unexpectedly cancelled.');
    assertOk(orderedBoxSnapshot?.owner_company_code === orderedReceive.ownerAfter, 'Existing ordered receive owner was not preserved.');
    assertOk(orderedBoxSnapshot?.status === 'IN_STOCK', 'Existing ordered receive box is no longer in stock.');
    assertOk(orderedLinkCount === 1, 'Existing ordered receive film order link was not preserved.');

    const counts = await fetchFixtureCounts(client, config.orgId, tag, manifest.ids || {}, summary);
    return {
      ok: true,
      projectRef: config.projectRef,
      tag,
      newBox: {
        boxId: newBoxSnapshot.box_id,
        status: newBoxSnapshot.status,
        warehouse: newBoxSnapshot.warehouse,
        owner: newBoxSnapshot.owner_company_code,
        initialFeet: integer(newBoxSnapshot.initial_feet),
        filmOrderId: newBox.filmOrderId,
        linkCount: newBoxLinkCount,
        filmOrderStatus: newOrderSnapshot.status,
        remainingToOrderFeet: integer(newOrderSnapshot.remaining_to_order_feet),
      },
      orderedReceive: {
        boxId: orderedBoxSnapshot.box_id,
        owner: orderedBoxSnapshot.owner_company_code,
        status: orderedBoxSnapshot.status,
        linkCount: orderedLinkCount,
      },
      counts,
    };
  });
}

async function cleanupOnly(config, tag) {
  const { withMutation } = await import('../src/db/client.mjs');
  return withMutation(async (client) => {
    const { manifest } = readManifest(config, tag);
    assertOk(manifest, `Missing fixture manifest for ${tag}.`);
    const before = await fetchFixtureCounts(client, config.orgId, tag, manifest.ids || {}, manifest.summary || {});
    const deleted = await cleanupFilmOrderFixture(client, config.orgId, tag, manifest.ids || {}, manifest.summary || {});
    const after = await fetchFixtureCounts(client, config.orgId, tag, manifest.ids || {}, manifest.summary || {});
    return {
      ok: Object.values(after).every((value) => integer(value) === 0),
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
  node backend/scripts/verify-inventory-ownership-film-order-dev.mjs --setup --keep --tag CODEX_DEV_FIXTURE_INVENTORY_OWNERSHIP_FILM_ORDER_...
  node backend/scripts/verify-inventory-ownership-film-order-dev.mjs --assert-result --tag CODEX_DEV_FIXTURE_INVENTORY_OWNERSHIP_FILM_ORDER_...
  node backend/scripts/verify-inventory-ownership-film-order-dev.mjs --cleanup --tag CODEX_DEV_FIXTURE_INVENTORY_OWNERSHIP_FILM_ORDER_...`);
    return;
  }

  const tag = normalizeFixtureTag(args.tag, 'inventory-ownership-film-order');
  const config = loadDevFixtureConfig(args);

  if (args.cleanup) {
    const result = await cleanupOnly(config, tag);
    console.log(JSON.stringify({
      action: 'cleanup',
      ok: result.ok,
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

  if (args['assert-result']) {
    const result = await assertFilmOrderFulfillmentResult(config, tag);
    console.log(JSON.stringify({
      action: 'assert-result',
      ...result,
    }, null, 2));
    return;
  }

  const result = await createFilmOrderFulfillmentFixture(config, {
    tag,
    keep: args.keep === true || String(args.keep).toLowerCase() === 'true',
  });
  console.log(JSON.stringify({
    action: 'setup',
    ok: result.ok,
    projectRef: result.projectRef,
    tag: result.tag,
    ids: result.ids,
    summary: result.summary,
    cleanup: result.cleanup,
    manifestPath: result.manifestPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
