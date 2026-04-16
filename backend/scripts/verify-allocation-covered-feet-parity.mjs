import "../load-env.mjs";
import { Client } from "pg";
import { buildJobDetail } from "../src/app/internal.mjs";

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

function findRequirement(detail, manufacturer, filmName, widthIn) {
  return (detail?.requirements || []).find((entry) =>
    asTrimmedString(entry?.manufacturer) === manufacturer
      && asTrimmedString(entry?.filmName) === filmName
      && Number(entry?.widthIn || 0) === widthIn
  );
}

function sumRequirementField(requirements, fieldName) {
  return (Array.isArray(requirements) ? requirements : []).reduce(
    (total, entry) => total + Number(entry?.[fieldName] || 0),
    0,
  );
}

async function main() {
  const client = new Client({
    connectionString: requireDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
  });
  const orgId = requireOrgId();

  await client.connect();

  try {
    const saveAllocationDefResult = await client.query(
      `select pg_get_functiondef('app_api.save_allocation(app.allocations)'::regprocedure) as definition`
    );
    const saveAllocationDefinition = asTrimmedString(saveAllocationDefResult.rows[0]?.definition);
    assert(
      /insert into app\.allocations[\s\S]*covered_feet/i.test(saveAllocationDefinition),
      "app_api.save_allocation is missing covered_feet in the insert path.",
    );
    assert(
      /covered_feet\s*=\s*excluded\.covered_feet/i.test(saveAllocationDefinition),
      "app_api.save_allocation is missing covered_feet in the conflict update path.",
    );

    const publicAllocationJsonDefResult = await client.query(
      `select pg_get_functiondef('app_api.public_allocation_json(app.allocations)'::regprocedure) as definition`
    );
    const publicAllocationJsonDefinition = asTrimmedString(publicAllocationJsonDefResult.rows[0]?.definition);
    assert(
      publicAllocationJsonDefinition.includes("'coveredFeet'"),
      "app_api.public_allocation_json is missing the coveredFeet field.",
    );

    const coverageResult = await client.query(
      `select * from app_api.plan_allocation_coverage(85, 26, 72, 36)`
    );
    const coverageRow = coverageResult.rows[0] || {};
    assert(
      Number(coverageRow.allocated_feet) === 26
        && Number(coverageRow.covered_feet) === 52
        && Number(coverageRow.remaining_covered_feet) === 33,
      `Unexpected split-coverage SQL result: ${JSON.stringify(coverageRow)}`
    );

    const brokenAllocationsResult = await client.query(`
      select count(*)::integer as broken_count
      from app.allocations
      where status in ('ACTIVE', 'FULFILLED')
        and allocated_feet > 0
        and coalesce(covered_feet, 0) = 0
    `);
    const brokenCount = Number(brokenAllocationsResult.rows[0]?.broken_count || 0);
    assert(
      brokenCount === 0,
      `Found ${brokenCount} active or fulfilled allocations with allocated_feet > 0 and covered_feet = 0.`,
    );

    const candidateJobsResult = await client.query(
      `
        select distinct upper(trim(job_number)) as job_number
        from app.allocations
        where org_id = $1
          and status in ('ACTIVE', 'FULFILLED')
          and allocated_feet > 0
          and coalesce(covered_feet, 0) > 0
        order by upper(trim(job_number)) asc
        limit 20
      `,
      [orgId]
    );
    const candidateJobNumbers = candidateJobsResult.rows
      .map((row) => asTrimmedString(row.job_number))
      .filter(Boolean);
    assert(candidateJobNumbers.length > 0, "No live allocation jobs with covered_feet > 0 were found.");

    let selectedJobNumber = "";
    let selectedDetail = null;

    for (const candidateJobNumber of candidateJobNumbers) {
      const detail = await buildJobDetail(client, orgId, candidateJobNumber);
      const allocatedFeet = Number(detail?.summary?.allocatedFeet || 0);
      const requirementAllocatedFeet = sumRequirementField(detail?.requirements, "allocatedFeet");
      if (allocatedFeet > 0 && requirementAllocatedFeet > 0) {
        selectedJobNumber = candidateJobNumber;
        selectedDetail = detail;
        break;
      }
    }

    assert(selectedDetail, "Unable to find a live job detail with allocated covered footage to verify.");

    const summaryAllocatedFeet = Number(selectedDetail?.summary?.allocatedFeet || 0);
    const summaryRemainingFeet = Number(selectedDetail?.summary?.remainingFeet || 0);
    const requirementRequiredFeet = sumRequirementField(selectedDetail?.requirements, "requiredFeet");
    const requirementAllocatedFeet = sumRequirementField(selectedDetail?.requirements, "allocatedFeet");
    const requirementRemainingFeet = sumRequirementField(selectedDetail?.requirements, "remainingFeet");

    assert(
      requirementAllocatedFeet > 0,
      `Selected job ${selectedJobNumber} does not expose any allocated requirement footage: ${JSON.stringify(selectedDetail?.summary || {})}`
    );
    assert(
      summaryAllocatedFeet === requirementAllocatedFeet,
      `Job ${selectedJobNumber} summary allocatedFeet does not match requirements: ${JSON.stringify({ summaryAllocatedFeet, requirementAllocatedFeet })}`
    );
    assert(
      summaryRemainingFeet === requirementRemainingFeet,
      `Job ${selectedJobNumber} summary remainingFeet does not match requirements: ${JSON.stringify({ summaryRemainingFeet, requirementRemainingFeet })}`
    );
    assert(
      requirementRequiredFeet === requirementAllocatedFeet + requirementRemainingFeet,
      `Job ${selectedJobNumber} requirements do not balance required = allocated + remaining: ${JSON.stringify({ requirementRequiredFeet, requirementAllocatedFeet, requirementRemainingFeet })}`
    );

    console.log(`Allocation covered-feet parity OK for live job ${selectedJobNumber}.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(
    "Allocation covered-feet parity verification failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
