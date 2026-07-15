import "../load-env.mjs";
import { Client } from "pg";
import {
  buildJobDetail,
  buildJobDetailById,
  buildJobsList,
} from "../src/app/internal.mjs";
import {
  JobSummaryParityDiagnosticError,
  assertJobSummaryParity,
  compareJobSummaryEntries,
  observeLegacyRouteDivergences,
} from "./lib/job-summary-parity.mjs";

function asTrimmedString(value) {
  return String(value || "").trim();
}

function requireDatabaseUrl() {
  const databaseUrl = asTrimmedString(process.env.DATABASE_URL);
  if (!databaseUrl) {
    throw new JobSummaryParityDiagnosticError("DATABASE_URL is required.");
  }
  return databaseUrl;
}

function requireOrgId() {
  const orgId = asTrimmedString(process.env.VERIFY_DB_PARITY_ORG_ID || process.env.DEFAULT_ORG_ID);
  if (!orgId) {
    throw new JobSummaryParityDiagnosticError(
      "VERIFY_DB_PARITY_ORG_ID or DEFAULT_ORG_ID is required.",
    );
  }
  return orgId;
}

function shouldObserveLegacyRoute() {
  return process.argv.slice(2).includes("--report-legacy-divergence");
}

function formatDifferingFields(fieldCounts) {
  return Object.keys(fieldCounts || {}).sort().join(", ") || "none";
}

async function main() {
  const client = new Client({
    application_name: "job-summary-parity-read-only",
    connectionString: requireDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
  });
  const orgId = requireOrgId();
  const lifecycleFilters = ["ACTIVE", "COMPLETED"];
  const entries = [];
  let parityResult;
  let legacyRouteObservation = null;

  await client.connect();

  try {
    await client.query("begin transaction isolation level repeatable read read only");
    try {
      for (const lifecycleStatus of lifecycleFilters) {
        entries.push(...(await buildJobsList(client, orgId, 0, lifecycleStatus)));
      }

      parityResult = await compareJobSummaryEntries({
        client,
        orgId,
        entries,
        buildJobDetail,
        buildJobDetailById,
      });
      assertJobSummaryParity(parityResult);

      if (shouldObserveLegacyRoute()) {
        legacyRouteObservation = await observeLegacyRouteDivergences({
          client,
          orgId,
          entries,
          buildJobDetail,
        });
      }
    } finally {
      await client.query("rollback");
    }
  } finally {
    await client.end();
  }

  console.log("[job-summary-parity]");
  console.log("transactionReadOnly: verified");
  console.log(`compared: ${parityResult.comparedCount}`);
  console.log(`canonicalUuidCompared: ${parityResult.canonicalComparedCount}`);
  console.log(`legacyJobNumberCompared: ${parityResult.legacyComparedCount}`);
  console.log(`canonicalUuidMismatches: ${parityResult.canonicalMismatchCount}`);
  console.log(`legacyJobNumberMismatches: ${parityResult.legacyMismatchCount}`);
  if (legacyRouteObservation) {
    console.log(`legacyRouteObserved: ${legacyRouteObservation.observedCount}`);
    console.log(`legacyRouteDivergences: ${legacyRouteObservation.divergenceCount}`);
    console.log(
      `legacyRouteDivergenceFields: ${formatDifferingFields(legacyRouteObservation.differingFields)}`,
    );
    console.log("legacyRouteDivergencesAreCanonicalFailures: false");
  } else {
    console.log("legacyRouteObservation: not requested");
  }
  console.log("result: ok");
}

main().catch((error) => {
  const message = error instanceof JobSummaryParityDiagnosticError
    ? error.message
    : "Unexpected read-only verification error.";
  console.error(
    "Job summary parity verification failed:",
    message,
  );
  process.exitCode = 1;
});
