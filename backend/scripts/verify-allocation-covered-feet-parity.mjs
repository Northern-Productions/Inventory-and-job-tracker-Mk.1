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

    const detail = await buildJobDetail(client, orgId, "17872");
    const requirement = findRequirement(detail, "Security", "3M Ultra S800", 36);
    assert(requirement, "Job 17872 is missing the 36-inch Security 3M Ultra S800 requirement.");
    assert(
      Number(requirement.requiredFeet) === 85
        && Number(requirement.allocatedFeet) === 85
        && Number(requirement.remainingFeet) === 0,
      `Unexpected job 17872 requirement coverage: ${JSON.stringify(requirement)}`
    );

    assert(
      Number(detail?.summary?.allocatedFeet || 0) === 105
        && Number(detail?.summary?.remainingFeet || 0) === 0,
      `Unexpected job 17872 summary coverage: ${JSON.stringify(detail?.summary || {})}`
    );

    console.log("Allocation covered-feet parity OK.");
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
