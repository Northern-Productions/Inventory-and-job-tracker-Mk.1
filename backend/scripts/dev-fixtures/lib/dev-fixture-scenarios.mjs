import { withMutation, withReadClient, queryRow, queryRows } from '../../../src/db/client.mjs';
import { createJob, buildJobDetailById } from '../../../src/app/services/jobs.mjs';
import { addBox, updateBox, setBoxStatus } from '../../../src/app/services/boxes.mjs';
import { applyAllocationPlan } from '../../../src/app/services/allocations.mjs';
import {
  asText,
  assertFixtureDealerAvailable,
  buildFixtureDealerIdentity,
  normalizeFixtureTag,
} from './dev-fixture-guard.mjs';
import {
  dealerTableIntegrityMatches,
  normalizeFixtureIdentity,
  assertSafeFixtureIdentity,
} from './dev-fixture-cleanup-safety.mjs';
import {
  buildTableAggregateSql,
  normalizeAggregateResult,
  resolveDigestFunction,
} from '../../lib/release-integrity.mjs';

const WAREHOUSE_FALLBACK = 'IL1';
const CORE_TYPE = 'White plastic';
const DEALER_TABLE = Object.freeze({ schema: 'app', table: 'box_dealers' });

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

async function chooseWarehousePair(client, orgId) {
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
  const warehouses = rows.map((row) => asText(row.code).toUpperCase()).filter(Boolean);
  if (warehouses.length < 2) {
    throw new Error('The atomic transfer fixture requires two configured DEV warehouses.');
  }
  return {
    sourceWarehouse: warehouses[0],
    destinationWarehouse: warehouses[1],
  };
}

async function chooseOwnerCompanyId(client, orgId, warehouse) {
  const row = await queryRow(
    client,
    `
      select owner.id::text as owner_company_id
      from app.owner_companies owner
      where owner.org_id = $1::uuid
        and owner.id = app_api.default_owner_company_id_for_warehouse($1::uuid, $2::text)
        and owner.is_active = true
      limit 1
    `,
    [orgId, warehouse]
  );
  const ownerCompanyId = asText(row?.owner_company_id);
  if (!ownerCompanyId) {
    throw new Error('No active default owner company is configured for the DEV fixture warehouse.');
  }
  return ownerCompanyId;
}

async function captureDealerTableIntegrity(client) {
  const columns = await queryRows(
    client,
    `
      select column_name::text as column_name
      from information_schema.columns
      where table_schema = 'app'
        and table_name = 'box_dealers'
      order by ordinal_position
    `
  );
  const columnNames = columns.map((row) => asText(row.column_name)).filter(Boolean);
  const digestFunction = await resolveDigestFunction(client);
  const result = await client.query(
    buildTableAggregateSql(DEALER_TABLE, columnNames, digestFunction)
  );
  return normalizeAggregateResult(result, DEALER_TABLE);
}

async function prepareFixtureDealer(config, tag) {
  const fixtureDealer = buildFixtureDealerIdentity(tag);
  return withReadClient(async (client) => {
    await client.query('begin transaction isolation level repeatable read read only');
    try {
      await client.query("set local timezone = 'UTC'");
      await client.query("set local statement_timeout = '30s'");
      await client.query("set local lock_timeout = '3s'");
      const collision = await queryRow(
        client,
        `
          select
            count(*) filter (where lookup_key = $2::text)::integer as code_matches,
            count(*) filter (where name = $3::text)::integer as name_matches
          from app.box_dealers
          where org_id = $1::uuid
        `,
        [config.orgId, fixtureDealer.code, fixtureDealer.name]
      );
      assertFixtureDealerAvailable({
        codeMatches: collision?.code_matches,
        nameMatches: collision?.name_matches,
      });
      return {
        fixtureDealer,
        dealerTableBefore: await captureDealerTableIntegrity(client),
      };
    } finally {
      await client.query('rollback');
    }
  });
}

async function createFixtureDealer(client, orgId, fixtureDealer) {
  const row = await queryRow(
    client,
    `
      insert into app.box_dealers (org_id, name, lookup_key)
      values ($1::uuid, $2::text, $3::text)
      returning id::text as id, name::text as name, lookup_key::text as code
    `,
    [orgId, fixtureDealer.name, fixtureDealer.code]
  );
  if (!row?.id || row.name !== fixtureDealer.name || row.code !== fixtureDealer.code) {
    throw new Error('Tagged fixture dealer was not created exactly as requested.');
  }
  return row;
}

async function applyFixtureSessionContext(client, config) {
  const smokeUserEmail = asText(config.smokeUserEmail);
  const identity = await queryRow(
    client,
    `
      select
        u.id::text as user_id,
        ($2::text <> '' and lower(u.email) = lower($2::text)) as matched_smoke_user
      from auth.users u
      join app.organization_members member
        on member.user_id = u.id
       and member.org_id = $1::uuid
       and member.status = 'active'
      order by
        case when $2::text <> '' and lower(u.email) = lower($2::text) then 0 else 1 end,
        case lower(member.role::text) when 'owner' then 0 when 'admin' then 1 else 2 end,
        u.id
      limit 1
    `,
    [config.orgId, smokeUserEmail]
  );
  const userId = asText(identity?.user_id);
  if (!userId) {
    throw new Error('No active authenticated member is available for the DEV fixture organization.');
  }

  const claimEmail = identity?.matched_smoke_user ? smokeUserEmail : '';
  const claimsPayload = {
    sub: userId,
    role: 'authenticated',
  };
  if (claimEmail) {
    claimsPayload.email = claimEmail;
  }
  const claims = JSON.stringify(claimsPayload);
  await client.query(
    `
      select
        set_config('request.jwt.claim.sub', $1::text, true),
        set_config('request.jwt.claim.role', 'authenticated', true),
        set_config('request.jwt.claim.email', $2::text, true),
        set_config('request.jwt.claims', $3::text, true),
        set_config('app.actor', $4::text, true)
    `,
    [userId, claimEmail, claims, 'codex-dev-fixture']
  );
}

async function withFixtureMutation(config, callback) {
  return withMutation(async (client) => {
    await applyFixtureSessionContext(client, config);
    return callback(client);
  });
}

function boxPayload({
  boxId,
  warehouse,
  ownerCompanyId,
  dealerName,
  tag,
  manufacturer,
  filmName,
  widthIn = 60,
  initialFeet = 80,
}) {
  const currentDate = today();
  return {
    boxId,
    warehouse,
    ownerCompanyId,
    dealer: dealerName,
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

async function allocateFixtureBox(
  client,
  orgId,
  { jobDetail, boxId, requestedFeet, tag, crossWarehouse = false, jobWarehouse = '' }
) {
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
      selectedSuggestionBoxIds: [],
      extraAllocations: [],
      crossWarehouse,
      ...(jobWarehouse ? { jobWarehouse } : {}),
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

async function createCheckedOutBoxJob(config, tag, dealerPreflight) {
  return withFixtureMutation(config, async (client) => {
    const fixtureDealer = await createFixtureDealer(
      client,
      config.orgId,
      dealerPreflight.fixtureDealer
    );
    const warehouse = await chooseWarehouse(client, config.orgId);
    const ownerCompanyId = await chooseOwnerCompanyId(client, config.orgId, warehouse);
    const manufacturer = 'Codex Fixture';
    const filmName = `Checked Out Job ${shortTag(tag)}`;
    const boxId = buildBoxId(warehouse, 'CDF', tag);
    const jobNumber = buildJobNumber(tag, 1);

    await addFixtureBox(
      client,
      config.orgId,
      boxPayload({
        boxId,
        warehouse,
        ownerCompanyId,
        dealerName: fixtureDealer.name,
        tag,
        manufacturer,
        filmName,
        initialFeet: 45,
      }),
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
      fixtureDealer,
      dealerTableBefore: dealerPreflight.dealerTableBefore,
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

async function createAllocationEligibility(config, tag, dealerPreflight) {
  return withFixtureMutation(config, async (client) => {
    const fixtureDealer = await createFixtureDealer(
      client,
      config.orgId,
      dealerPreflight.fixtureDealer
    );
    const warehouse = await chooseWarehouse(client, config.orgId);
    const ownerCompanyId = await chooseOwnerCompanyId(client, config.orgId, warehouse);
    const manufacturer = 'Codex Fixture';
    const filmName = `Allocation Eligibility ${shortTag(tag)}`;
    const checkedOutBoxId = buildBoxId(warehouse, 'CDE', tag);
    const zeroedBoxId = buildBoxId(warehouse, 'CDZ', tag);
    const checkoutJobNumber = buildJobNumber(tag, 11);
    const targetJobNumber = buildJobNumber(tag, 12);

    await addFixtureBox(
      client,
      config.orgId,
      boxPayload({
        boxId: checkedOutBoxId,
        warehouse,
        ownerCompanyId,
        dealerName: fixtureDealer.name,
        tag,
        manufacturer,
        filmName,
        initialFeet: 80,
      }),
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
      ownerCompanyId,
      dealerName: fixtureDealer.name,
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
      fixtureDealer,
      dealerTableBefore: dealerPreflight.dealerTableBefore,
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

async function createAtomicTransferAssistedAllocation(config, tag, dealerPreflight) {
  return withFixtureMutation(config, async (client) => {
    const fixtureDealer = await createFixtureDealer(
      client,
      config.orgId,
      dealerPreflight.fixtureDealer
    );
    const { sourceWarehouse, destinationWarehouse } = await chooseWarehousePair(client, config.orgId);
    const ownerCompanyId = await chooseOwnerCompanyId(client, config.orgId, sourceWarehouse);
    const manufacturer = 'Codex Fixture';
    const filmName = `Atomic Transfer ${shortTag(tag)}`;
    const boxId = buildBoxId(sourceWarehouse, 'CDT', tag);
    const jobNumber = buildJobNumber(tag, 21);

    await addFixtureBox(
      client,
      config.orgId,
      boxPayload({
        boxId,
        warehouse: sourceWarehouse,
        ownerCompanyId,
        dealerName: fixtureDealer.name,
        tag,
        manufacturer,
        filmName,
        initialFeet: 90,
      }),
      tag
    );
    let jobDetail = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({
        jobNumber,
        warehouse: destinationWarehouse,
        tag,
        manufacturer,
        filmName,
        requiredFeet: 40,
        installOffset: 4,
      }),
      tag
    );
    const requirement = firstRequirement(jobDetail);
    const allocations = await allocateFixtureBox(client, config.orgId, {
      jobDetail,
      boxId,
      requestedFeet: 40,
      tag,
      crossWarehouse: true,
      jobWarehouse: destinationWarehouse,
    });
    const allocationIds = allocations.map((entry) => entry.allocationId).filter(Boolean);
    const transferState = await queryRow(
      client,
      `
        select
          t.status::text as status,
          t.destination_warehouse::text as destination_warehouse,
          (t.transfer_created_allocation_id = any($3::text[])) as linked_to_fixture_allocation
        from app.box_transfers t
        where t.org_id = $1::uuid
          and t.source_box_id = $2::text
          and t.status = 'PENDING'
        order by t.created_at desc, t.id desc
        limit 1
      `,
      [config.orgId, boxId, allocationIds]
    );
    if (!transferState?.linked_to_fixture_allocation) {
      throw new Error('Atomic transfer fixture did not create its linked pending transfer.');
    }

    jobDetail = await buildJobDetailById(client, config.orgId, jobDetail.summary.jobId);
    return buildManifest({
      config,
      tag,
      scenario: 'atomic-transfer-assisted-allocation',
      jobDetail,
      phaseId: firstPhaseId(jobDetail),
      requirementIds: [requirement.requirementId],
      allocationIds,
      boxIds: [boxId],
      fixtureDealer,
      dealerTableBefore: dealerPreflight.dealerTableBefore,
      summary: {
        sourceWarehouse,
        destinationWarehouse,
        transferStatus: asText(transferState.status).toUpperCase(),
        transferLinked: Boolean(transferState.linked_to_fixture_allocation),
      },
    });
  });
}

async function createAllocationTimeoutRemediation(config, tag, dealerPreflight) {
  return withFixtureMutation(config, async (client) => {
    const fixtureDealer = await createFixtureDealer(
      client,
      config.orgId,
      dealerPreflight.fixtureDealer
    );
    const warehouse = await chooseWarehouse(client, config.orgId);
    const ownerCompanyId = await chooseOwnerCompanyId(client, config.orgId, warehouse);
    const manufacturer = 'Codex Fixture';
    const filmName = `Allocation Timeout ${shortTag(tag)}`;
    const oneBoxId = buildBoxId(warehouse, 'T01', tag);
    const sourceBoxId = buildBoxId(warehouse, 'T30', tag);
    const candidateBoxIds = [
      buildBoxId(warehouse, 'T31', tag),
      buildBoxId(warehouse, 'T32', tag),
    ];
    const extraBoxId = buildBoxId(warehouse, 'TEX', tag);
    const boxSpecs = [
      { boxId: oneBoxId, initialFeet: 40 },
      { boxId: sourceBoxId, initialFeet: 30 },
      { boxId: candidateBoxIds[0], initialFeet: 30 },
      { boxId: candidateBoxIds[1], initialFeet: 30 },
      { boxId: extraBoxId, initialFeet: 20 },
    ];

    for (const spec of boxSpecs) {
      await addFixtureBox(
        client,
        config.orgId,
        boxPayload({
          ...spec,
          warehouse,
          ownerCompanyId,
          dealerName: fixtureDealer.name,
          tag,
          manufacturer,
          filmName,
        }),
        tag
      );
    }

    const oneBoxJob = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({
        jobNumber: buildJobNumber(tag, 31),
        warehouse,
        tag,
        manufacturer,
        filmName,
        requiredFeet: 20,
        installOffset: 5,
      }),
      tag
    );
    const threeBoxJob = await createFixtureJob(
      client,
      config.orgId,
      jobPayload({
        jobNumber: buildJobNumber(tag, 32),
        warehouse,
        tag,
        manufacturer,
        filmName,
        requiredFeet: 75,
        installOffset: 6,
      }),
      tag
    );
    const oneRequirement = firstRequirement(oneBoxJob);
    const threeRequirement = firstRequirement(threeBoxJob);

    return buildManifest({
      config,
      tag,
      scenario: 'allocation-timeout-remediation',
      jobDetail: threeBoxJob,
      extraJobDetails: [oneBoxJob],
      phaseId: firstPhaseId(threeBoxJob),
      requirementIds: [threeRequirement.requirementId, oneRequirement.requirementId],
      boxIds: [oneBoxId, sourceBoxId, ...candidateBoxIds, extraBoxId],
      fixtureDealer,
      dealerTableBefore: dealerPreflight.dealerTableBefore,
      summary: {
        warehouse,
        oneBox: {
          jobId: oneBoxJob.summary.jobId,
          jobNumber: oneBoxJob.summary.jobNumber,
          requirementId: oneRequirement.requirementId,
          widthIn: oneRequirement.widthIn,
          boxId: oneBoxId,
          requestedFeet: 20,
        },
        threeBox: {
          jobId: threeBoxJob.summary.jobId,
          jobNumber: threeBoxJob.summary.jobNumber,
          requirementId: threeRequirement.requirementId,
          widthIn: threeRequirement.widthIn,
          sourceBoxId,
          candidateBoxIds,
          extraBoxId,
          requestedFeet: 75,
          extraFeet: 5,
        },
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
  fixtureDealer,
  dealerTableBefore,
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
    fixtureDealer,
    integrity: {
      dealerTableBefore,
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
  const expectedDealer = buildFixtureDealerIdentity(normalizedTag);
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
      fixture_dealer as (
        select id::text as id, name::text as name, lookup_key::text as code
        from app.box_dealers
        where org_id = $1::uuid
          and name = $3::text
          and lookup_key = $4::text
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
      ) as ids,
      coalesce((
        select jsonb_build_object('id', id, 'name', name, 'code', code)
        from fixture_dealer
        order by id
        limit 1
      ), '{}'::jsonb) as fixture_dealer
    `,
    [orgId, normalizedTag, expectedDealer.name, expectedDealer.code]
  );
  return {
    tag: normalizedTag,
    ids: row?.ids || {},
    fixtureDealer: row?.fixture_dealer || {},
  };
}

async function countFixtureRecords(client, orgId, identity) {
  assertSafeFixtureIdentity(identity);
  const ids = identity.ids || {};
  const fixtureDealer = identity.fixtureDealer || {};
  const row = await queryRow(
    client,
    `
      select jsonb_build_object(
        'jobs', (select count(*)::integer from app.jobs where org_id = $1::uuid and (id = any($2::uuid[]) or job_number = any($3::text[]) or notes = $9::text or created_by = $9::text)),
        'phases', (select count(*)::integer from app.job_phases where org_id = $1::uuid and (id = any($4::uuid[]) or job_id = any($2::uuid[]) or sections = $9::text or created_by = $9::text)),
        'requirements', (select count(*)::integer from app.job_requirements where org_id = $1::uuid and (id = any($5::uuid[]) or job_id = any($2::uuid[]) or notes = $9::text or created_by = $9::text)),
        'allocations', (select count(*)::integer from app.allocations where org_id = $1::uuid and (allocation_id = any($6::text[]) or job_id = any($2::uuid[]) or box_id = any($7::text[]) or created_by = $9::text or notes = $9::text)),
        'transfers', (select count(*)::integer from app.box_transfers where org_id = $1::uuid and (source_box_id = any($7::text[]) or destination_box_id = any($7::text[]) or created_by = $9::text or updated_by = $9::text)),
        'boxAliases', (select count(*)::integer from app.box_id_aliases where org_id = $1::uuid and (old_box_id = any($7::text[]) or canonical_box_id = any($7::text[]))),
        'dealers', (select count(*)::integer from app.box_dealers where org_id = $1::uuid and id = $10::uuid and lookup_key = $11::text and name = $12::text),
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
      asText(fixtureDealer.id) || null,
      asText(fixtureDealer.code),
      asText(fixtureDealer.name),
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
    const fixtureDealer = identity.fixtureDealer || {};
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
      asText(fixtureDealer.id) || null,
      asText(fixtureDealer.code),
      asText(fixtureDealer.name),
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
          $9::text as tag,
          $10::uuid as dealer_id,
          $11::text as dealer_code,
          $12::text as dealer_name
      )
    `;
    const deleted = {};
    if (integer(before.transfers) > 0) {
      await client.query('savepoint fixture_transfer_cleanup');
      try {
        await client.query(
          'alter table app.box_transfers disable trigger trg_0191_guard_box_transfers'
        );
        await client.query(
          'alter table app.box_transfers disable trigger trg_0191_transfer_consistency_transfer'
        );
        const transferDeleteResult = await client.query(
          `${paramCte}
          delete from app.box_transfers target
          using fixture_params p
          where target.org_id = p.org_id
            and (
              target.source_box_id = any(p.box_ids)
              or target.destination_box_id = any(p.box_ids)
              or target.created_by = p.tag
              or target.updated_by = p.tag
            )`,
          params
        );
        await client.query(
          'alter table app.box_transfers enable trigger trg_0191_transfer_consistency_transfer'
        );
        await client.query(
          'alter table app.box_transfers enable trigger trg_0191_guard_box_transfers'
        );
        await client.query('release savepoint fixture_transfer_cleanup');
        deleted.box_transfers = integer(transferDeleteResult.rowCount);
      } catch (error) {
        await client.query('rollback to savepoint fixture_transfer_cleanup');
        throw error;
      }
    }

    const deletionSql = [
      `${paramCte}
      delete from app.box_id_aliases target
      using fixture_params p
      where target.org_id = p.org_id
        and (
          target.old_box_id = any(p.box_ids)
          or target.canonical_box_id = any(p.box_ids)
        )`,
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
      `${paramCte}
      delete from app.box_dealers target
      using fixture_params p
      where target.org_id = p.org_id
        and target.id = p.dealer_id
        and target.lookup_key = p.dealer_code
        and target.name = p.dealer_name`,
    ];
    for (const sql of deletionSql) {
      const table = sql.match(/delete from app\.([a-z_]+)/)?.[1] || 'unknown';
      const result = await client.query(sql, params);
      deleted[table] = (deleted[table] || 0) + integer(result.rowCount);
    }
    const after = await countFixtureRecords(client, config.orgId, identity);
    const remaining = Object.values(after).reduce((sum, value) => sum + integer(value), 0);
    const dealerBaseline = identity.integrity?.dealerTableBefore || {};
    const dealerBaselinePresent = (
      Number.isSafeInteger(dealerBaseline.rowCount) && Boolean(dealerBaseline.fingerprint)
    );
    const dealerAfter = dealerBaselinePresent
      ? await captureDealerTableIntegrity(client)
      : null;
    const dealerIntegrityRestored = dealerBaselinePresent
      ? dealerTableIntegrityMatches(dealerBaseline, dealerAfter)
      : !asText(fixtureDealer.id);
    return {
      ok: remaining === 0 && dealerIntegrityRestored,
      tag: identity.tag,
      ids: identity.ids,
      before,
      deleted,
      after,
      dealerIntegrity: {
        baselinePresent: dealerBaselinePresent,
        restored: dealerIntegrityRestored,
      },
    };
  });
}

async function createFixture(config, { scenario, tag }) {
  const normalizedTag = normalizeFixtureTag(tag, scenario);
  const existing = await verifyFixture(config, { tag: normalizedTag, manifest: null });
  if (Object.values(existing.counts || {}).some((value) => integer(value) > 0)) {
    throw new Error('Fixture tag already owns DEV records; cleanup or use a fresh fixture tag.');
  }
  const dealerPreflight = await prepareFixtureDealer(config, normalizedTag);
  if (scenario === 'checked-out-box-job') {
    return createCheckedOutBoxJob(config, normalizedTag, dealerPreflight);
  }
  if (scenario === 'allocation-eligibility') {
    return createAllocationEligibility(config, normalizedTag, dealerPreflight);
  }
  if (scenario === 'atomic-transfer-assisted-allocation') {
    return createAtomicTransferAssistedAllocation(config, normalizedTag, dealerPreflight);
  }
  if (scenario === 'allocation-timeout-remediation') {
    return createAllocationTimeoutRemediation(config, normalizedTag, dealerPreflight);
  }
  throw new Error(`Unsupported fixture scenario: ${scenario}`);
}

export {
  cleanupFixture,
  captureDealerTableIntegrity,
  createFixture,
  createFixtureDealer,
  discoverFixtureIds,
  prepareFixtureDealer,
  verifyFixture,
};
