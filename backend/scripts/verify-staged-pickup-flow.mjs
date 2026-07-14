import '../load-env.mjs';
import crypto from 'node:crypto';
import { Client } from 'pg';
import {
  addBox,
  applyAllocationPlan,
  buildJobDetail,
  buildJobsList,
  checkoutAllJobMaterials,
  findBoxById,
  setJobStagedPickup,
} from '../src/app/internal.mjs';
import { buildJobsCalendar, buildJobsSearchResults } from '../src/app/services/jobs.mjs';
import { handleSupabaseRequest } from '../supabase-backend.mjs';
import { resolveSmokeAuthToken } from './lib/smoke-auth.mjs';

function asTrimmedString(value) {
  return String(value || '').trim();
}

function requireDatabaseUrl() {
  const databaseUrl = asTrimmedString(process.env.DATABASE_URL);
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }
  return databaseUrl;
}

function requireOrgId() {
  const orgId = asTrimmedString(process.env.VERIFY_DB_PARITY_ORG_ID || process.env.DEFAULT_ORG_ID);
  if (!orgId) {
    throw new Error('VERIFY_DB_PARITY_ORG_ID or DEFAULT_ORG_ID is required.');
  }
  return orgId;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildUniqueSuffix() {
  const now = Date.now().toString();
  const random = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0');
  return `${now.slice(-8)}${random}`;
}

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

function buildInStockBoxPayload(boxId, receivedDate, overrides = {}) {
  return {
    boxId,
    manufacturer: '3M Solar',
    filmName: 'Night Vision 25',
    widthIn: 36,
    initialFeet: 80,
    orderDate: receivedDate,
    receivedDate,
    notes: 'Staged pickup verification box.',
    ...overrides,
  };
}

async function resolveWarehouseCode(client, orgId) {
  const result = await client.query(
    `
      select code::text as code
      from app.warehouses
      where org_id = $1::uuid
      order by code
      limit 1
    `,
    [orgId],
  );
  return asTrimmedString(result.rows[0]?.code) || 'IL1';
}

async function resolveOwnerCompanyId(client, orgId) {
  const result = await client.query(
    `
      select id::text as id
      from app.owner_companies
      where org_id = $1::uuid
        and is_active = true
      order by lookup_key, id
      limit 1
    `,
    [orgId],
  );
  const ownerCompanyId = asTrimmedString(result.rows[0]?.id);
  assert(ownerCompanyId, 'An active DEV owner company is required for staged-pickup verification.');
  return ownerCompanyId;
}

async function getTableColumns(client, tableName) {
  const result = await client.query(
    `
      select column_name
      from information_schema.columns
      where table_schema = 'app'
        and table_name = $1::text
      order by ordinal_position
    `,
    [tableName],
  );

  return new Set(result.rows.map((row) => asTrimmedString(row.column_name)));
}

async function insertAppRow(client, tableName, availableColumns, valuesByColumn) {
  const columns = Object.keys(valuesByColumn).filter((column) => availableColumns.has(column));
  assert(columns.length > 0, `No insertable columns were resolved for app.${tableName}.`);

  const values = columns.map((column) => valuesByColumn[column]);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  await client.query(
    `
      insert into app.${tableName} (${columns.join(', ')})
      values (${placeholders.join(', ')})
    `,
    values,
  );
}

async function insertVerificationJob(
  client,
  orgId,
  jobNumber,
  warehouse,
  installDate,
  actor,
  requiredFeet,
  options = {},
) {
  const nowIso = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const includePhase = options.includePhase === true;
  const phaseId = includePhase ? crypto.randomUUID() : '';
  const requirementId = crypto.randomUUID();
  const jobColumns = await getTableColumns(client, 'jobs');
  const phaseColumns = includePhase ? await getTableColumns(client, 'job_phases') : null;
  const requirementColumns = await getTableColumns(client, 'job_requirements');

  await insertAppRow(client, 'jobs', jobColumns, {
    id: jobId,
    org_id: orgId,
    job_number: jobNumber,
    warehouse,
    sections: null,
    due_date: installDate,
    lifecycle_status: 'ACTIVE',
    notes: 'Staged pickup verification job.',
    created_at: nowIso,
    created_by: actor,
    updated_at: nowIso,
    updated_by: actor,
    crew_leader: 'Stage Verify',
    is_staged_for_pickup: false,
    is_labor_only: false,
  });

  if (includePhase) {
    await insertAppRow(client, 'job_phases', phaseColumns, {
      id: phaseId,
      org_id: orgId,
      job_id: jobId,
      phase_number: 1,
      sections: '1',
      install_date: installDate,
      install_end_date: installDate,
      crew_leader: 'Stage Verify',
      labor_status: 'ACTIVE',
      workflow_status: 'ACTIVE',
      is_primary: true,
      created_at: nowIso,
      created_by: actor,
      updated_at: nowIso,
      updated_by: actor,
    });
  }

  if (Number(requiredFeet) > 0) {
    await insertAppRow(client, 'job_requirements', requirementColumns, {
      id: requirementId,
      org_id: orgId,
      job_id: jobId,
      phase_id: phaseId || null,
      manufacturer: '3M Solar',
      film_name: 'Night Vision 25',
      width_in: 36,
      required_feet: requiredFeet,
      notes: '',
      created_at: nowIso,
      created_by: actor,
      updated_at: nowIso,
      updated_by: actor,
    });
  }

  return { jobId, phaseId, requirementId: Number(requiredFeet) > 0 ? requirementId : '' };
}

async function resolveVerificationUserId(client, orgId) {
  const result = await client.query(
    `
      select m.user_id::text as user_id
      from app.organization_members m
      join app.access_requests r
        on r.org_id = m.org_id
       and r.user_id = m.user_id
      where m.org_id = $1::uuid
        and m.role = 'owner'
        and m.status = 'active'
        and r.status = 'approved'
      order by m.created_at asc
      limit 1
    `,
    [orgId],
  );
  const userId = asTrimmedString(result.rows[0]?.user_id);
  assert(
    userId,
    'An active approved DEV owner is required for the staged-pickup SQL ACL verification.',
  );
  return userId;
}

async function setStagedPickupThroughCanonicalSql(
  client,
  orgId,
  userId,
  actor,
  jobId,
  jobNumber,
  isStaged,
) {
  const result = await client.query(
    `
      select public.api_acl_jobs_set_staged_pickup_for_user(
        $1::uuid,
        $2::uuid,
        $3::text,
        jsonb_build_object(
          'jobId', $4::text,
          'jobNumber', $5::text,
          'isStagedForPickup', $6::boolean
        )
      ) as result
    `,
    [orgId, userId, actor, jobId, jobNumber, isStaged],
  );
  return result.rows[0]?.result || null;
}

async function createAllocatedInStockJob(
  client,
  orgId,
  jobNumber,
  boxId,
  warehouse,
  ownerCompanyId,
  installDate,
  actor,
  requiredFeet,
) {
  const createdJob = await insertVerificationJob(
    client,
    orgId,
    jobNumber,
    warehouse,
    installDate,
    actor,
    0,
    { includePhase: true },
  );

  const addedBox = await addBox(
    client,
    orgId,
    buildInStockBoxPayload(boxId, installDate, { ownerCompanyId }),
    actor,
  );
  const box = addedBox?.data?.box;
  assert(box, 'Failed to create the verification box.');
  assert(box.status === 'IN_STOCK', 'Expected the verification box to start in stock.');

  const applyResult = await applyAllocationPlan(
    client,
    orgId,
    {
      jobId: createdJob.jobId,
      boxId,
      jobNumber,
      requestedFeet: 0,
      requestedWidthIn: 36,
      selectedSuggestionBoxIds: [],
      extraAllocations: [{ boxId, allocatedFeet: requiredFeet }],
      crossWarehouse: false,
      autoAllocate: false,
    },
    actor,
  );
  const allocation = (applyResult?.data?.allocations || []).find((entry) => entry.boxId === boxId);
  assert(allocation, 'Expected the fixture allocation to be created.');
  assert(
    asTrimmedString(allocation.jobId).toLowerCase() === createdJob.jobId.toLowerCase(),
    'Expected the fixture allocation to retain canonical job identity.',
  );
  assert(allocation.allocationKind === 'EXTRA', 'Expected the fixture allocation to use the extra-allocation path.');
  assert(allocation.status === 'ACTIVE', 'Expected the fixture allocation to remain active before checkout.');
  assert(
    !asTrimmedString(allocation.resolvedAt),
    'Expected the fixture allocation to remain unresolved before checkout.',
  );
  assert(
    Number(allocation.allocatedFeet || 0) === requiredFeet,
    'Expected the fixture allocation to retain its requested quantity.',
  );

  return {
    jobId: createdJob.jobId,
    phaseId: createdJob.phaseId,
    box,
  };
}

async function postRoute(path, bodyJson, token) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await handleSupabaseRequest({
    method: 'POST',
    logicalPath: path,
    requestUrl: buildRequestUrl(path),
    bodyJson,
    headers,
  });

  assert(response?.statusCode === 200, `${path} expected HTTP 200, received ${response?.statusCode}.`);
  assert(response?.payload?.ok === true, `${path} expected ok payload, received ${response?.payload?.error || 'unknown error'}.`);
  assert(Array.isArray(response?.payload?.warnings), `${path} expected payload.warnings to be an array.`);

  return response.payload;
}

async function cleanupVerificationArtifacts(client, orgId, jobs, actor) {
  const jobNumbers = jobs.map((entry) => asTrimmedString(entry?.jobNumber)).filter(Boolean);
  const boxIds = jobs.map((entry) => asTrimmedString(entry?.boxId)).filter(Boolean);

  if (jobNumbers.length === 0 && boxIds.length === 0) {
    return;
  }

  const nowIso = new Date().toISOString();
  await client.query('begin');

  try {
    if (boxIds.length > 0) {
      await client.query(
        `
          delete from app.audit_log
          where org_id = $1::uuid
            and box_id = any($2::text[])
        `,
        [orgId, boxIds],
      );

      await client.query(
        `
          update app.boxes
             set status = 'IN_STOCK',
                 last_checkout_job = '',
                 last_checkout_date = null,
                 updated_at = $3::timestamptz,
                 updated_by = $4::text
           where org_id = $1::uuid
             and box_id = any($2::text[])
        `,
        [orgId, boxIds, nowIso, actor],
      );

      await client.query(
        `
          delete from app.allocations
          where org_id = $1::uuid
            and box_id = any($2::text[])
        `,
        [orgId, boxIds],
      );

      await client.query(
        `
          delete from app.boxes
          where org_id = $1::uuid
            and box_id = any($2::text[])
        `,
        [orgId, boxIds],
      );
    }

    if (jobNumbers.length > 0) {
      await client.query(
        `
          delete from app.job_requirements
          where org_id = $1::uuid
            and job_id in (
              select id
              from app.jobs
              where org_id = $1::uuid
                and job_number = any($2::text[])
            )
        `,
        [orgId, jobNumbers],
      );

      await client.query(
        `
          delete from app.jobs
          where org_id = $1::uuid
            and job_number = any($2::text[])
        `,
        [orgId, jobNumbers],
      );
    }

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function runServiceLayerVerification(client, orgId, actor) {
  let transactionStarted = false;

  try {
    await client.query('begin');
    transactionStarted = true;

    const warehouse = await resolveWarehouseCode(client, orgId);
    const ownerCompanyId = await resolveOwnerCompanyId(client, orgId);
    const verificationUserId = await resolveVerificationUserId(client, orgId);
    const installDate = new Date().toISOString().slice(0, 10);
    const uniqueSuffix = buildUniqueSuffix();

    const checkoutJobNumber = `98${uniqueSuffix}`;
    const checkoutBoxId = `${warehouse}-CHK-${uniqueSuffix}`;
    const checkoutFixture = await createAllocatedInStockJob(
      client,
      orgId,
      checkoutJobNumber,
      checkoutBoxId,
      warehouse,
      ownerCompanyId,
      installDate,
      actor,
      25,
    );
    const checkoutResult = await checkoutAllJobMaterials(
      client,
      orgId,
      { jobId: checkoutFixture.jobId, jobNumber: checkoutJobNumber },
      actor,
    );
    assert(Array.isArray(checkoutResult?.warnings), 'Expected checkout-all to return its warnings contract.');
    const checkedOutBox = await findBoxById(client, orgId, checkoutBoxId);
    assert(checkedOutBox?.status === 'CHECKED_OUT', 'Expected checkout-all to check out the fixture box.');
    const checkoutDetail = await buildJobDetail(client, orgId, checkoutJobNumber);
    assert(checkoutDetail?.summary?.isStagedForPickup === false, 'Checkout-all should not mark the job staged.');
    assert(
      (checkoutDetail?.allocations || []).some(
        (entry) => entry.boxId === checkoutBoxId && entry.boxStatus === 'CHECKED_OUT',
      ),
      'Expected checkout-all detail to show the fixture box as checked out.',
    );

    const stagedJobNumber = `97${uniqueSuffix}`;
    const stagedBoxId = `${warehouse}-STG-${uniqueSuffix}`;
    const stagedFixture = await createAllocatedInStockJob(
      client,
      orgId,
      stagedJobNumber,
      stagedBoxId,
      warehouse,
      ownerCompanyId,
      installDate,
      actor,
      25,
    );
    await checkoutAllJobMaterials(
      client,
      orgId,
      { jobId: stagedFixture.jobId, jobNumber: stagedJobNumber },
      actor,
    );
    const stagedResult = await setJobStagedPickup(
      client,
      orgId,
      stagedJobNumber,
      true,
      actor,
      { jobId: stagedFixture.jobId },
    );
    assert(stagedResult?.isStagedForPickup === true, 'Expected local staged-pickup state to save.');
    const stagedBox = await findBoxById(client, orgId, stagedBoxId);
    assert(stagedBox?.status === 'CHECKED_OUT', 'Expected the staged-pickup fixture box to remain checked out.');
    const stagedDetail = await buildJobDetail(client, orgId, stagedJobNumber);
    assert(
      stagedDetail?.summary?.isStagedForPickup === true,
      'Expected job detail to keep local staged-pickup state.',
    );

    const calendarJobNumber = `94${uniqueSuffix}`;
    const calendarFixture = await insertVerificationJob(
      client,
      orgId,
      calendarJobNumber,
      warehouse,
      installDate,
      actor,
      0,
      { includePhase: true },
    );

    const stagedBySql = await setStagedPickupThroughCanonicalSql(
      client,
      orgId,
      verificationUserId,
      actor,
      calendarFixture.jobId,
      calendarJobNumber,
      true,
    );
    assert(
      stagedBySql?.isStagedForPickup === true,
      'Expected the 0157-owned SQL ACL flow to stage the fixture job.',
    );

    const calendarDetail = await buildJobDetail(client, orgId, calendarJobNumber);
    assert(
      calendarDetail?.summary?.isStagedForPickup === true,
      'Expected job detail to keep the SQL staged-pickup flag.',
    );
    assert(calendarDetail?.summary?.status === 'READY', 'Expected the no-material calendar fixture to be ready.');

    const clearedBySql = await setStagedPickupThroughCanonicalSql(
      client,
      orgId,
      verificationUserId,
      actor,
      calendarDetail.summary.jobId,
      calendarJobNumber,
      false,
    );
    assert(clearedBySql?.isStagedForPickup === false, 'Expected the 0157-owned SQL ACL flow to clear staged pickup.');

    const restagedBySql = await setStagedPickupThroughCanonicalSql(
      client,
      orgId,
      verificationUserId,
      actor,
      calendarDetail.summary.jobId,
      calendarJobNumber,
      true,
    );
    assert(restagedBySql?.isStagedForPickup === true, 'Expected the 0157-owned SQL ACL flow to restore staged pickup.');

    const listEntries = await buildJobsList(client, orgId, 0, 'ACTIVE', [calendarJobNumber], {
      warehouse,
    });
    const listedJob = listEntries.find((entry) => entry.jobNumber === calendarJobNumber);
    assert(listedJob?.isStagedForPickup === true, 'Expected jobs list to project staged pickup from the canonical job row.');

    const searchEntries = await buildJobsSearchResults(
      client,
      orgId,
      calendarJobNumber,
      25,
      'ACTIVE',
      { warehouse },
    );
    const searchedJob = searchEntries.find((entry) => entry.jobNumber === calendarJobNumber);
    assert(searchedJob?.isStagedForPickup === true, 'Expected jobs search to project staged pickup for the fixture job.');

    const calendarEntries = await buildJobsCalendar(
      client,
      orgId,
      'month',
      installDate,
      undefined,
      'ACTIVE',
      { warehouse },
    );
    const calendarJob = calendarEntries.find((entry) => entry.jobNumber === calendarJobNumber);
    assert(calendarJob?.isStagedForPickup === true, 'Expected jobs calendar to project staged pickup for the fixture job.');
    assert(calendarJob?.installDate === installDate, 'Expected jobs calendar to preserve the fixture phase install date.');
    assert(
      asTrimmedString(calendarJob?.phaseId).toLowerCase() === calendarFixture.phaseId.toLowerCase(),
      'Expected jobs calendar to retain canonical phase identity.',
    );

    const unrelatedOrgId = crypto.randomUUID();
    const unrelatedOrgList = await buildJobsList(
      client,
      unrelatedOrgId,
      0,
      'ACTIVE',
      [calendarJobNumber],
      { warehouse },
    );
    const unrelatedOrgSearch = await buildJobsSearchResults(
      client,
      unrelatedOrgId,
      calendarJobNumber,
      25,
      'ACTIVE',
      { warehouse },
    );
    const unrelatedOrgCalendar = await buildJobsCalendar(
      client,
      unrelatedOrgId,
      'month',
      installDate,
      undefined,
      'ACTIVE',
      { warehouse },
    );
    assert(
      !unrelatedOrgList.some((entry) => entry.jobNumber === calendarJobNumber),
      'Expected jobs list to enforce organization scope.',
    );
    assert(
      !unrelatedOrgSearch.some((entry) => entry.jobNumber === calendarJobNumber),
      'Expected jobs search to enforce organization scope.',
    );
    assert(
      !unrelatedOrgCalendar.some((entry) => entry.jobNumber === calendarJobNumber),
      'Expected jobs calendar to hide the fixture job outside its authenticated organization scope.',
    );

    await client.query('rollback');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await client.query('rollback');
    }
    throw error;
  }
}

async function runRouteVerification(client, orgId, actor) {
  const { token } = await resolveSmokeAuthToken({
    required: false,
    requiredFor: 'staged pickup route verification',
  });

  if (!token) {
    console.log('Staged pickup route verification skipped: no smoke auth token is configured.');
    return;
  }

  const warehouse = await resolveWarehouseCode(client, orgId);
  const ownerCompanyId = await resolveOwnerCompanyId(client, orgId);
  const installDate = new Date().toISOString().slice(0, 10);
  const uniqueSuffix = buildUniqueSuffix();
  const createdJobs = [];

  try {
    const checkoutJobNumber = `96${uniqueSuffix}`;
    const checkoutBoxId = `${warehouse}-RCK-${uniqueSuffix}`;
    const checkoutFixture = await createAllocatedInStockJob(
      client,
      orgId,
      checkoutJobNumber,
      checkoutBoxId,
      warehouse,
      ownerCompanyId,
      installDate,
      actor,
      25,
    );
    createdJobs.push({ jobNumber: checkoutJobNumber, boxId: checkoutBoxId });
    const checkoutPayload = await postRoute(
      '/jobs/checkout-all',
      { jobId: checkoutFixture.jobId, jobNumber: checkoutJobNumber },
      token,
    );
    assert(
      checkoutPayload?.data?.summary?.isStagedForPickup === false,
      'Checkout-all route should not mark the fixture job staged.',
    );
    assert(
      (checkoutPayload?.data?.allocations || []).some(
        (entry) => entry.boxId === checkoutBoxId && entry.boxStatus === 'CHECKED_OUT',
      ),
      'Expected checkout-all route detail to show the fixture box as checked out.',
    );

    const stagedJobNumber = `95${uniqueSuffix}`;
    const stagedBoxId = `${warehouse}-RST-${uniqueSuffix}`;
    const stagedFixture = await createAllocatedInStockJob(
      client,
      orgId,
      stagedJobNumber,
      stagedBoxId,
      warehouse,
      ownerCompanyId,
      installDate,
      actor,
      25,
    );
    createdJobs.push({ jobNumber: stagedJobNumber, boxId: stagedBoxId });

    await postRoute(
      '/jobs/checkout-all',
      { jobId: stagedFixture.jobId, jobNumber: stagedJobNumber },
      token,
    );
    const stagedPayload = await postRoute(
      '/jobs/set-staged-pickup',
      {
        jobId: stagedFixture.jobId,
        jobNumber: stagedJobNumber,
        isStagedForPickup: true,
      },
      token,
    );
    assert(
      stagedPayload?.data?.summary?.isStagedForPickup === true,
      'Expected staged pickup route to save the staged flag.',
    );
    assert(
      stagedPayload?.data?.summary?.status === 'READY',
      `Expected staged pickup route status READY, received ${stagedPayload?.data?.summary?.status}.`,
    );
    assert(
      (stagedPayload?.data?.allocations || []).some(
        (entry) => entry.boxId === stagedBoxId && entry.boxStatus === 'CHECKED_OUT',
      ),
      'Expected staged-pickup route detail to show the fixture box as checked out.',
    );
  } finally {
    await cleanupVerificationArtifacts(client, orgId, createdJobs, actor);
  }
}

async function main() {
  const client = new Client({
    connectionString: requireDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
  });
  const orgId = requireOrgId();
  const actor = 'staged-pickup-verifier';

  await client.connect();

  try {
    await runServiceLayerVerification(client, orgId, actor);
    await runRouteVerification(client, orgId, actor);
    console.log('Staged pickup flow OK.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
