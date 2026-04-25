import "../load-env.mjs";
import crypto from "node:crypto";
import { Client } from "pg";
import {
  addBox,
  applyAllocationPlan,
  buildJobDetail,
  buildJobsList,
  createFilmOrder,
  findBoxById,
  previewAllocationPlan,
  receiveOrderedBox,
  removeAllocationFromJob,
  removeJobBoxAllocation,
  setBoxStatus,
  updateBox,
} from "../src/app/internal.mjs";

function asTrimmedString(value) {
  return String(value || "").trim();
}

function requireDatabaseUrl() {
  const databaseUrl = asTrimmedString(process.env.DATABASE_URL);
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }
  return databaseUrl;
}

function requireOrgId() {
  const orgId = asTrimmedString(process.env.VERIFY_DB_PARITY_ORG_ID || process.env.DEFAULT_ORG_ID);
  if (!orgId) {
    throw new Error("VERIFY_DB_PARITY_ORG_ID or DEFAULT_ORG_ID is required.");
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
  const random = crypto.randomInt(0, 1_000_000)
    .toString()
    .padStart(6, "0");
  return `${now.slice(-8)}${random}`;
}

let rpcSavepointCounter = 0;

function buildBoxPayload(boxId, orderDate, overrides = {}) {
  const payload = {
    boxId,
    dealer: "Eastman Performance Films",
    manufacturer: "3M Solar",
    filmName: "Prestige 60",
    widthIn: 60,
    initialFeet: 80,
    orderDate,
    receivedDate: "",
    notes: "Ordered allocation flow verification box.",
    ...overrides
  };

  if (asTrimmedString(payload.receivedDate)) {
    if (!Object.prototype.hasOwnProperty.call(payload, 'coreType')) {
      payload.coreType = 'White plastic';
    }
    if (!Object.prototype.hasOwnProperty.call(payload, 'initialWeightLbs')) {
      payload.initialWeightLbs = 18;
    }
  }

  return payload;
}

function buildUpdatePayload(box, overrides = {}) {
  return {
    boxId: box.boxId,
    manufacturer: box.manufacturer,
    filmName: box.filmName,
    widthIn: box.widthIn,
    initialFeet: box.initialFeet,
    orderDate: box.orderDate,
    receivedDate: box.receivedDate,
    notes: box.notes || "",
    ...overrides
  };
}

async function configureRpcAuthContext(client, orgId) {
  const memberResult = await client.query(
    `
      select user_id::text as user_id
      from app.organization_members
      where org_id = $1::uuid
      order by created_at asc nulls first, user_id asc
      limit 1
    `,
    [orgId]
  );
  const userId = asTrimmedString(memberResult.rows[0]?.user_id);
  assert(userId, `No organization member found for org ${orgId}.`);

  const claims = JSON.stringify({
    sub: userId,
    email: 'ordered-box-flow-verifier@example.com',
    role: 'authenticated'
  });
  await client.query(
    `
      select
        set_config('request.jwt.claim.sub', $1::text, true),
        set_config('request.jwt.claim.role', 'authenticated', true),
        set_config('request.jwt.claim.email', 'ordered-box-flow-verifier@example.com', true),
        set_config('request.jwt.claims', $2::text, true)
    `,
    [userId, claims]
  );
}

async function invokeBoxesReceiveOrderedRpc(client, orgId, actor, payload) {
  const result = await client.query(
    `
      select public.api_acl_boxes_receive_ordered(
        $1::uuid,
        $2::text,
        $3::jsonb
      ) as result
    `,
    [orgId, actor, JSON.stringify(payload)]
  );

  const rawValue = result.rows[0]?.result ?? null;
  const rawResult =
    typeof rawValue === 'string'
      ? JSON.parse(rawValue)
      : rawValue && typeof rawValue === 'object' && rawValue.data && typeof rawValue.data === 'object'
        ? rawValue.data
        : rawValue;
  const boxId = asTrimmedString(rawResult?.boxId);
  const box = boxId ? await findBoxById(client, orgId, boxId) : null;
  return {
    data: {
      box,
      logId: asTrimmedString(rawResult?.logId)
    },
    warnings: Array.isArray(rawResult?.warnings) ? rawResult.warnings : []
  };
}

async function invokeAllocationsApplyRpc(client, orgId, actor, payload) {
  const result = await client.query(
    `
      select public.api_acl_allocations_apply(
        $1::uuid,
        $2::text,
        $3::jsonb
      ) as result
    `,
    [orgId, actor, JSON.stringify(payload)]
  );

  const rawValue = result.rows[0]?.result ?? null;
  if (typeof rawValue === 'string') {
    return JSON.parse(rawValue);
  }
  if (rawValue && typeof rawValue === 'object' && rawValue.data && typeof rawValue.data === 'object') {
    return rawValue.data;
  }
  return rawValue;
}

async function captureExpectedRpcError(client, callback) {
  rpcSavepointCounter += 1;
  const savepointName = `expected_rpc_error_${rpcSavepointCounter}`;
  await client.query(`savepoint ${savepointName}`);
  try {
    const result = await callback();
    await client.query(`release savepoint ${savepointName}`);
    return { result, error: null };
  } catch (error) {
    await client.query(`rollback to savepoint ${savepointName}`);
    await client.query(`release savepoint ${savepointName}`);
    return { result: null, error };
  }
}

async function resolveWarehouseCode(client, orgId) {
  const warehouseRow = await client.query(
    `
      select code::text as code
      from app.warehouses
      where org_id = $1::uuid
      order by code
      limit 1
    `,
    [orgId]
  );
  return asTrimmedString(warehouseRow.rows[0]?.code) || "IL1";
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
    [tableName]
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
      insert into app.${tableName} (${columns.join(", ")})
      values (${placeholders.join(", ")})
    `,
    values
  );
}

async function insertVerificationJob(client, orgId, jobNumber, warehouse, dueDate, actor, overrides = {}) {
  const nowIso = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const requirementId = crypto.randomUUID();
  const jobColumns = await getTableColumns(client, "jobs");
  const requirementColumns = await getTableColumns(client, "job_requirements");
  const requiredFeet = Number(overrides.requiredFeet || 40);
  const widthIn = Number(overrides.widthIn || 60);
  const manufacturer = asTrimmedString(overrides.manufacturer) || "3M Solar";
  const filmName = asTrimmedString(overrides.filmName) || "Prestige 60";
  const crewLeader = asTrimmedString(overrides.crewLeader) || "Ordered Flow";
  const jobNotes = asTrimmedString(overrides.jobNotes) || "Ordered allocation flow verification job.";
  const requirementNotes = asTrimmedString(overrides.requirementNotes);

  await insertAppRow(client, "jobs", jobColumns, {
    id: jobId,
    org_id: orgId,
    job_number: jobNumber,
    warehouse,
    sections: null,
    due_date: dueDate,
    lifecycle_status: "ACTIVE",
    notes: jobNotes,
    created_at: nowIso,
    created_by: actor,
    updated_at: nowIso,
    updated_by: actor,
    crew_leader: crewLeader,
    is_staged_for_pickup: false,
    is_labor_only: false
  });

  await insertAppRow(client, "job_requirements", requirementColumns, {
    id: requirementId,
    org_id: orgId,
    job_id: jobId,
    manufacturer,
    film_name: filmName,
    width_in: widthIn,
    required_feet: requiredFeet,
    notes: requirementNotes,
    created_at: nowIso,
    created_by: actor,
    updated_at: nowIso,
    updated_by: actor
  });

  return {
    jobId,
    requirementId
  };
}

async function main() {
  const client = new Client({
    connectionString: requireDatabaseUrl(),
    ssl: { rejectUnauthorized: false }
  });
  const orgId = requireOrgId();
  const actor = "ordered-box-flow-verifier";
  let transactionStarted = false;

  await client.connect();

  try {
    await client.query("begin");
    transactionStarted = true;
    await configureRpcAuthContext(client, orgId);

    const warehouse = await resolveWarehouseCode(client, orgId);
    const uniqueSuffix = buildUniqueSuffix();
    const boxId = `${warehouse}-ORD-${uniqueSuffix}`;
    const jobNumber = `99${uniqueSuffix}`;
    const dueDate = new Date().toISOString().slice(0, 10);

    const createdJob = await insertVerificationJob(client, orgId, jobNumber, warehouse, dueDate, actor);
    const requirementId = asTrimmedString(createdJob?.requirementId);
    assert(requirementId, "Failed to create a verification job requirement.");

    const addedBox = await addBox(client, orgId, buildBoxPayload(boxId, dueDate), actor);
    const orderedBox = addedBox?.data?.box;
    assert(orderedBox, "Failed to create the ordered verification box.");
    assert(orderedBox.status === "ORDERED", `Expected ORDERED status after add, received ${orderedBox.status}.`);
    assert(
      orderedBox.dealer === "Eastman Performance Films",
      `Expected ordered verification box dealer to persist on add, received ${orderedBox.dealer}.`
    );
    assert(Number(orderedBox.feetAvailable || 0) === 0, `Expected ordered box feetAvailable to stay 0, received ${orderedBox.feetAvailable}.`);
    assert(
      Number(orderedBox.allocationPlanningFeet || 0) === 80,
      `Expected ordered box planning feet to start at 80, received ${orderedBox.allocationPlanningFeet}.`
    );

    const dealerUpdatedEnvelope = await updateBox(
      client,
      orgId,
      buildUpdatePayload(orderedBox, {
        dealer: "Accent",
        notes: "Ordered allocation flow verification box. Dealer updated."
      }),
      actor
    );
    const dealerUpdatedBox = dealerUpdatedEnvelope?.data?.box;
    assert(dealerUpdatedBox, "Expected updateBox to return the dealer-updated verification box.");
    assert(
      dealerUpdatedBox.dealer === "Accent",
      `Expected updateBox to persist the revised dealer, received ${dealerUpdatedBox?.dealer}.`
    );

    const preview = await previewAllocationPlan(client, orgId, {
      boxId,
      jobNumber,
      requestedFeet: 40,
      requestedWidthIn: 60,
      requirementId,
      jobWarehouse: warehouse
    });
    assert(preview.sourceBoxStatus === "ORDERED", `Expected preview source box to stay ORDERED, received ${preview.sourceBoxStatus}.`);
    assert(
      Number(preview.sourceBoxPlanningFeet || 0) >= 40,
      `Expected preview planning feet to cover 40 LF, received ${preview.sourceBoxPlanningFeet}.`
    );

    const applyResult = await applyAllocationPlan(
      client,
      orgId,
      {
        boxId,
        jobNumber,
        requestedFeet: 40,
        requestedWidthIn: 60,
        requirementId,
        selectedSuggestionBoxIds: [],
        extraAllocations: []
      },
      actor
    );
    const createdAllocation = (applyResult?.data?.allocations || []).find((entry) => entry.boxId === boxId);
    assert(createdAllocation, "Expected ordered allocation apply to create a box allocation.");
    assert(
      Number(createdAllocation.allocatedFeet || 0) === 40,
      `Expected ordered allocation to reserve 40 LF, received ${createdAllocation?.allocatedFeet}.`
    );

    let refreshedBox = await findBoxById(client, orgId, boxId);
    assert(refreshedBox, "Created ordered box could not be reloaded after apply.");
    assert(
      refreshedBox.dealer === "Accent",
      `Expected dealer to remain Accent after allocation apply, received ${refreshedBox?.dealer}.`
    );
    assert(Number(refreshedBox.feetAvailable || 0) === 0, `Expected ordered box feetAvailable to remain 0 after apply, received ${refreshedBox.feetAvailable}.`);
    assert(
      Number(refreshedBox.allocationPlanningFeet || 0) === 40,
      `Expected ordered box planning feet to drop to 40 after apply, received ${refreshedBox.allocationPlanningFeet}.`
    );

    let jobDetail = await buildJobDetail(client, orgId, jobNumber);
    assert(jobDetail?.summary?.hasOrderedAllocations === true, "Expected job summary to report ordered allocations after apply.");
    assert(Number(jobDetail?.summary?.allocatedFeet || 0) >= 40, `Expected job allocated feet to increase after apply, received ${jobDetail?.summary?.allocatedFeet}.`);

    const extraBoxId = `${warehouse}-EXT-${uniqueSuffix}`;
    const addedExtraBox = await addBox(client, orgId, buildBoxPayload(extraBoxId, dueDate), actor);
    const extraBox = addedExtraBox?.data?.box;
    assert(extraBox, "Failed to create the extra verification box.");

    const extraApplyResult = await applyAllocationPlan(
      client,
      orgId,
      {
        boxId: extraBoxId,
        jobNumber,
        requestedFeet: 0,
        requestedWidthIn: 60,
        requirementId,
        selectedSuggestionBoxIds: [],
        extraAllocations: [{ boxId: extraBoxId, allocatedFeet: 80 }]
      },
      actor
    );
    const extraAllocation = (extraApplyResult?.data?.allocations || []).find((entry) => entry.boxId === extraBoxId);
    assert(extraAllocation, "Expected extra-only allocation apply to create an allocation.");
    assert(extraAllocation.allocationKind === "EXTRA", `Expected extra allocation kind, received ${extraAllocation.allocationKind}.`);
    assert(
      Number(extraAllocation.allocatedFeet || 0) === 80,
      `Expected extra allocation to reserve the whole 80 LF box, received ${extraAllocation.allocatedFeet}.`
    );

    jobDetail = await buildJobDetail(client, orgId, jobNumber);
    const fulfilledRequirement = (jobDetail?.requirements || []).find((entry) => entry.requirementId === requirementId);
    assert(fulfilledRequirement, "Expected fulfilled requirement to stay visible after extra allocation.");
    assert(
      Number(fulfilledRequirement.allocatedFeet || 0) === 40,
      `Expected extra allocation not to increase requirement coverage, received ${fulfilledRequirement.allocatedFeet}.`
    );
    assert(
      Number(fulfilledRequirement.remainingFeet || 0) === 0,
      `Expected fulfilled requirement to remain fulfilled after extra allocation, received ${fulfilledRequirement.remainingFeet}.`
    );

    const mismatchBoxId = `${warehouse}-BAD-${uniqueSuffix}`;
    await addBox(
      client,
      orgId,
      buildBoxPayload(mismatchBoxId, dueDate, {
        manufacturer: "Llumar",
        filmName: "RN 07"
      }),
      actor
    );
    let incompatibleExtraError = null;
    try {
      await applyAllocationPlan(
        client,
        orgId,
        {
          boxId: mismatchBoxId,
          jobNumber,
          requestedFeet: 0,
          requestedWidthIn: 60,
          requirementId,
          selectedSuggestionBoxIds: [],
          extraAllocations: [{ boxId: mismatchBoxId, allocatedFeet: 80 }]
        },
        actor
      );
    } catch (error) {
      incompatibleExtraError = error;
    }
    assert(incompatibleExtraError, "Expected incompatible extra allocation to fail.");
    assert(
      /does not match requirement|compatible film/i.test(asTrimmedString(incompatibleExtraError?.message)),
      `Expected incompatible extra rejection to mention requirement compatibility, received ${incompatibleExtraError?.message}.`
    );

    const exteriorParityJobNumber = `97${uniqueSuffix}`;
    const exteriorParityJob = await insertVerificationJob(
      client,
      orgId,
      exteriorParityJobNumber,
      warehouse,
      dueDate,
      actor,
      {
        requiredFeet: 75,
        manufacturer: '3M Solar',
        filmName: 'Prestige 40',
        widthIn: 60,
        crewLeader: 'Exterior Parity',
        jobNotes: 'Exterior allocation parity verification job.'
      }
    );
    const exteriorParityRequirementId = asTrimmedString(exteriorParityJob?.requirementId);
    assert(exteriorParityRequirementId, 'Expected exterior parity verification job creation to return a requirement ID.');

    const exteriorSourceBoxId = `${warehouse}-PX1-${uniqueSuffix}`;
    const exteriorSuggestionBoxId = `${warehouse}-PX2-${uniqueSuffix}`;
    for (const { boxId: exteriorBoxId, initialFeet, notes } of [
      {
        boxId: exteriorSourceBoxId,
        initialFeet: 28,
        notes: 'Exterior parity verification source box.'
      },
      {
        boxId: exteriorSuggestionBoxId,
        initialFeet: 42,
        notes: 'Exterior parity verification suggestion box.'
      }
    ]) {
      const exteriorBoxEnvelope = await addBox(
        client,
        orgId,
        buildBoxPayload(exteriorBoxId, dueDate, {
          filmName: 'Prestige 40 Exterior',
          initialFeet,
          receivedDate: dueDate,
          notes
        }),
        actor
      );
      const exteriorBox = exteriorBoxEnvelope?.data?.box;
      assert(exteriorBox, `Expected addBox to create exterior parity box ${exteriorBoxId}.`);
      assert(
        exteriorBox.status === 'IN_STOCK',
        `Expected exterior parity box ${exteriorBoxId} to start IN_STOCK, received ${exteriorBox?.status}.`
      );
      assert(
        Number(exteriorBox.feetAvailable || 0) === initialFeet,
        `Expected exterior parity box ${exteriorBoxId} to expose ${initialFeet} available LF, received ${exteriorBox?.feetAvailable}.`
      );
    }

    const exteriorPreview = await previewAllocationPlan(client, orgId, {
      boxId: exteriorSourceBoxId,
      jobNumber: exteriorParityJobNumber,
      requestedFeet: 75,
      requestedWidthIn: 60,
      requirementId: exteriorParityRequirementId,
      selectedSuggestionBoxIds: [exteriorSuggestionBoxId],
      jobWarehouse: warehouse,
      crossWarehouse: true
    });
    assert(
      exteriorPreview.sourceBoxStatus === 'IN_STOCK',
      `Expected exterior parity preview source box to stay IN_STOCK, received ${exteriorPreview.sourceBoxStatus}.`
    );
    assert(
      Number(exteriorPreview.sourceSuggestedFeet || 0) === 28,
      `Expected exterior parity preview to allocate 28 LF from the source exterior box, received ${exteriorPreview.sourceSuggestedFeet}.`
    );
    assert(
      (exteriorPreview.suggestions || []).some((entry) => entry.boxId === exteriorSuggestionBoxId),
      `Expected exterior parity preview to keep ${exteriorSuggestionBoxId} as a compatible suggestion.`
    );

    const exteriorApplyResult = await invokeAllocationsApplyRpc(
      client,
      orgId,
      actor,
      {
        boxId: exteriorSourceBoxId,
        jobNumber: exteriorParityJobNumber,
        requestedFeet: 75,
        requestedWidthIn: 60,
        requirementId: exteriorParityRequirementId,
        selectedSuggestionBoxIds: [exteriorSuggestionBoxId],
        extraAllocations: [],
        crossWarehouse: true,
        jobWarehouse: warehouse
      }
    );
    const exteriorAllocationIds = Array.isArray(exteriorApplyResult?.allocationIds)
      ? exteriorApplyResult.allocationIds.map((value) => asTrimmedString(value)).filter(Boolean)
      : [];
    const exteriorFilmOrderId = asTrimmedString(exteriorApplyResult?.filmOrderId);
    assert(
      exteriorAllocationIds.length === 2,
      `Expected SQL exterior parity apply to create two allocations, received ${JSON.stringify(exteriorAllocationIds)}.`
    );
    assert(
      !exteriorFilmOrderId,
      `Expected SQL exterior parity apply to leave the uncovered remainder unallocated, received ${exteriorFilmOrderId}.`
    );

    const exteriorJobDetail = await buildJobDetail(client, orgId, exteriorParityJobNumber);
    const exteriorRequirement = (exteriorJobDetail?.requirements || []).find(
      (entry) => entry.requirementId === exteriorParityRequirementId
    );
    assert(exteriorRequirement, 'Expected exterior parity requirement to remain visible on job detail.');
    assert(
      Number(exteriorRequirement?.allocatedFeet || 0) === 70,
      `Expected exterior parity requirement to show 70 covered feet, received ${exteriorRequirement?.allocatedFeet}.`
    );
    assert(
      Number(exteriorRequirement?.remainingFeet || 0) === 5,
      `Expected exterior parity requirement to show 5 remaining feet, received ${exteriorRequirement?.remainingFeet}.`
    );
    const exteriorFilmOrder = (exteriorJobDetail?.filmOrders || []).find(
      (entry) => entry.sourceBoxId === exteriorSourceBoxId
    );
    assert(
      !exteriorFilmOrder,
      'Expected exterior parity job detail to avoid auto-creating a shortage film order for uncovered LF.'
    );

    const transferJobNumber = `96${uniqueSuffix}`;
    const transferJob = await insertVerificationJob(
      client,
      orgId,
      transferJobNumber,
      warehouse,
      dueDate,
      actor,
      {
        requiredFeet: 12,
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        crewLeader: 'Transfer Eligibility',
        jobNotes: 'Transfer allocation status verification job.'
      }
    );
    const transferRequirementId = asTrimmedString(transferJob?.requirementId);
    assert(transferRequirementId, 'Expected transfer verification job creation to return a requirement ID.');

    const transferBoxId = `${warehouse}-TRN-${uniqueSuffix}`;
    const transferBoxEnvelope = await addBox(
      client,
      orgId,
      buildBoxPayload(transferBoxId, dueDate, {
        receivedDate: dueDate,
        initialFeet: 24,
        notes: 'Transfer allocation status verification box.'
      }),
      actor
    );
    const transferBox = transferBoxEnvelope?.data?.box;
    assert(transferBox, 'Expected addBox to create the transfer verification box.');
    assert(
      transferBox.status === 'IN_STOCK',
      `Expected transfer verification box to start IN_STOCK, received ${transferBox?.status}.`
    );

    await client.query(
      `
        update app.boxes
        set status = 'TRANSFER'::app.box_status
        where org_id = $1::uuid
          and box_id = $2::text
      `,
      [orgId, transferBoxId]
    );

    const transferPreview = await previewAllocationPlan(client, orgId, {
      boxId: transferBoxId,
      jobNumber: transferJobNumber,
      requestedFeet: 12,
      requestedWidthIn: 60,
      requirementId: transferRequirementId,
      jobWarehouse: warehouse
    });
    assert(
      transferPreview.sourceBoxStatus === 'TRANSFER',
      `Expected transfer preview source status to stay TRANSFER, received ${transferPreview.sourceBoxStatus}.`
    );
    assert(
      Number(transferPreview.sourceSuggestedFeet || 0) === 12,
      `Expected transfer preview to allocate 12 LF from the transfer box, received ${transferPreview.sourceSuggestedFeet}.`
    );

    const transferApplyResult = await invokeAllocationsApplyRpc(
      client,
      orgId,
      actor,
      {
        boxId: transferBoxId,
        jobNumber: transferJobNumber,
        requestedFeet: 12,
        requestedWidthIn: 60,
        requirementId: transferRequirementId,
        selectedSuggestionBoxIds: [],
        extraAllocations: [],
        crossWarehouse: true,
        jobWarehouse: warehouse
      }
    );
    const transferAllocationIds = Array.isArray(transferApplyResult?.allocationIds)
      ? transferApplyResult.allocationIds.map((value) => asTrimmedString(value)).filter(Boolean)
      : [];
    const transferAllocationRows = await client.query(
      `
        select box_id
        from app.allocations
        where org_id = $1::uuid
          and allocation_id = any($2::text[])
      `,
      [orgId, transferAllocationIds]
    );
    assert(
      transferAllocationIds.length >= 1,
      `Expected transfer eligibility apply to create at least one allocation, received ${JSON.stringify(transferAllocationIds)}.`
    );
    assert(
      transferAllocationRows.rows.some((row) => asTrimmedString(row.box_id) === transferBoxId),
      `Expected transfer eligibility apply to include ${transferBoxId}, received ${JSON.stringify(transferAllocationRows.rows)}.`
    );
    assert(
      !asTrimmedString(transferApplyResult?.filmOrderId),
      `Expected transfer eligibility apply to avoid auto-creating a film order, received ${transferApplyResult?.filmOrderId}.`
    );

    const transferJobDetail = await buildJobDetail(client, orgId, transferJobNumber);
    const transferRequirement = (transferJobDetail?.requirements || []).find(
      (entry) => entry.requirementId === transferRequirementId
    );
    assert(transferRequirement, 'Expected transfer verification requirement to remain visible on job detail.');
    assert(
      Number(transferRequirement?.allocatedFeet || 0) === 12,
      `Expected transfer verification requirement to show 12 covered feet, received ${transferRequirement?.allocatedFeet}.`
    );
    assert(
      Number(transferRequirement?.remainingFeet || 0) === 0,
      `Expected transfer verification requirement to show 0 remaining feet, received ${transferRequirement?.remainingFeet}.`
    );

    const zeroedJobNumber = `95${uniqueSuffix}`;
    const zeroedJob = await insertVerificationJob(
      client,
      orgId,
      zeroedJobNumber,
      warehouse,
      dueDate,
      actor,
      {
        requiredFeet: 10,
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        crewLeader: 'Zeroed Block',
        jobNotes: 'Zeroed allocation eligibility verification job.'
      }
    );
    const zeroedRequirementId = asTrimmedString(zeroedJob?.requirementId);
    assert(zeroedRequirementId, 'Expected zeroed verification job creation to return a requirement ID.');

    const zeroedBoxId = `${warehouse}-ZER-${uniqueSuffix}`;
    const zeroedBoxEnvelope = await addBox(
      client,
      orgId,
      buildBoxPayload(zeroedBoxId, dueDate, {
        receivedDate: dueDate,
        initialFeet: 20,
        notes: 'Zeroed allocation status verification box.'
      }),
      actor
    );
    const zeroedBox = zeroedBoxEnvelope?.data?.box;
    assert(zeroedBox, 'Expected addBox to create the zeroed verification box.');

    await client.query(
      `
        update app.boxes
        set status = 'ZEROED'::app.box_status,
            feet_available = 0,
            zeroed_date = current_date,
            zeroed_reason = 'Verification zeroed box.',
            zeroed_by = $3::text
        where org_id = $1::uuid
          and box_id = $2::text
      `,
      [orgId, zeroedBoxId, actor]
    );

    let zeroedPreviewError = null;
    try {
      await previewAllocationPlan(client, orgId, {
        boxId: zeroedBoxId,
        jobNumber: zeroedJobNumber,
        requestedFeet: 10,
        requestedWidthIn: 60,
        requirementId: zeroedRequirementId,
        jobWarehouse: warehouse
      });
    } catch (error) {
      zeroedPreviewError = error;
    }
    assert(zeroedPreviewError, 'Expected zeroed preview to reject the source box.');
    assert(
      /Only in-stock, ordered, or transfer boxes can be allocated/i.test(asTrimmedString(zeroedPreviewError?.message)),
      `Expected zeroed preview rejection to mention allowed statuses, received ${zeroedPreviewError?.message}.`
    );

    const { error: zeroedApplyError } = await captureExpectedRpcError(client, () =>
      invokeAllocationsApplyRpc(
        client,
        orgId,
        actor,
        {
          boxId: zeroedBoxId,
          jobNumber: zeroedJobNumber,
          requestedFeet: 10,
          requestedWidthIn: 60,
          requirementId: zeroedRequirementId,
          selectedSuggestionBoxIds: [],
          extraAllocations: [],
          crossWarehouse: true,
          jobWarehouse: warehouse
        }
      )
    );
    assert(zeroedApplyError, 'Expected zeroed apply to reject the source box.');
    assert(
      /Only in-stock, ordered, or transfer boxes can be allocated/i.test(asTrimmedString(zeroedApplyError?.message)),
      `Expected zeroed apply rejection to mention allowed statuses, received ${zeroedApplyError?.message}.`
    );

    const exteriorAliasJobNumber = `94${uniqueSuffix}`;
    const exteriorAliasJob = await insertVerificationJob(
      client,
      orgId,
      exteriorAliasJobNumber,
      warehouse,
      dueDate,
      actor,
      {
        requiredFeet: 30,
        manufacturer: '3M Solar',
        filmName: 'Prestige 40',
        widthIn: 60,
        crewLeader: 'Exterior Alias',
        jobNotes: 'Exterior alias allocation parity verification job.'
      }
    );
    const exteriorAliasRequirementId = asTrimmedString(exteriorAliasJob?.requirementId);
    assert(exteriorAliasRequirementId, 'Expected exterior alias verification job creation to return a requirement ID.');

    const exteriorAliasBoxId = `${warehouse}-PA1-${uniqueSuffix}`;
    const exteriorAliasBoxEnvelope = await addBox(
      client,
      orgId,
      buildBoxPayload(exteriorAliasBoxId, dueDate, {
        filmName: '3M Prestige 40 Exterior (PR40 Ext)',
        initialFeet: 30,
        receivedDate: dueDate,
        notes: 'Exterior alias source box for allocation parity verification.'
      }),
      actor
    );
    const exteriorAliasBox = exteriorAliasBoxEnvelope?.data?.box;
    assert(exteriorAliasBox, 'Expected addBox to create the exterior alias verification box.');
    assert(
      exteriorAliasBox.status === 'IN_STOCK',
      `Expected exterior alias verification box to start IN_STOCK, received ${exteriorAliasBox?.status}.`
    );

    const exteriorAliasPreview = await previewAllocationPlan(client, orgId, {
      boxId: exteriorAliasBoxId,
      jobNumber: exteriorAliasJobNumber,
      requestedFeet: 30,
      requestedWidthIn: 60,
      requirementId: exteriorAliasRequirementId,
      jobWarehouse: warehouse,
      crossWarehouse: true
    });
    assert(
      Number(exteriorAliasPreview.sourceSuggestedFeet || 0) === 30,
      `Expected exterior alias preview to cover all 30 LF from the source box, received ${exteriorAliasPreview?.sourceSuggestedFeet}.`
    );
    assert(
      Number(exteriorAliasPreview.defaultRemainingFeet || 0) === 0,
      `Expected exterior alias preview to leave no remaining LF, received ${exteriorAliasPreview?.defaultRemainingFeet}.`
    );

    const exteriorAliasApplyResult = await invokeAllocationsApplyRpc(
      client,
      orgId,
      actor,
      {
        boxId: exteriorAliasBoxId,
        jobNumber: exteriorAliasJobNumber,
        requestedFeet: 30,
        requestedWidthIn: 60,
        requirementId: exteriorAliasRequirementId,
        selectedSuggestionBoxIds: [],
        extraAllocations: [],
        crossWarehouse: true,
        jobWarehouse: warehouse
      }
    );
    const exteriorAliasAllocationIds = Array.isArray(exteriorAliasApplyResult?.allocationIds)
      ? exteriorAliasApplyResult.allocationIds.map((value) => asTrimmedString(value)).filter(Boolean)
      : [];
    assert(
      exteriorAliasAllocationIds.length === 1,
      `Expected exterior alias apply to create one allocation, received ${JSON.stringify(exteriorAliasAllocationIds)}.`
    );
    assert(
      !asTrimmedString(exteriorAliasApplyResult?.filmOrderId),
      `Expected exterior alias apply to avoid creating a shortage film order, received ${exteriorAliasApplyResult?.filmOrderId}.`
    );

    const exteriorAliasJobDetail = await buildJobDetail(client, orgId, exteriorAliasJobNumber);
    const exteriorAliasRequirement = (exteriorAliasJobDetail?.requirements || []).find(
      (entry) => entry.requirementId === exteriorAliasRequirementId
    );
    assert(exteriorAliasRequirement, 'Expected exterior alias requirement to remain visible on job detail.');
    assert(
      Number(exteriorAliasRequirement?.allocatedFeet || 0) === 30,
      `Expected exterior alias requirement to show 30 allocated feet, received ${exteriorAliasRequirement?.allocatedFeet}.`
    );
    assert(
      Number(exteriorAliasRequirement?.remainingFeet || 0) === 0,
      `Expected exterior alias requirement to show 0 remaining feet, received ${exteriorAliasRequirement?.remainingFeet}.`
    );

    const exteriorOnlyJobNumber = `93${uniqueSuffix}`;
    const exteriorOnlyJob = await insertVerificationJob(
      client,
      orgId,
      exteriorOnlyJobNumber,
      warehouse,
      dueDate,
      actor,
      {
        requiredFeet: 10,
        manufacturer: '3M Solar',
        filmName: 'Prestige 40 Exterior',
        widthIn: 60,
        crewLeader: 'Exterior Only',
        jobNotes: 'Inverse exterior allocation rejection verification job.'
      }
    );
    const exteriorOnlyRequirementId = asTrimmedString(exteriorOnlyJob?.requirementId);
    assert(exteriorOnlyRequirementId, 'Expected exterior-only verification job creation to return a requirement ID.');

    const baseOnlyBoxId = `${warehouse}-PI1-${uniqueSuffix}`;
    const baseOnlyBoxEnvelope = await addBox(
      client,
      orgId,
      buildBoxPayload(baseOnlyBoxId, dueDate, {
        filmName: 'Prestige 40',
        initialFeet: 20,
        receivedDate: dueDate,
        notes: 'Base-only box for exterior requirement mismatch verification.'
      }),
      actor
    );
    const baseOnlyBox = baseOnlyBoxEnvelope?.data?.box;
    assert(baseOnlyBox, 'Expected addBox to create the inverse exterior parity verification box.');
    assert(
      baseOnlyBox.status === 'IN_STOCK',
      `Expected base-only mismatch box to start IN_STOCK, received ${baseOnlyBox?.status}.`
    );

    let exteriorPreviewMismatchError = null;
    try {
      await previewAllocationPlan(client, orgId, {
        boxId: baseOnlyBoxId,
        jobNumber: exteriorOnlyJobNumber,
        requestedFeet: 10,
        requestedWidthIn: 60,
        requirementId: exteriorOnlyRequirementId,
        jobWarehouse: warehouse,
        crossWarehouse: true
      });
    } catch (error) {
      exteriorPreviewMismatchError = error;
    }
    assert(exteriorPreviewMismatchError, 'Expected preview parity check to reject a base roll for an exterior requirement.');
    assert(
      /does not match requirement/i.test(asTrimmedString(exteriorPreviewMismatchError?.message)),
      `Expected preview parity mismatch to mention requirement mismatch, received ${exteriorPreviewMismatchError?.message}.`
    );

    const { error: exteriorApplyMismatchError } = await captureExpectedRpcError(client, () =>
      invokeAllocationsApplyRpc(
        client,
        orgId,
        actor,
        {
          boxId: baseOnlyBoxId,
          jobNumber: exteriorOnlyJobNumber,
          requestedFeet: 10,
          requestedWidthIn: 60,
          requirementId: exteriorOnlyRequirementId,
          selectedSuggestionBoxIds: [],
          extraAllocations: [],
          crossWarehouse: true,
          jobWarehouse: warehouse
        }
      )
    );
    assert(exteriorApplyMismatchError, 'Expected SQL apply parity check to reject a base roll for an exterior requirement.');
    assert(
      /does not match requirement/i.test(asTrimmedString(exteriorApplyMismatchError?.message)),
      `Expected SQL apply parity mismatch to mention requirement mismatch, received ${exteriorApplyMismatchError?.message}.`
    );

    const extraRemovalEnvelope = await removeJobBoxAllocation(
      client,
      orgId,
      {
        jobNumber,
        allocationId: extraAllocation.allocationId,
        reason: "Extra allocation verification cleanup."
      },
      actor
    );
    const extraRemoval = extraRemovalEnvelope?.data;
    assert(Number(extraRemoval?.removedAllocationCount || 0) === 1, "Expected extra allocation cleanup to cancel exactly one allocation.");
    assert(
      extraRemoval?.jobNumber === jobNumber,
      `Expected extra allocation removal response to include job ${jobNumber}, received ${extraRemoval?.jobNumber}.`
    );

    const removal = await removeAllocationFromJob(
      client,
      orgId,
      jobNumber,
      createdAllocation.allocationId,
      actor,
      "Ordered allocation flow verification cleanup."
    );
    assert(Number(removal?.removedAllocationCount || 0) === 1, "Expected ordered allocation removal to cancel exactly one allocation.");

    refreshedBox = await findBoxById(client, orgId, boxId);
    assert(refreshedBox, "Ordered box could not be reloaded after removal.");
    assert(
      Number(refreshedBox.feetAvailable || 0) === 0,
      `Expected ordered box feetAvailable to remain 0 after removal, received ${refreshedBox.feetAvailable}.`
    );
    assert(
      Number(refreshedBox.allocationPlanningFeet || 0) === 80,
      `Expected ordered box planning feet to restore to 80 after removal, received ${refreshedBox.allocationPlanningFeet}.`
    );

    const reapplyResult = await applyAllocationPlan(
      client,
      orgId,
      {
        boxId,
        jobNumber,
        requestedFeet: 40,
        requestedWidthIn: 60,
        requirementId,
        selectedSuggestionBoxIds: [],
        extraAllocations: []
      },
      actor
    );
    const reappliedAllocation = (reapplyResult?.data?.allocations || []).find((entry) => entry.boxId === boxId);
    assert(reappliedAllocation, "Expected ordered allocation reapply to create a fresh allocation.");

    refreshedBox = await findBoxById(client, orgId, boxId);
    const receiptResult = await receiveOrderedBox(
      client,
      orgId,
      {
        boxId,
        receivedWeightLbs: 18
      },
      actor
    );
    const receivedBox = receiptResult?.data?.box;
    assert(receivedBox, "Expected first receipt update to return the received box.");
    assert(receivedBox.status === "IN_STOCK", `Expected first receipt to move the box to IN_STOCK, received ${receivedBox.status}.`);

    refreshedBox = await findBoxById(client, orgId, boxId);
    assert(refreshedBox, "Received box could not be reloaded.");
    assert(
      refreshedBox.dealer === "Accent",
      `Expected dealer to survive ordered receipt, received ${refreshedBox?.dealer}.`
    );
    assert(Number(refreshedBox.feetAvailable || 0) === 40, `Expected received box feetAvailable to equal physical minus active allocations (40), received ${refreshedBox.feetAvailable}.`);

    jobDetail = await buildJobDetail(client, orgId, jobNumber);
    assert(jobDetail?.summary?.hasOrderedAllocations === false, "Expected ordered allocation pill to clear after first receipt.");

    const shortageJobNumber = `98${uniqueSuffix}`;
    const shortageJob = await insertVerificationJob(
      client,
      orgId,
      shortageJobNumber,
      warehouse,
      dueDate,
      actor,
      {
        requiredFeet: 60,
        crewLeader: "Shortage Flow",
        jobNotes: "Ordered receipt shortage reconciliation verification job."
      }
    );
    const shortageRequirementId = asTrimmedString(shortageJob?.requirementId);
    assert(shortageRequirementId, "Expected shortage verification job creation to return a requirement ID.");

    const shortageBoxId = `${warehouse}-SHO-${uniqueSuffix}`;
    const shortageBoxEnvelope = await addBox(
      client,
      orgId,
      buildBoxPayload(shortageBoxId, dueDate, {
        initialFeet: 30,
        notes: "Ordered receipt shortage reconciliation verification box."
      }),
      actor
    );
    const shortageBox = shortageBoxEnvelope?.data?.box;
    assert(shortageBox, "Expected addBox to create the shortage verification box.");
    assert(shortageBox.status === "ORDERED", `Expected shortage verification box to start ORDERED, received ${shortageBox?.status}.`);

    const shortageApplyResult = await applyAllocationPlan(
      client,
      orgId,
      {
        boxId: shortageBoxId,
        jobNumber: shortageJobNumber,
        requestedFeet: 30,
        requestedWidthIn: 60,
        requirementId: shortageRequirementId,
        selectedSuggestionBoxIds: [],
        extraAllocations: []
      },
      actor
    );
    const shortageAllocation = (shortageApplyResult?.data?.allocations || []).find((entry) => entry.boxId === shortageBoxId);
    assert(shortageAllocation, "Expected ordered shortage apply to create an allocation.");
    assert(
      Number(shortageAllocation?.allocatedFeet || 0) === 30,
      `Expected shortage verification allocation to reserve 30 LF, received ${shortageAllocation?.allocatedFeet}.`
    );

    const shortageReceiveResult = await invokeBoxesReceiveOrderedRpc(client, orgId, actor, {
      boxId: shortageBoxId,
      receivedWeightLbs: 18,
      lotRun: "VERIFY-SHORTAGE"
    });
    const shortageReceivedBox = shortageReceiveResult?.data?.box;
    assert(shortageReceivedBox, "Expected api_acl_boxes_receive_ordered to return the shortage verification box.");
    assert(
      shortageReceivedBox.status === "IN_STOCK",
      `Expected shortage verification receipt to move the box to IN_STOCK, received ${shortageReceivedBox?.status}.`
    );
    assert(
      !(shortageReceiveResult?.warnings || []).some((warning) => /shortage film order/i.test(asTrimmedString(warning))),
      `Expected shortage verification receipt to avoid auto shortage film-order warnings, received ${JSON.stringify(shortageReceiveResult?.warnings || [])}.`
    );

    const shortageFilmOrderRows = await client.query(
      `
        select
          film_order_id,
          warehouse,
          requested_feet::integer as requested_feet,
          remaining_to_order_feet::integer as remaining_to_order_feet,
          source_box_id,
          status::text as status
        from app.film_orders
        where org_id = $1::uuid
          and upper(trim(job_number)) = upper(trim($2))
          and source_box_id = $3::text
          and status = 'FILM_ORDER'
        order by created_at asc, film_order_id asc
      `,
      [orgId, shortageJobNumber, shortageBoxId]
    );
    assert(
      shortageFilmOrderRows.rows.length === 0,
      `Expected shortage receipt flow to avoid auto-creating shortage film orders during receipt, received ${shortageFilmOrderRows.rows.length}.`
    );

    const shortageJobDetail = await buildJobDetail(client, orgId, shortageJobNumber);
    assert(
      Number(shortageJobDetail?.summary?.filmOrderCount || 0) === 0,
      `Expected shortage verification job summary to avoid open auto film orders, received ${shortageJobDetail?.summary?.filmOrderCount}.`
    );
    assert(
      shortageJobDetail?.summary?.status === 'FILM_ORDER',
      `Expected shortage verification job summary to remain FILM_ORDER while material is short, received ${shortageJobDetail?.summary?.status}.`
    );

    let belowAllocatedError = null;
    try {
      await setBoxStatus(
        client,
        orgId,
        {
          boxId: refreshedBox.boxId,
          status: 'IN_STOCK',
          lastRollWeightLbs: 18,
          currentFeetOnRoll: 20,
          coreType: 'White plastic',
          auditNote: 'Ordered allocation flow verification under-allocation guard.'
        },
        actor
      );
    } catch (error) {
      belowAllocatedError = error;
    }

    assert(belowAllocatedError, "Expected reducing CurrentFeetOnRoll below active allocations to fail.");
    assert(
      /(locked|active) allocated feet/i.test(asTrimmedString(belowAllocatedError?.message)),
      `Expected below-allocation rejection to mention locked or active allocated feet, received ${belowAllocatedError?.message}.`
    );

    const linkedFilmOrderEnvelope = await createFilmOrder(
      client,
      orgId,
      {
        jobNumber,
        warehouse,
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        requestedFeet: 30
      },
      actor
    );
    const linkedFilmOrder = linkedFilmOrderEnvelope?.data;
    assert(linkedFilmOrder, 'Expected createFilmOrder to return a linked film order.');

    const linkedBoxId = `${warehouse}-LNK-${uniqueSuffix}`;
    const linkedBoxEnvelope = await addBox(
      client,
      orgId,
      buildBoxPayload(linkedBoxId, dueDate, {
        dealer: 'Decorative Films',
        initialFeet: 30,
        filmOrderId: linkedFilmOrder.filmOrderId,
        notes: 'Linked film-order receipt verification box.'
      }),
      actor
    );
    const linkedBox = linkedBoxEnvelope?.data?.box;
    assert(linkedBox, 'Expected addBox to create the linked receipt verification box.');
    assert(linkedBox.status === 'ORDERED', `Expected linked box to start ORDERED, received ${linkedBox.status}.`);

    let linkedJobDetail = await buildJobDetail(client, orgId, jobNumber);
    const orderedFilmOrder = (linkedJobDetail?.filmOrders || []).find(
      (entry) => entry.filmOrderId === linkedFilmOrder.filmOrderId
    );
    assert(orderedFilmOrder, 'Expected the linked film order to appear on job detail after linking a box.');
    assert(
      orderedFilmOrder.status === 'FILM_ON_THE_WAY',
      `Expected linked film order to move to FILM_ON_THE_WAY after ordering a box, received ${orderedFilmOrder.status}.`
    );
    assert(
      orderedFilmOrder.linkedBoxes[0]?.dealer === 'Decorative Films',
      `Expected linked film order box dealer to persist before receipt, received ${orderedFilmOrder.linkedBoxes[0]?.dealer}.`
    );

    const receiveResult = await invokeBoxesReceiveOrderedRpc(client, orgId, actor, {
      boxId: linkedBoxId,
      receivedWeightLbs: 20,
      lotRun: 'VERIFY-LINKED'
    });
    assert(receiveResult, 'Expected api_acl_boxes_receive_ordered to return a response.');

    const resolvedFilmOrderRow = await client.query(
      `
        select status::text as status, covered_feet::integer as covered_feet, resolved_at
        from app.film_orders
        where org_id = $1::uuid
          and film_order_id = $2::text
      `,
      [orgId, linkedFilmOrder.filmOrderId]
    );
    assert(
      asTrimmedString(resolvedFilmOrderRow.rows[0]?.status) === 'FULFILLED',
      'Expected linked film order row to resolve to FULFILLED after check-in.'
    );
    assert(
      Number(resolvedFilmOrderRow.rows[0]?.covered_feet || 0) === 30,
      'Expected linked film order row to be fully covered after check-in.'
    );
    assert(
      asTrimmedString(resolvedFilmOrderRow.rows[0]?.resolved_at),
      'Expected linked film order row to capture resolved_at after check-in.'
    );
    const linkedRollHistoryRow = await client.query(
      `
        select count(*)::integer as count
        from app.roll_weight_log
        where org_id = $1::uuid
          and box_id = $2::text
      `,
      [orgId, linkedBoxId]
    );
    assert(
      Number(linkedRollHistoryRow.rows[0]?.count || 0) === 0,
      'Expected ordered-box receipt to avoid creating a roll history entry.'
    );

    linkedJobDetail = await buildJobDetail(client, orgId, jobNumber);
    const fulfilledFilmOrder = (linkedJobDetail?.filmOrders || []).find(
      (entry) => entry.filmOrderId === linkedFilmOrder.filmOrderId
    );
    assert(fulfilledFilmOrder, 'Expected linked film order to remain visible on job detail after receipt.');
    assert(
      fulfilledFilmOrder.status === 'FULFILLED',
      `Expected linked film order to resolve to FULFILLED on job detail, received ${fulfilledFilmOrder?.status}.`
    );
    assert(
      fulfilledFilmOrder.resolvedAt,
      'Expected linked film order to expose resolvedAt on job detail after receipt.'
    );
    assert(
      fulfilledFilmOrder.linkedBoxes.length === 1 && fulfilledFilmOrder.linkedBoxes[0]?.isReceived === true,
      'Expected fulfilled linked film order to mark its ordered box as received.'
    );
    assert(
      fulfilledFilmOrder.linkedBoxes[0]?.dealer === 'Decorative Films',
      `Expected fulfilled linked film order to retain the linked dealer, received ${fulfilledFilmOrder.linkedBoxes[0]?.dealer}.`
    );
    assert(
      Number(linkedJobDetail?.summary?.filmOrderCount || 0) === 0,
      `Expected job summary filmOrderCount to only count unresolved film orders, received ${linkedJobDetail?.summary?.filmOrderCount}.`
    );
    assert(
      (linkedJobDetail?.usageTimeline || []).some(
        (entry) =>
          entry.usageType === 'FILM_ORDER' &&
          entry.referenceId === linkedBoxId &&
          Number(entry.checkedOutQuantity || 0) === 30
      ),
      'Expected job usage timeline to include the ordered box history row with the linked box ID.'
    );

    const jobsList = await buildJobsList(client, orgId, 0, 'ACTIVE');
    const jobListEntry = jobsList.find((entry) => entry.jobNumber === jobNumber);
    assert(jobListEntry, `Expected buildJobsList to include verification job ${jobNumber}.`);
    assert(
      Number(jobListEntry?.filmOrderCount || 0) === 0,
      `Expected jobs list filmOrderCount to clear after fulfillment, received ${jobListEntry?.filmOrderCount}.`
    );

    const splitFilmOrderEnvelope = await createFilmOrder(
      client,
      orgId,
      {
        jobNumber,
        warehouse,
        manufacturer: '3M Solar',
        filmName: 'Prestige 60',
        widthIn: 60,
        requestedFeet: 60
      },
      actor
    );
    const splitFilmOrder = splitFilmOrderEnvelope?.data;
    assert(splitFilmOrder, 'Expected createFilmOrder to return the split linked film order.');

    const splitFirstBoxId = `${warehouse}-S1-${uniqueSuffix}`;
    const splitSecondBoxId = `${warehouse}-S2-${uniqueSuffix}`;
    for (const splitBoxId of [splitFirstBoxId, splitSecondBoxId]) {
      const splitBoxEnvelope = await addBox(
        client,
        orgId,
        buildBoxPayload(splitBoxId, dueDate, {
          dealer: splitBoxId === splitFirstBoxId ? 'Accent' : 'Kingston Coatings',
          initialFeet: 30,
          filmOrderId: splitFilmOrder.filmOrderId,
          notes: 'Split linked film-order receipt verification box.'
        }),
        actor
      );
      assert(splitBoxEnvelope?.data?.box, `Expected addBox to create split linked box ${splitBoxId}.`);
    }

    linkedJobDetail = await buildJobDetail(client, orgId, jobNumber);
    const splitOpenFilmOrder = (linkedJobDetail?.filmOrders || []).find(
      (entry) => entry.filmOrderId === splitFilmOrder.filmOrderId
    );
    assert(splitOpenFilmOrder, 'Expected split linked film order to appear on job detail.');
    assert(
      splitOpenFilmOrder.status === 'FILM_ON_THE_WAY',
      `Expected split linked film order to move to FILM_ON_THE_WAY after ordering both boxes, received ${splitOpenFilmOrder?.status}.`
    );
    assert(
      splitOpenFilmOrder.linkedBoxes.length === 2 &&
        splitOpenFilmOrder.linkedBoxes.every((entry) => entry.isReceived === false),
      'Expected split linked film order to mark both ordered boxes as unreceived before check-in.'
    );
    assert(
      splitOpenFilmOrder.linkedBoxes.some((entry) => entry.dealer === 'Accent') &&
        splitOpenFilmOrder.linkedBoxes.some((entry) => entry.dealer === 'Kingston Coatings'),
      'Expected split linked film order to expose the dealer for each linked ordered box.'
    );

    await invokeBoxesReceiveOrderedRpc(client, orgId, actor, {
      boxId: splitFirstBoxId,
      receivedWeightLbs: 20,
      lotRun: 'VERIFY-SPLIT-1'
    });

    const partiallyReceivedFilmOrderRow = await client.query(
      `
        select status::text as status, resolved_at
        from app.film_orders
        where org_id = $1::uuid
          and film_order_id = $2::text
      `,
      [orgId, splitFilmOrder.filmOrderId]
    );
    assert(
      asTrimmedString(partiallyReceivedFilmOrderRow.rows[0]?.status) === 'FILM_ON_THE_WAY',
      'Expected split linked film order row to stay FILM_ON_THE_WAY until all linked boxes are received.'
    );
    assert(
      !asTrimmedString(partiallyReceivedFilmOrderRow.rows[0]?.resolved_at),
      'Expected split linked film order row to stay unresolved until all linked boxes are received.'
    );

    linkedJobDetail = await buildJobDetail(client, orgId, jobNumber);
    const partiallyReceivedFilmOrder = (linkedJobDetail?.filmOrders || []).find(
      (entry) => entry.filmOrderId === splitFilmOrder.filmOrderId
    );
    assert(partiallyReceivedFilmOrder, 'Expected partially received split film order to remain visible on job detail.');
    assert(
      partiallyReceivedFilmOrder.status === 'FILM_ON_THE_WAY',
      `Expected partially received split film order to stay FILM_ON_THE_WAY, received ${partiallyReceivedFilmOrder?.status}.`
    );
    assert(
      partiallyReceivedFilmOrder.linkedBoxes.filter((entry) => entry.isReceived).length === 1,
      'Expected exactly one split linked box to be marked received after the first check-in.'
    );
    assert(
      Number(linkedJobDetail?.summary?.filmOrderCount || 0) === 1,
      `Expected job summary filmOrderCount to keep the split film order open after one receipt, received ${linkedJobDetail?.summary?.filmOrderCount}.`
    );

    await invokeBoxesReceiveOrderedRpc(client, orgId, actor, {
      boxId: splitSecondBoxId,
      receivedWeightLbs: 20,
      lotRun: 'VERIFY-SPLIT-2'
    });

    const fullyReceivedFilmOrderRow = await client.query(
      `
        select status::text as status, resolved_at
        from app.film_orders
        where org_id = $1::uuid
          and film_order_id = $2::text
      `,
      [orgId, splitFilmOrder.filmOrderId]
    );
    assert(
      asTrimmedString(fullyReceivedFilmOrderRow.rows[0]?.status) === 'FULFILLED',
      'Expected split linked film order row to resolve to FULFILLED once all linked boxes are received.'
    );
    assert(
      asTrimmedString(fullyReceivedFilmOrderRow.rows[0]?.resolved_at),
      'Expected split linked film order row to capture resolved_at after all linked boxes are received.'
    );

    linkedJobDetail = await buildJobDetail(client, orgId, jobNumber);
    const fulfilledSplitFilmOrder = (linkedJobDetail?.filmOrders || []).find(
      (entry) => entry.filmOrderId === splitFilmOrder.filmOrderId
    );
    assert(fulfilledSplitFilmOrder, 'Expected split film order to remain visible after both receipts.');
    assert(
      fulfilledSplitFilmOrder.status === 'FULFILLED',
      `Expected split film order to resolve to FULFILLED after both receipts, received ${fulfilledSplitFilmOrder?.status}.`
    );
    assert(
      fulfilledSplitFilmOrder.linkedBoxes.length === 2 &&
        fulfilledSplitFilmOrder.linkedBoxes.every((entry) => entry.isReceived === true),
      'Expected split film order to mark both linked boxes as received after both check-ins.'
    );
    assert(
      Number(linkedJobDetail?.summary?.filmOrderCount || 0) === 0,
      `Expected split film order fulfillment to clear the job summary filmOrderCount, received ${linkedJobDetail?.summary?.filmOrderCount}.`
    );

    console.log("Ordered box allocation flow OK.");
  } finally {
    if (transactionStarted) {
      await client.query("rollback");
    }
    await client.end();
  }
}

main().catch((error) => {
  console.error(
    "Ordered box allocation flow verification failed:",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
});
