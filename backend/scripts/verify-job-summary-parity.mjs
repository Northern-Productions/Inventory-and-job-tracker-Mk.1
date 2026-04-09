import "../load-env.mjs";
import { Client } from "pg";
import { buildJobDetail, buildJobsList } from "../src/app/internal.mjs";

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

function buildComparableSummary(summary) {
  return {
    status: asTrimmedString(summary?.status),
    lifecycleStatus: asTrimmedString(summary?.lifecycleStatus),
    hasOrderedAllocations: Boolean(summary?.hasOrderedAllocations),
    requiredFeet: Number(summary?.requiredFeet || 0),
    allocatedFeet: Number(summary?.allocatedFeet || 0),
    remainingFeet: Number(summary?.remainingFeet || 0),
    requiredTubes: Number(summary?.requiredTubes || 0),
    allocatedTubes: Number(summary?.allocatedTubes || 0),
    remainingTubes: Number(summary?.remainingTubes || 0),
    requirementCount: Number(summary?.requirementCount || 0),
    allocationCount: Number(summary?.allocationCount || 0),
    filmOrderCount: Number(summary?.filmOrderCount || 0),
  };
}

function summariesMatch(left, right) {
  const leftComparable = buildComparableSummary(left);
  const rightComparable = buildComparableSummary(right);
  return JSON.stringify(leftComparable) === JSON.stringify(rightComparable);
}

async function main() {
  const client = new Client({
    connectionString: requireDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
  });
  const orgId = requireOrgId();
  const lifecycleFilters = ["ACTIVE", "COMPLETED"];

  await client.connect();

  try {
    const mismatches = [];

    for (const lifecycleStatus of lifecycleFilters) {
      const entries = await buildJobsList(client, orgId, 0, lifecycleStatus);
      for (const entry of entries) {
        const detail = await buildJobDetail(client, orgId, entry.jobNumber);
        if (!summariesMatch(entry, detail.summary)) {
          mismatches.push({
            jobNumber: entry.jobNumber,
            lifecycleStatus,
            list: buildComparableSummary(entry),
            detail: buildComparableSummary(detail.summary),
          });
        }
      }
    }

    if (mismatches.length > 0) {
      throw new Error(
        `Found ${mismatches.length} job summary parity mismatch(es):\n${JSON.stringify(mismatches, null, 2)}`,
      );
    }

    console.log("Job summary parity OK across list and detail views.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(
    "Job summary parity verification failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
