import '../load-env.mjs';
import crypto from 'node:crypto';
import { Client } from 'pg';
import {
  addBox,
  applyAllocationPlan,
  buildJobDetail,
  checkoutAllJobMaterials,
  findBoxById,
  setJobStagedPickup,
} from '../src/app/internal.mjs';
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

async function insertVerificationJob(client, orgId, jobNumber, warehouse, installDate, actor, requiredFeet) {
  const nowIso = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const requirementId = crypto.randomUUID();
  const jobColumns = await getTableColumns(client, 'jobs');
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

  await insertAppRow(client, 'job_requirements', requirementColumns, {
    id: requirementId,
    org_id: orgId,
    job_id: jobId,
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

  return { jobId, requirementId };
}

async function createAllocatedInStockJob(client, orgId, jobNumber, boxId, warehouse, installDate, actor, requiredFeet) {
  const createdJob = await insertVerificationJob(
    client,
    orgId,
    jobNumber,
    warehouse,
    installDate,
    actor,
    requiredFeet,
  );
  const requirementId = asTrimmedString(createdJob?.requirementId);
  assert(requirementId, `Failed to create the verification requirement for job ${jobNumber}.`);

  const addedBox = await addBox(client, orgId, buildInStockBoxPayload(boxId, installDate), actor);
  const box = addedBox?.data?.box;
  assert(box, `Failed to create the verification box ${boxId}.`);
  assert(box.status === 'IN_STOCK', `Expected ${boxId} to start IN_STOCK, received ${box.status}.`);

  const applyResult = await applyAllocationPlan(
    client,
    orgId,
    {
      boxId,
      jobNumber,
      requestedFeet: requiredFeet,
      requestedWidthIn: 36,
      requirementId,
      selectedSuggestionBoxIds: [],
      extraAllocations: [],
    },
    actor,
  );
  const allocation = (applyResult?.data?.allocations || []).find((entry) => entry.boxId === boxId);
  assert(allocation, `Expected an allocation for ${boxId} on job ${jobNumber}.`);
  assert(
    Number(allocation.allocatedFeet || 0) === requiredFeet,
    `Expected ${requiredFeet} LF to be allocated for ${boxId}, received ${allocation?.allocatedFeet}.`,
  );

  return {
    requirementId,
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
    const installDate = new Date().toISOString().slice(0, 10);
    const uniqueSuffix = buildUniqueSuffix();

    const checkoutJobNumber = `98${uniqueSuffix}`;
    const checkoutBoxId = `${warehouse}-CHK-${uniqueSuffix}`;
    await createAllocatedInStockJob(
      client,
      orgId,
      checkoutJobNumber,
      checkoutBoxId,
      warehouse,
      installDate,
      actor,
      25,
    );

    const checkoutResult = await checkoutAllJobMaterials(client, orgId, checkoutJobNumber, actor);
    assert(
      (checkoutResult?.warnings || []).some((entry) => asTrimmedString(entry).includes(`job ${checkoutJobNumber}`)),
      'Expected checkout-all to report a checkout warning for the verification job.',
    );

    const checkedOutBox = await findBoxById(client, orgId, checkoutBoxId);
    assert(checkedOutBox, `Unable to reload checkout-all box ${checkoutBoxId}.`);
    assert(
      checkedOutBox.status === 'CHECKED_OUT',
      `Expected ${checkoutBoxId} to be CHECKED_OUT after checkout-all, received ${checkedOutBox.status}.`,
    );

    const checkoutDetail = await buildJobDetail(client, orgId, checkoutJobNumber);
    assert(checkoutDetail?.summary?.isStagedForPickup === false, 'Checkout-all should not mark the job staged.');
    assert(
      (checkoutDetail?.allocations || []).some(
        (entry) => entry.boxId === checkoutBoxId && entry.boxStatus === 'CHECKED_OUT',
      ),
      'Expected checkout-all detail to show the allocated box as checked out.',
    );

    const stagedJobNumber = `97${uniqueSuffix}`;
    const stagedBoxId = `${warehouse}-STG-${uniqueSuffix}`;
    await createAllocatedInStockJob(
      client,
      orgId,
      stagedJobNumber,
      stagedBoxId,
      warehouse,
      installDate,
      actor,
      25,
    );

    const stagedResult = await setJobStagedPickup(
      client,
      orgId,
      stagedJobNumber,
      true,
      actor,
      { autoCheckoutRemaining: true },
    );
    assert(stagedResult?.isStagedForPickup === true, 'Expected staged pickup update to save the staged flag.');
    assert(
      (stagedResult?.warnings || []).some((entry) => asTrimmedString(entry).includes(`job ${stagedJobNumber}`)),
      'Expected staged pickup to include the checkout warning for the verification job.',
    );

    const stagedBox = await findBoxById(client, orgId, stagedBoxId);
    assert(stagedBox, `Unable to reload staged pickup box ${stagedBoxId}.`);
    assert(
      stagedBox.status === 'CHECKED_OUT',
      `Expected ${stagedBoxId} to be CHECKED_OUT after staging, received ${stagedBox.status}.`,
    );

    const stagedDetail = await buildJobDetail(client, orgId, stagedJobNumber);
    assert(stagedDetail?.summary?.isStagedForPickup === true, 'Expected job detail to keep the staged pickup flag.');
    assert(stagedDetail?.summary?.status === 'READY', `Expected staged job status READY, received ${stagedDetail?.summary?.status}.`);
    assert(
      (stagedDetail?.allocations || []).some(
        (entry) => entry.boxId === stagedBoxId && entry.boxStatus === 'CHECKED_OUT',
      ),
      'Expected staged pickup detail to show the allocated box as checked out.',
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
  const installDate = new Date().toISOString().slice(0, 10);
  const uniqueSuffix = buildUniqueSuffix();
  const createdJobs = [];

  try {
    const checkoutJobNumber = `96${uniqueSuffix}`;
    const checkoutBoxId = `${warehouse}-RCK-${uniqueSuffix}`;
    await createAllocatedInStockJob(
      client,
      orgId,
      checkoutJobNumber,
      checkoutBoxId,
      warehouse,
      installDate,
      actor,
      25,
    );
    createdJobs.push({ jobNumber: checkoutJobNumber, boxId: checkoutBoxId });

    const checkoutPayload = await postRoute(
      '/jobs/checkout-all',
      {
        jobNumber: checkoutJobNumber,
      },
      token,
    );
    assert(
      (checkoutPayload?.warnings || []).some((entry) => asTrimmedString(entry).includes(`job ${checkoutJobNumber}`)),
      'Expected checkout-all route to include the checkout warning for the verification job.',
    );
    assert(
      checkoutPayload?.data?.summary?.isStagedForPickup === false,
      'Checkout-all route should not mark the job staged.',
    );
    assert(
      (checkoutPayload?.data?.allocations || []).some(
        (entry) => entry.boxId === checkoutBoxId && entry.boxStatus === 'CHECKED_OUT',
      ),
      'Expected checkout-all route detail to show the allocated box as checked out.',
    );

    const stagedJobNumber = `95${uniqueSuffix}`;
    const stagedBoxId = `${warehouse}-RST-${uniqueSuffix}`;
    await createAllocatedInStockJob(
      client,
      orgId,
      stagedJobNumber,
      stagedBoxId,
      warehouse,
      installDate,
      actor,
      25,
    );
    createdJobs.push({ jobNumber: stagedJobNumber, boxId: stagedBoxId });

    const stagedPayload = await postRoute(
      '/jobs/set-staged-pickup',
      {
        jobNumber: stagedJobNumber,
        isStagedForPickup: true,
        autoCheckoutRemaining: true,
      },
      token,
    );
    assert(
      (stagedPayload?.warnings || []).some((entry) => asTrimmedString(entry).includes(`job ${stagedJobNumber}`)),
      'Expected staged pickup route to include the checkout warning for the verification job.',
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
      'Expected staged pickup route detail to show the allocated box as checked out.',
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
  console.error(error);
  process.exitCode = 1;
});
