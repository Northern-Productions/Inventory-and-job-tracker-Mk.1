import "../load-env.mjs";
import crypto from "node:crypto";
import { Client } from "pg";
import {
  addBox,
  applyAllocationPlan,
  buildJobDetail,
  findBoxById,
  previewAllocationPlan,
  removeAllocationFromJob,
  removeJobBoxAllocation,
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
  const random = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  return `${now.slice(-8)}${random}`;
}

function buildBoxPayload(boxId, orderDate, overrides = {}) {
  return {
    boxId,
    manufacturer: "3M Solar",
    filmName: "Prestige 60",
    widthIn: 60,
    initialFeet: 80,
    orderDate,
    receivedDate: "",
    notes: "Ordered allocation flow verification box.",
    ...overrides
  };
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

async function insertVerificationJob(client, orgId, jobNumber, warehouse, dueDate, actor) {
  const nowIso = new Date().toISOString();
  const jobId = crypto.randomUUID();
  const requirementId = crypto.randomUUID();
  const jobColumns = await getTableColumns(client, "jobs");
  const requirementColumns = await getTableColumns(client, "job_requirements");

  await insertAppRow(client, "jobs", jobColumns, {
    id: jobId,
    org_id: orgId,
    job_number: jobNumber,
    warehouse,
    sections: null,
    due_date: dueDate,
    lifecycle_status: "ACTIVE",
    notes: "Ordered allocation flow verification job.",
    created_at: nowIso,
    created_by: actor,
    updated_at: nowIso,
    updated_by: actor,
    crew_leader: "Ordered Flow",
    is_staged_for_pickup: false,
    is_labor_only: false
  });

  await insertAppRow(client, "job_requirements", requirementColumns, {
    id: requirementId,
    org_id: orgId,
    job_id: jobId,
    manufacturer: "3M Solar",
    film_name: "Prestige 60",
    width_in: 60,
    required_feet: 40,
    notes: "",
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
    assert(Number(orderedBox.feetAvailable || 0) === 0, `Expected ordered box feetAvailable to stay 0, received ${orderedBox.feetAvailable}.`);
    assert(
      Number(orderedBox.allocationPlanningFeet || 0) === 80,
      `Expected ordered box planning feet to start at 80, received ${orderedBox.allocationPlanningFeet}.`
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
    const receiptResult = await updateBox(
      client,
      orgId,
      buildUpdatePayload(refreshedBox, {
        receivedDate: dueDate,
        currentFeetOnRoll: 80
      }),
      actor
    );
    const receivedBox = receiptResult?.data?.box;
    assert(receivedBox, "Expected first receipt update to return the received box.");
    assert(receivedBox.status === "IN_STOCK", `Expected first receipt to move the box to IN_STOCK, received ${receivedBox.status}.`);

    refreshedBox = await findBoxById(client, orgId, boxId);
    assert(refreshedBox, "Received box could not be reloaded.");
    assert(Number(refreshedBox.feetAvailable || 0) === 40, `Expected received box feetAvailable to equal physical minus active allocations (40), received ${refreshedBox.feetAvailable}.`);

    jobDetail = await buildJobDetail(client, orgId, jobNumber);
    assert(jobDetail?.summary?.hasOrderedAllocations === false, "Expected ordered allocation pill to clear after first receipt.");

    let belowAllocatedError = null;
    try {
      await updateBox(
        client,
        orgId,
        buildUpdatePayload(refreshedBox, {
          receivedDate: dueDate,
          currentFeetOnRoll: 20
        }),
        actor
      );
    } catch (error) {
      belowAllocatedError = error;
    }

    assert(belowAllocatedError, "Expected reducing CurrentFeetOnRoll below active allocations to fail.");
    assert(
      /active allocated feet/i.test(asTrimmedString(belowAllocatedError?.message)),
      `Expected below-allocation rejection to mention active allocated feet, received ${belowAllocatedError?.message}.`
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
