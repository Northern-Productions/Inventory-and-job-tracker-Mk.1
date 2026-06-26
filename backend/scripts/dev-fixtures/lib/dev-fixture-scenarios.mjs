import { withMutation, withReadClient, queryRow, queryRows } from '../../../src/db/client.mjs';
import { createJob, buildJobDetailById } from '../../../src/app/services/jobs.mjs';
import { addBox, updateBox, setBoxStatus } from '../../../src/app/services/boxes.mjs';
import { applyAllocationPlan } from '../../../src/app/services/allocations.mjs';
import { asText, normalizeFixtureTag } from './dev-fixture-guard.mjs';
import { normalizeFixtureIdentity, assertSafeFixtureIdentity } from './dev-fixture-cleanup-safety.mjs';

const WAREHOUSE_FALLBACK = 'IL1';
const CORE_TYPE = 'White plastic';

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

function numericSuffix(tag) {
  return shortTag(tag).replace(/\D/g, '').slice(-7).padStart(7, '0');
}

function buildJobNumber(tag, offset = 0) {
  const base = Number(numericSuffix(tag).slice(-6)) || Math.floor(Math.random() * 900000) + 100000;
  return String(70_000_000 + ((base + offset) % 9_000_000));
}

function buildBoxId(warehouse, code, tag) {
  return `${warehouse}-${code}-${shortTag(tag).slice(-7)}`.toUpperCase();
}

function buildJobRoute(jobId) {
  return `/#/allocations/jobs/${jobId}`;
}

function buildBoxRoute(boxId) {
  return `/#/inventory/${encodeURIComponent(boxId)}`;
}

async function chooseWarehouse(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select code::text as code
      from app.warehouses
      where org_id = $1::uuid
      order by case when upper(code::text) = $2 then 0 else 1 end, code
    `,
    [orgId, WAREHOUSE_FALLBACK]
  );
  const warehouse = asText(rows[0]?.code).toUpperCase();
  if (!warehouse) {
    throw new Error('No configured DEV warehouse was found.');
  }
  return warehouse;
}

function boxPayload({ boxId, warehouse, tag, manufacturer, filmName, widthIn = 60, initialFeet = 80 }) {
  const currentDate = today();
  return {
    boxId,
    warehouse,
    dealer: 'Codex Fixture Dealer',
    manufacturer,
    filmName,
    widthIn,
    initialFeet,
    orderDate: currentDate,
    receivedDate: currentDate,
    coreType: CORE_TYPE,
    initialWeightLbs: 18,
    lastRollWeightLbs: 18,
    lastWeighedDate: currentDate,
    lotRun: tag,
    notes: tag,
    auditNote: tag,
  };
}

function jobPayload({ jobNumber, warehouse, tag, manufacturer, filmName, requiredFeet, installOffset = 3 }) {
  const installDate = addDays(today(), installOffset);
  return {
    jobNumber,
    warehouse,
    installDate,
    crewLeader: `Codex Fixture ${shortTag(tag)}`,
    workScope: tag,
    notes: tag,
    phases: [
      {
        phaseNumber: 1,
        workScope: tag,
        installDate,
        crewLeader: `Codex Fixture ${shortTag(tag)}`,
        workflowStatus: 'ACTIVE',
        requirements: [
          {
            manufacturer,
            filmName,
            widthIn: 60,
            requiredFeet,
            notes: tag,
          },
        ],
      },
    ],
  };
}

function firstRequirement(jobDetail) {
  const requirement = (jobDetail?.requirements || [])[0];
  if (!requirement?.requirementId) {
    throw new Error('Created fixture job did not return a film requirement.');
  }
  return requirement;
}

function firstPhaseId(jobDetail) {
  return asText((jobDetail?.phases || [])[0]?.phaseId);
}

async function addFixtureBox(client, orgId, payload, tag) {
  const response = await addBox(client, orgId, payload, tag);
  return response.data?.box || response.box || response.data;
}

async function createFixtureJob(client, orgId, payload, tag) {
  const response = await createJob(client, orgId, payload, tag);
  return response.data;
}

async function allocateFixtureBox(client, orgId, { jobDetail, boxId, requestedFeet, tag }) {
  const requirement = firstRequirement(jobDetail);
  const response = await applyAllocationPlan(
    client,
    orgId,
    {
      jobId: jobDetail.summary.jobId,
      jobNumber: jobDetail.summary.jobNumber,
      boxId,
      requestedFeet,
      requestedWidthIn: requirement.widthIn,
      requirementId: requirement.requirementId,
      selectedSuggestionBoxIds: [boxId],
      extraAllocations: [],
      crossWarehouse: false,
      autoAllocate: false,
    },
    tag
  );
  return response.data?.allocations || [];
}

async function checkoutFixtureBox(client, orgId, { boxId, jobId, tag }) {
  const response = await setBoxStatus(
    client,
    orgId,
    {
      boxId,
      status: 'CHECKED_OUT',
      jobId,
      auditNote: `${tag} checked out for fixture job`,
    },
    tag
  );
  return response.data?.box || response.data;
}

async function zeroFixtureBox(client, orgId, { existingBoxPayload, tag }) {
  const response = await updateBox(
    client,
    orgId,
    {
      ...existingBoxPayload,
      currentFeetOnRoll: 0,
      lastRollWeightLbs: 0,
      lastWeighedDate: today(),
      moveToZeroed: true,
      auditNote: `${tag} zeroed exclusion fixture`,
    },
    tag
  );
  return response.data?.box || response.data;
}

async function createCheckedOutBoxJob(config, tag) {
  return withMutation(async (client) => {
    const warehouse = await chooseWarehouse(client, config.orgId);
    const manufacturer = 'Codex Fixture';
    const filmName = `Checked Out Job ${shortTag(tag)}`;
    const boxId = buildBoxId(warehouse, 'CDF', tag);
    const jobNumber = buildJobNumber(tag, 1);

    await addFixtureBox(
      client,
      config.orgId,
      boxPayload({ boxId, warehouse, tag, manufacturer, filmName, initialFeet: 45 }),
      tag
    );
    let jobDetail = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({ jobNumber, warehouse, tag, manufacturer, filmName, requiredFeet: 35 }),
      tag
    );
    const requirement = firstRequirement(jobDetail);
    const allocations = await allocateFixtureBox(client, config.orgId, {
      jobDetail,
      boxId,
      requestedFeet: 35,
      tag,
    });
    const checkedOutBox = await checkoutFixtureBox(client, config.orgId, {
      boxId,
      jobId: jobDetail.summary.jobId,
      tag,
    });
    jobDetail = await buildJobDetailById(client, config.orgId, jobDetail.summary.jobId);

    return buildManifest({
      config,
      tag,
      scenario: 'checked-out-box-job',
      jobDetail,
      phaseId: firstPhaseId(jobDetail),
      requirementIds: [requirement.requirementId],
      allocationIds: allocations.map((entry) => entry.allocationId),
      boxIds: [boxId],
      summary: {
        jobId: jobDetail.summary.jobId,
        jobNumber,
        boxId,
        boxStatus: checkedOutBox?.status || 'CHECKED_OUT',
        lastCheckoutJobId: checkedOutBox?.lastCheckoutJobId || jobDetail.summary.jobId,
        lastCheckoutJob: checkedOutBox?.lastCheckoutJob || jobNumber,
      },
    });
  });
}

async function createAllocationEligibility(config, tag) {
  return withMutation(async (client) => {
    const warehouse = await chooseWarehouse(client, config.orgId);
    const manufacturer = 'Codex Fixture';
    const filmName = `Allocation Eligibility ${shortTag(tag)}`;
    const checkedOutBoxId = buildBoxId(warehouse, 'CDE', tag);
    const zeroedBoxId = buildBoxId(warehouse, 'CDZ', tag);
    const checkoutJobNumber = buildJobNumber(tag, 11);
    const targetJobNumber = buildJobNumber(tag, 12);

    await addFixtureBox(
      client,
      config.orgId,
      boxPayload({ boxId: checkedOutBoxId, warehouse, tag, manufacturer, filmName, initialFeet: 80 }),
      tag
    );
    let checkoutJobDetail = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({
        jobNumber: checkoutJobNumber,
        warehouse,
        tag,
        manufacturer,
        filmName,
        requiredFeet: 25,
        installOffset: 2,
      }),
      tag
    );
    const checkoutRequirement = firstRequirement(checkoutJobDetail);
    const checkoutAllocations = await allocateFixtureBox(client, config.orgId, {
      jobDetail: checkoutJobDetail,
      boxId: checkedOutBoxId,
      requestedFeet: 25,
      tag,
    });
    await checkoutFixtureBox(client, config.orgId, {
      boxId: checkedOutBoxId,
      jobId: checkoutJobDetail.summary.jobId,
      tag,
    });
    checkoutJobDetail = await buildJobDetailById(client, config.orgId, checkoutJobDetail.summary.jobId);

    const targetJobDetail = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({
        jobNumber: targetJobNumber,
        warehouse,
        tag,
        manufacturer,
        filmName,
        requiredFeet: 30,
        installOffset: 5,
      }),
      tag
    );
    const targetRequirement = firstRequirement(targetJobDetail);

    const zeroedPayload = boxPayload({
      boxId: zeroedBoxId,
      warehouse,
      tag,
      manufacturer,
      filmName,
      initialFeet: 50,
    });
    await addFixtureBox(client, config.orgId, zeroedPayload, tag);
    const zeroedBox = await zeroFixtureBox(client, config.orgId, {
      existingBoxPayload: zeroedPayload,
      tag,
    });

    const checkedOutState = await fetchBoxPlanningState(client, config.orgId, checkedOutBoxId);
    const zeroedState = await fetchBoxPlanningState(client, config.orgId, zeroedBoxId);

    return buildManifest({
      config,
      tag,
      scenario: 'allocation-eligibility',
      jobDetail: targetJobDetail,
      extraJobDetails: [checkoutJobDetail],
      phaseId: firstPhaseId(targetJobDetail),
      requirementIds: [
        checkoutRequirement.requirementId,
        targetRequirement.requirementId,
      ],
      allocationIds: checkoutAllocations.map((entry) => entry.allocationId),
      boxIds: [checkedOutBoxId, zeroedBoxId],
      summary: {
        targetJobId: targetJobDetail.summary.jobId,
        targetJobNumber,
        checkoutJobId: checkoutJobDetail.summary.jobId,
        checkoutJobNumber,
        checkedOutBoxId,
        checkedOutBoxStatus: checkedOutState.status,
        checkedOutBoxAllocatableNowFeet: checkedOutState.allocatableNowFeet,
        zeroedBoxId,
        zeroedBoxStatus: zeroedBox?.status || zeroedState.status,
        zeroedBoxAllocatableNowFeet: zeroedState.allocatableNowFeet,
      },
    });
  });
}

function buildManifest({
  config,
  tag,
  scenario,
  jobDetail,
  extraJobDetails = [],
  phaseId,
  requirementIds = [],
  allocationIds = [],
  boxIds = [],
  summary = {},
}) {
  const allJobDetails = [jobDetail, ...extraJobDetails].filter(Boolean);
  const jobIds = allJobDetails.map((entry) => entry.summary?.jobId).filter(Boolean);
  const jobNumbers = allJobDetails.map((entry) => entry.summary?.jobNumber).filter(Boolean);
  return {
    tag,
    scenario,
    createdAt: new Date().toISOString(),
    projectRef: config.projectRef,
    orgId: config.orgId,
    ids: {
      jobIds,
      jobNumbers,
      phaseIds: [phaseId, ...extraJobDetails.map(firstPhaseId)].filter(Boolean),
      requirementIds,
      allocationIds,
      boxIds,
      filmOrderIds: [],
    },
    routes: {
      jobDetails: jobIds.map(buildJobRoute),
      boxDetails: boxIds.map(buildBoxRoute),
      qrPayloads: boxIds,
    },
    summary,
  };
}

async function fetchBoxPlanningState(client, orgId, boxId) {
  const row = await queryRow(
    client,
    `
      select
        b.box_id::text as box_id,
        b.status::text as status,
        b.last_checkout_job_id::text as last_checkout_job_id,
        b.last_checkout_job::text as last_checkout_job,
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
  if (!row) {
    return null;
  }
  return {
    boxId: row.box_id,
    status: row.status,
    lastCheckoutJobId: asText(row.last_checkout_job_id),
    lastCheckoutJob: asText(row.last_checkout_job),
    allocatableNowFeet: integer(row.allocatable_now_feet),
    activeAllocatedFeet: integer(row.active_allocated_feet),
  };
}

async function discoverFixtureIds(client, orgId, tag) {
  const normalizedTag = normalizeFixtureTag(tag);
  const row = await queryRow(
    client,
    `
      with fixture_jobs as (
        select id::text as id, job_number::text as job_number
        from app.jobs
        where org_id = $1::uuid
          and (
            notes = $2::text
            or created_by = $2::text
            or updated_by = $2::text
            or sections = $2::text
          )
      ),
      fixture_boxes as (
        select box_id::text as box_id
        from app.boxes
        where org_id = $1::uuid
          and (
            notes = $2::text
            or lot_run = $2::text
            or zeroed_by = $2::text
          )
      ),
      fixture_requirements as (
        select id::text as id
        from app.job_requirements
        where org_id = $1::uuid
          and (
            job_id in (select id::uuid from fixture_jobs)
            or notes = $2::text
            or created_by = $2::text
            or updated_by = $2::text
          )
      ),
      fixture_phases as (
        select id::text as id
        from app.job_phases
        where org_id = $1::uuid
          and (
            job_id in (select id::uuid from fixture_jobs)
            or sections = $2::text
            or created_by = $2::text
            or updated_by = $2::text
          )
      ),
      fixture_allocations as (
        select allocation_id::text as allocation_id
        from app.allocations
        where org_id = $1::uuid
          and (
            job_id in (select id::uuid from fixture_jobs)
            or box_id in (select box_id from fixture_boxes)
            or requirement_id in (select id::uuid from fixture_requirements)
            or notes = $2::text
            or created_by = $2::text
            or resolved_by = $2::text
          )
      )
      select jsonb_build_object(
        'jobIds', coalesce((select jsonb_agg(id order by id) from fixture_jobs), '[]'::jsonb),
        'jobNumbers', coalesce((select jsonb_agg(job_number order by job_number) from fixture_jobs), '[]'::jsonb),
        'phaseIds', coalesce((select jsonb_agg(id order by id) from fixture_phases), '[]'::jsonb),
        'requirementIds', coalesce((select jsonb_agg(id order by id) from fixture_requirements), '[]'::jsonb),
        'allocationIds', coalesce((select jsonb_agg(allocation_id order by allocation_id) from fixture_allocations), '[]'::jsonb),
        'boxIds', coalesce((select jsonb_agg(box_id order by box_id) from fixture_boxes), '[]'::jsonb),
        'filmOrderIds', '[]'::jsonb
      ) as ids
    `,
    [orgId, normalizedTag]
  );
  return {
    tag: normalizedTag,
    ids: row?.ids || {},
  };
}

async function countFixtureRecords(client, orgId, identity) {
  assertSafeFixtureIdentity(identity);
  const ids = identity.ids || {};
  const row = await queryRow(
    client,
    `
      select jsonb_build_object(
        'jobs', (select count(*)::integer from app.jobs where org_id = $1::uuid and (id = any($2::uuid[]) or job_number = any($3::text[]) or notes = $9::text or created_by = $9::text)),
        'phases', (select count(*)::integer from app.job_phases where org_id = $1::uuid and (id = any($4::uuid[]) or job_id = any($2::uuid[]) or sections = $9::text or created_by = $9::text)),
        'requirements', (select count(*)::integer from app.job_requirements where org_id = $1::uuid and (id = any($5::uuid[]) or job_id = any($2::uuid[]) or notes = $9::text or created_by = $9::text)),
        'allocations', (select count(*)::integer from app.allocations where org_id = $1::uuid and (allocation_id = any($6::text[]) or job_id = any($2::uuid[]) or box_id = any($7::text[]) or created_by = $9::text or notes = $9::text)),
        'boxes', (select count(*)::integer from app.boxes where org_id = $1::uuid and (box_id = any($7::text[]) or notes = $9::text or lot_run = $9::text)),
        'filmOrders', (select count(*)::integer from app.film_orders where org_id = $1::uuid and (film_order_id = any($8::text[]) or job_id = any($2::uuid[]) or notes = $9::text)),
        'audit', (select count(*)::integer from app.audit_log where org_id = $1::uuid and (box_id = any($7::text[]) or actor = $9::text or notes = $9::text)),
        'rollHistory', (select count(*)::integer from app.roll_weight_log where org_id = $1::uuid and (box_id = any($7::text[]) or job_id = any($2::uuid[]) or job_number = any($3::text[]) or checked_out_by = $9::text or checked_in_by = $9::text or notes = $9::text))
      ) as counts
    `,
    [
      orgId,
      ids.jobIds || [],
      ids.jobNumbers || [],
      ids.phaseIds || [],
      ids.requirementIds || [],
      ids.allocationIds || [],
      ids.boxIds || [],
      ids.filmOrderIds || [],
      identity.tag,
    ]
  );
  return row?.counts || {};
}

async function verifyFixture(config, { tag, manifest }) {
  return withReadClient(async (client) => {
    const discovered = await discoverFixtureIds(client, config.orgId, tag);
    const identity = normalizeFixtureIdentity({ tag, manifest, discovered });
    const counts = await countFixtureRecords(client, config.orgId, identity);
    const boxStates = [];
    for (const boxId of identity.ids.boxIds || []) {
      const state = await fetchBoxPlanningState(client, config.orgId, boxId);
      if (state) {
        boxStates.push(state);
      }
    }
    const ok = integer(counts.jobs) > 0 && integer(counts.boxes) > 0;
    return {
      ok,
      tag: identity.tag,
      ids: identity.ids,
      counts,
      boxStates,
    };
  });
}

async function cleanupFixture(config, { tag, manifest }) {
  return withMutation(async (client) => {
    const discovered = await discoverFixtureIds(client, config.orgId, tag);
    const identity = normalizeFixtureIdentity({ tag, manifest, discovered });
    assertSafeFixtureIdentity(identity);
    const before = await countFixtureRecords(client, config.orgId, identity);
    const ids = identity.ids || {};
    const params = [
      config.orgId,
      ids.jobIds || [],
      ids.jobNumbers || [],
      ids.phaseIds || [],
      ids.requirementIds || [],
      ids.allocationIds || [],
      ids.boxIds || [],
      ids.filmOrderIds || [],
      identity.tag,
    ];
    const paramCte = `
      with fixture_params as (
        select
          $1::uuid as org_id,
          $2::uuid[] as job_ids,
          $3::text[] as job_numbers,
          $4::uuid[] as phase_ids,
          $5::uuid[] as requirement_ids,
          $6::text[] as allocation_ids,
          $7::text[] as box_ids,
          $8::text[] as film_order_ids,
          $9::text as tag
      )
    `;
    const deletionSql = [
      `${paramCte}
      delete from app.roll_weight_log target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.box_id = any(p.box_ids)
          or target.job_id = any(p.job_ids)
          or target.job_number = any(p.job_numbers)
          or target.checked_out_by = p.tag
          or target.checked_in_by = p.tag
          or target.notes = p.tag
        )`,
      `${paramCte}
      delete from app.audit_log target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.box_id = any(p.box_ids)
          or target.actor = p.tag
          or target.notes = p.tag
        )`,
      `${paramCte}
      delete from app.film_order_box_links target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.film_order_id = any(p.film_order_ids)
          or target.box_id = any(p.box_ids)
        )`,
      `${paramCte}
      delete from app.allocations target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.allocation_id = any(p.allocation_ids)
          or target.job_id = any(p.job_ids)
          or target.box_id = any(p.box_ids)
          or target.requirement_id = any(p.requirement_ids)
          or target.created_by = p.tag
          or target.resolved_by = p.tag
          or target.notes = p.tag
        )`,
      `${paramCte}
      delete from app.film_orders target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.film_order_id = any(p.film_order_ids)
          or target.job_id = any(p.job_ids)
          or target.job_number = any(p.job_numbers)
          or target.notes = p.tag
        )`,
      `${paramCte}
      delete from app.film_catalog target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.source_box_id = any(p.box_ids)
          or target.notes = p.tag
        )`,
      `${paramCte}
      delete from app.job_caulk_requirements target
      using fixture_params p
      where target.org_id = p.org_id
        and target.job_id = any(p.job_ids)`,
      `${paramCte}
      delete from app.job_requirements target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.id = any(p.requirement_ids)
          or target.job_id = any(p.job_ids)
          or target.notes = p.tag
          or target.created_by = p.tag
        )`,
      `${paramCte}
      delete from app.job_phases target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.id = any(p.phase_ids)
          or target.job_id = any(p.job_ids)
          or target.sections = p.tag
          or target.created_by = p.tag
        )`,
      `${paramCte}
      delete from app.jobs target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.id = any(p.job_ids)
          or target.job_number = any(p.job_numbers)
          or target.notes = p.tag
          or target.created_by = p.tag
        )`,
      `${paramCte}
      delete from app.boxes target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.box_id = any(p.box_ids)
          or target.notes = p.tag
          or target.lot_run = p.tag
          or target.zeroed_by = p.tag
        )`,
    ];
    const deleted = {};
    for (const sql of deletionSql) {
      const table = sql.match(/delete from app\.([a-z_]+)/)?.[1] || 'unknown';
      const result = await client.query(sql, params);
      deleted[table] = (deleted[table] || 0) + integer(result.rowCount);
    }
    const after = await countFixtureRecords(client, config.orgId, identity);
    const remaining = Object.values(after).reduce((sum, value) => sum + integer(value), 0);
    return {
      ok: remaining === 0,
      tag: identity.tag,
      ids: identity.ids,
      before,
      deleted,
      after,
    };
  });
}

async function createFixture(config, { scenario, tag }) {
  const normalizedTag = normalizeFixtureTag(tag, scenario);
  const existing = await verifyFixture(config, { tag: normalizedTag, manifest: null });
  if (Object.values(existing.counts || {}).some((value) => integer(value) > 0)) {
    return buildExistingFixtureManifest(config, {
      tag: normalizedTag,
      scenario,
      existing,
    });
  }
  if (scenario === 'checked-out-box-job') {
    return createCheckedOutBoxJob(config, normalizedTag);
  }
  if (scenario === 'allocation-eligibility') {
    return createAllocationEligibility(config, normalizedTag);
  }
  throw new Error(`Unsupported fixture scenario: ${scenario}`);
}

function buildExistingFixtureManifest(config, { tag, scenario, existing }) {
  const ids = existing.ids || {};
  return {
    tag,
    scenario,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectRef: config.projectRef,
    orgId: config.orgId,
    ids,
    routes: {
      jobDetails: (ids.jobIds || []).map(buildJobRoute),
      boxDetails: (ids.boxIds || []).map(buildBoxRoute),
      qrPayloads: ids.boxIds || [],
    },
    summary: {
      reusedExisting: true,
      jobIds: ids.jobIds || [],
      jobNumbers: ids.jobNumbers || [],
      boxStates: existing.boxStates || [],
      counts: existing.counts || {},
    },
  };
}

export {
  cleanupFixture,
  createFixture,
  discoverFixtureIds,
  verifyFixture,
};
