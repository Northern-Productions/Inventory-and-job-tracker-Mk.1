import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

const DEV_PROJECT_REF = "uxiltcpbhthhinonttrc";
const PROD_PROJECT_REF = "tiwpulgvxtwlmqdnyuzd";
const DEFAULT_REPORT_DIR = path.join("backend", "migration-dry-runs", "legacy-reconciliation");
const APPLY_CONFIRMATION = "APPLY_DEV_LEGACY_RECONCILIATION";

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function asUpperTrimmedString(value) {
  return asTrimmedString(value).toUpperCase();
}

function integerOrZero(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(Math.trunc(parsed), 0);
}

function nullableString(value) {
  const trimmed = asTrimmedString(value);
  return trimmed || null;
}

function normalizeProjectRef(value) {
  return asTrimmedString(value).toLowerCase();
}

function normalizeStatus(value) {
  return asUpperTrimmedString(value);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const [rawKey, rawValue] = token.slice(2).split("=", 2);
    if (rawValue !== undefined) {
      options[rawKey] = rawValue;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[rawKey] = true;
      continue;
    }

    options[rawKey] = next;
    index += 1;
  }

  return options;
}

function normalizeEnvValue(rawValue) {
  const trimmed = asTrimmedString(rawValue);
  if (!trimmed) {
    return "";
  }

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function readEnvFile(envPath) {
  const resolvedPath = path.resolve(envPath);
  const contents = fs.readFileSync(resolvedPath, "utf8").replace(/^\uFEFF/, "");
  const values = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    values[key] = normalizeEnvValue(normalized.slice(separatorIndex + 1));
  }

  return { path: resolvedPath, values };
}

function extractSupabaseProjectRef(supabaseUrl) {
  const text = asTrimmedString(supabaseUrl);
  if (!text) {
    return "";
  }

  try {
    const parsed = new URL(text);
    const match = parsed.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i);
    return normalizeProjectRef(match?.[1] || "");
  } catch {
    return "";
  }
}

function extractDbProjectRef(connectionString) {
  const text = asTrimmedString(connectionString);
  if (!text) {
    return "";
  }

  try {
    const parsed = new URL(text);
    const match = parsed.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i);
    return normalizeProjectRef(match?.[1] || "");
  } catch {
    return "";
  }
}

function wantsApplyMode(options) {
  return Boolean(options.apply) || asTrimmedString(options.mode).toLowerCase() === "apply";
}

function resolveDryRunConfig(options, scriptName) {
  if (wantsApplyMode(options)) {
    throw new Error("Apply mode is intentionally not implemented for this dry-run script.");
  }

  return resolveLegacyReconciliationConfig(options, scriptName, { allowApply: false });
}

function resolveLegacyReconciliationConfig(options, scriptName, { allowApply = false } = {}) {
  const applyMode = wantsApplyMode(options);
  if (applyMode && !allowApply) {
    throw new Error("Apply mode is intentionally not implemented for this dry-run script.");
  }

  if (applyMode && asTrimmedString(options["confirm-apply"]) !== APPLY_CONFIRMATION) {
    throw new Error(`Apply mode requires --confirm-apply ${APPLY_CONFIRMATION}.`);
  }

  const reviewedReportPath = asTrimmedString(options["reviewed-report"]);
  if (applyMode && !reviewedReportPath) {
    throw new Error("Apply mode requires --reviewed-report pointing to the reviewed dry-run JSON artifact.");
  }

  if (applyMode && asTrimmedString(options.out)) {
    throw new Error("Apply mode writes no dry-run report; use --reviewed-report instead of --out.");
  }

  if (!applyMode && reviewedReportPath) {
    throw new Error("--reviewed-report is only valid with --apply.");
  }

  const mode = applyMode ? "apply" : "dry-run";

  const envPath = asTrimmedString(options.env || path.join("backend", ".env.dev"));
  if (!envPath) {
    throw new Error("--env is required.");
  }

  if (/\.prod(?:\.|$)/i.test(path.basename(envPath)) || /prod/i.test(path.basename(envPath))) {
    throw new Error(`Refusing to load PROD-looking env file for ${scriptName}: ${envPath}`);
  }

  const expectedProjectRef = normalizeProjectRef(options["expected-project-ref"] || DEV_PROJECT_REF);
  if (!expectedProjectRef) {
    throw new Error("--expected-project-ref is required.");
  }

  if (expectedProjectRef === PROD_PROJECT_REF) {
    throw new Error("Refusing to use the PROD project ref as --expected-project-ref.");
  }

  const env = readEnvFile(envPath);
  const supabaseProjectRef = extractSupabaseProjectRef(env.values.SUPABASE_URL);
  if (!supabaseProjectRef) {
    throw new Error(`SUPABASE_URL with a Supabase project ref is required in ${env.path}.`);
  }

  if (supabaseProjectRef === PROD_PROJECT_REF) {
    throw new Error(`Refusing to run against PROD Supabase project ref ${PROD_PROJECT_REF}.`);
  }

  if (supabaseProjectRef !== expectedProjectRef) {
    throw new Error(
      `Supabase project ref mismatch. Expected ${expectedProjectRef}, found ${supabaseProjectRef}.`
    );
  }

  const databaseUrlVar = asTrimmedString(options["database-url-var"] || "DEV_DATABASE_URL");
  if (!databaseUrlVar || /prod/i.test(databaseUrlVar)) {
    throw new Error("Refusing to use a PROD-looking database URL variable.");
  }

  const databaseUrl = asTrimmedString(env.values[databaseUrlVar] || env.values.DATABASE_URL || "");
  if (!databaseUrl) {
    throw new Error(`${databaseUrlVar} or DATABASE_URL is required in ${env.path}.`);
  }

  const databaseProjectRef = extractDbProjectRef(databaseUrl);
  if (databaseProjectRef === PROD_PROJECT_REF) {
    throw new Error(`Refusing to connect to PROD database project ref ${PROD_PROJECT_REF}.`);
  }

  if (databaseProjectRef && databaseProjectRef !== expectedProjectRef) {
    throw new Error(
      `Database project ref mismatch. Expected ${expectedProjectRef}, found ${databaseProjectRef}.`
    );
  }

  const orgId = asTrimmedString(options["org-id"]);
  if (!orgId) {
    throw new Error("--org-id is required; this script will not guess the organization.");
  }

  const out = asTrimmedString(options.out);
  const reportPath = out
    ? path.resolve(out)
    : path.resolve(
        DEFAULT_REPORT_DIR,
        `${scriptName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
      );

  return {
    mode,
    scriptName,
    envPath: env.path,
    databaseUrl,
    databaseUrlVar,
    orgId,
    reportPath,
    reviewedReportPath: reviewedReportPath ? path.resolve(reviewedReportPath) : null,
    actor: asTrimmedString(options.actor) || "legacy-reconciliation-dev-apply",
    expectedProjectRef,
    supabaseProjectRef,
    databaseProjectRef: databaseProjectRef || null
  };
}

function buildClient(connectionString, applicationName) {
  return new Client({
    application_name: applicationName,
    connectionString,
    ssl: /localhost|127\.0\.0\.1/i.test(connectionString) ? undefined : { rejectUnauthorized: false }
  });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function metadataForConfig(config, extra = {}) {
  return {
    generatedAt: new Date().toISOString(),
    mode: config.mode,
    script: config.scriptName,
    envPath: config.envPath,
    orgId: config.orgId,
    projectRef: config.supabaseProjectRef,
    databaseProjectRef: config.databaseProjectRef,
    dryRunOnly: config.mode !== "apply",
    mutationsAllowed: config.mode === "apply",
    ...extra
  };
}

async function withReadOnlyTransaction(client, callback) {
  await client.query("begin read only");
  try {
    await client.query("set local lock_timeout = '3s'");
    await client.query("set local statement_timeout = '90s'");
    const result = await callback();
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Keep the original failure visible.
    }
    throw error;
  }
}

async function withWriteTransaction(client, callback) {
  await client.query("begin");
  try {
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '120s'");
    const result = await callback();
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Keep the original failure visible.
    }
    throw error;
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

async function fetchSchemaPreflight(client) {
  const result = await client.query(`
    select jsonb_build_object(
      'filmOrdersRequirementId', exists (
        select 1
        from information_schema.columns
        where table_schema = 'app'
          and table_name = 'film_orders'
          and column_name = 'requirement_id'
      ),
      'allocationsRequirementId', exists (
        select 1
        from information_schema.columns
        where table_schema = 'app'
          and table_name = 'allocations'
          and column_name = 'requirement_id'
      ),
      'allocationsCoveredFeet', exists (
        select 1
        from information_schema.columns
        where table_schema = 'app'
          and table_name = 'allocations'
          and column_name = 'covered_feet'
      ),
      'filmOrderMatchesRequirement', to_regprocedure(
        'app_api.film_order_matches_requirement(uuid, uuid, text, text, numeric, uuid, text, text, numeric)'
      ) is not null,
      'boxPhysicalFeetAvailable', to_regprocedure(
        'app_api.box_physical_feet_available(app.boxes)'
      ) is not null,
      'filmAllocationReservesCapacity', to_regprocedure(
        'app_api.film_allocation_reserves_capacity(app.allocations, text)'
      ) is not null,
      'filmAllocationConsumesStoredCapacity', to_regprocedure(
        'app_api.film_allocation_consumes_stored_capacity(app.allocations, text)'
      ) is not null,
      'computeCoveredFeetFromAllocation', to_regprocedure(
        'app_api.compute_covered_feet_from_allocation(integer, numeric, numeric, integer)'
      ) is not null,
      'requirementFilmIsCompatible', to_regprocedure(
        'app_api.requirement_film_is_compatible(uuid, text, text, text, text)'
      ) is not null
    ) as checks
  `);

  return result.rows[0]?.checks || {};
}

function requireSchemaChecks(checks, requiredKeys) {
  const missing = requiredKeys.filter((key) => checks[key] !== true);
  if (missing.length > 0) {
    throw new Error(`DEV schema is missing required objects: ${missing.join(", ")}`);
  }
}

function parseJsonArray(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

function normalizeFilmOrderBackfillRow(row) {
  const matches = parseJsonArray(row.matching_requirements || row.matchingRequirements).map((entry) => ({
    requirementId: asTrimmedString(entry.requirementId),
    jobId: asTrimmedString(entry.jobId),
    jobNumber: asTrimmedString(entry.jobNumber),
    manufacturer: asTrimmedString(entry.manufacturer),
    filmName: asTrimmedString(entry.filmName),
    widthIn: Number(entry.widthIn ?? 0),
    requiredFeet: integerOrZero(entry.requiredFeet)
  }));

  const matchStatus =
    matches.length === 1 ? "MATCHED" : matches.length > 1 ? "AMBIGUOUS" : "UNMATCHED";

  return {
    filmOrderId: asTrimmedString(row.film_order_id || row.filmOrderId),
    rowId: asTrimmedString(row.id || row.rowId),
    status: normalizeStatus(row.status),
    jobId: nullableString(row.job_id || row.jobId),
    jobNumber: asTrimmedString(row.job_number || row.jobNumber),
    film: {
      manufacturer: asTrimmedString(row.manufacturer),
      filmName: asTrimmedString(row.film_name || row.filmName),
      widthIn: Number(row.width_in ?? row.widthIn ?? 0)
    },
    requestedFeet: integerOrZero(row.requested_feet ?? row.requestedFeet),
    orderedFeet: integerOrZero(row.ordered_feet ?? row.orderedFeet),
    coveredFeet: integerOrZero(row.covered_feet ?? row.coveredFeet),
    remainingToOrderFeet: integerOrZero(row.remaining_to_order_feet ?? row.remainingToOrderFeet),
    createdAt: row.created_at || row.createdAt || null,
    updatedAt: row.updated_at || row.updatedAt || null,
    matchStatus,
    wouldSetRequirementId: matches.length === 1 ? matches[0].requirementId : null,
    matchingRequirements: matches
  };
}

function buildFilmOrderRequirementBackfillReport(rows) {
  const candidates = rows.map(normalizeFilmOrderBackfillRow);
  return {
    summary: {
      scannedFilmOrders: candidates.length,
      wouldBackfill: candidates.filter((entry) => entry.matchStatus === "MATCHED").length,
      ambiguous: candidates.filter((entry) => entry.matchStatus === "AMBIGUOUS").length,
      unmatched: candidates.filter((entry) => entry.matchStatus === "UNMATCHED").length
    },
    candidates
  };
}

function coverageMultiplier(sourceWidthIn, requirementWidthIn) {
  return Number(sourceWidthIn) === 72 && Number(requirementWidthIn) === 36 ? 2 : 1;
}

function computeCoveredFeetFromAllocation(allocatedFeet, sourceWidthIn, requirementWidthIn, requestedCoveredFeet) {
  const allocated = integerOrZero(allocatedFeet);
  if (allocated <= 0) {
    return 0;
  }

  const covered = allocated * coverageMultiplier(sourceWidthIn, requirementWidthIn);
  if (requestedCoveredFeet === null || requestedCoveredFeet === undefined) {
    return covered;
  }

  return Math.min(integerOrZero(requestedCoveredFeet), covered);
}

function normalizeAllocationRow(row) {
  return {
    allocationId: asTrimmedString(row.allocation_id || row.allocationId),
    boxId: asUpperTrimmedString(row.box_id || row.boxId),
    jobId: nullableString(row.job_id || row.jobId),
    jobNumber: asTrimmedString(row.job_number || row.jobNumber),
    requirementId: nullableString(row.requirement_id || row.requirementId),
    filmOrderId: asTrimmedString(row.film_order_id || row.filmOrderId),
    status: normalizeStatus(row.status),
    allocationKind: normalizeStatus(row.allocation_kind || row.allocationKind || "REQUIREMENT"),
    allocationSource: normalizeStatus(row.allocation_source || row.allocationSource || "MANUAL"),
    jobDate: row.job_date || row.jobDate || null,
    consumesStoredCapacity: Boolean(row.consumes_stored_capacity ?? row.consumesStoredCapacity),
    allocatedFeet: integerOrZero(row.allocated_feet ?? row.allocatedFeet),
    coveredFeet: integerOrZero(row.covered_feet ?? row.coveredFeet),
    sourceWidthIn: Number(row.source_width_in ?? row.sourceWidthIn ?? row.box_width_in ?? row.width_in ?? 0),
    requirementWidthIn: Number(row.requirement_width_in ?? row.requirementWidthIn ?? row.width_in ?? 0),
    createdAt: row.created_at || row.createdAt || null,
    updatedAt: row.updated_at || row.updatedAt || null
  };
}

function compareAllocationsByReservationOrder(left, right) {
  const leftCreated = asTrimmedString(left.createdAt);
  const rightCreated = asTrimmedString(right.createdAt);
  if (leftCreated !== rightCreated) {
    return leftCreated < rightCreated ? -1 : 1;
  }
  return left.allocationId.localeCompare(right.allocationId, "en-US", {
    numeric: true,
    sensitivity: "base"
  });
}

function planBoxAllocationDecisions(box, allocationRows) {
  const allocations = allocationRows.map(normalizeAllocationRow).sort(compareAllocationsByReservationOrder);
  let remainingFeet = integerOrZero(box.physicalLf ?? box.physical_lf);
  const decisions = [];

  for (const allocation of allocations) {
    const beforeAllocatedFeet = allocation.allocatedFeet;
    const beforeCoveredFeet = allocation.coveredFeet;
    const requestedCoveredFeet = beforeCoveredFeet > 0 ? beforeCoveredFeet : beforeAllocatedFeet;
    let afterAllocatedFeet = beforeAllocatedFeet;
    let decision = "preserve";

    if (remainingFeet >= beforeAllocatedFeet) {
      remainingFeet -= beforeAllocatedFeet;
    } else if (remainingFeet > 0) {
      afterAllocatedFeet = remainingFeet;
      remainingFeet = 0;
      decision = "reduce";
    } else {
      afterAllocatedFeet = 0;
      decision = "cancel";
    }

    decisions.push({
      ...allocation,
      decision,
      beforeAllocatedFeet,
      afterAllocatedFeet,
      beforeCoveredFeet,
      afterCoveredFeet: computeCoveredFeetFromAllocation(
        afterAllocatedFeet,
        allocation.sourceWidthIn,
        allocation.requirementWidthIn || allocation.sourceWidthIn,
        requestedCoveredFeet
      )
    });
  }

  return decisions;
}

function groupBy(array, keyFn) {
  const grouped = new Map();
  for (const entry of array) {
    const key = keyFn(entry);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(entry);
  }
  return grouped;
}

function normalizeRequirementRow(row) {
  return {
    requirementId: asTrimmedString(row.requirement_id || row.requirementId || row.id),
    jobId: asTrimmedString(row.job_id || row.jobId),
    jobNumber: asTrimmedString(row.job_number || row.jobNumber),
    lifecycleStatus: normalizeStatus(row.lifecycle_status || row.lifecycleStatus || "ACTIVE"),
    manufacturer: asTrimmedString(row.manufacturer),
    filmName: asTrimmedString(row.film_name || row.filmName),
    widthIn: Number(row.width_in ?? row.widthIn ?? 0),
    requiredFeet: integerOrZero(row.required_feet ?? row.requiredFeet)
  };
}

function normalizeMatchedFilmOrderRow(row) {
  return {
    matchedRequirementId: asTrimmedString(row.matched_requirement_id || row.matchedRequirementId),
    filmOrderId: asTrimmedString(row.film_order_id || row.filmOrderId),
    status: normalizeStatus(row.status),
    requestedFeet: integerOrZero(row.requested_feet ?? row.requestedFeet),
    orderedFeet: integerOrZero(row.ordered_feet ?? row.orderedFeet),
    coveredFeet: integerOrZero(row.covered_feet ?? row.coveredFeet),
    remainingToOrderFeet: integerOrZero(row.remaining_to_order_feet ?? row.remainingToOrderFeet),
    createdAt: row.created_at || row.createdAt || null
  };
}

function onTheWayCoverageFeet(order) {
  return order.orderedFeet > 0 ? order.orderedFeet : order.requestedFeet;
}

function buildAffectedJobReports({
  requirementRows,
  allocationRows,
  matchedFilmOrderRows,
  simulatedAllocationDecisions
}) {
  const requirements = requirementRows.map(normalizeRequirementRow);
  const activeAllocations = allocationRows.map(normalizeAllocationRow);
  const simulatedById = new Map(simulatedAllocationDecisions.map((entry) => [entry.allocationId, entry]));
  const filmOrdersByRequirement = groupBy(
    matchedFilmOrderRows.map(normalizeMatchedFilmOrderRow),
    (entry) => entry.matchedRequirementId
  );

  const allocatedCoveredByRequirement = new Map();
  for (const allocation of activeAllocations) {
    const override = simulatedById.get(allocation.allocationId);
    const afterAllocatedFeet = override ? override.afterAllocatedFeet : allocation.allocatedFeet;
    if (afterAllocatedFeet <= 0) {
      continue;
    }

    const afterCoveredFeet = override
      ? override.afterCoveredFeet
      : allocation.coveredFeet > 0
        ? allocation.coveredFeet
        : allocation.allocatedFeet;

    const requirementId = asTrimmedString(allocation.requirementId);
    allocatedCoveredByRequirement.set(
      requirementId,
      (allocatedCoveredByRequirement.get(requirementId) || 0) + integerOrZero(afterCoveredFeet)
    );
  }

  const requirementsByJob = groupBy(requirements, (entry) => entry.jobNumber);
  const affectedJobs = [];

  for (const [jobNumber, jobRequirements] of requirementsByJob.entries()) {
    const requirementReports = jobRequirements.map((requirement) => {
      const allocatedAfter = Math.min(
        allocatedCoveredByRequirement.get(requirement.requirementId) || 0,
        requirement.requiredFeet
      );
      const missingAfter = Math.max(requirement.requiredFeet - allocatedAfter, 0);
      const matchingOrders = (filmOrdersByRequirement.get(requirement.requirementId) || []).sort(
        (left, right) => {
          const leftCreated = asTrimmedString(left.createdAt);
          const rightCreated = asTrimmedString(right.createdAt);
          if (leftCreated !== rightCreated) {
            return leftCreated < rightCreated ? -1 : 1;
          }
          return left.filmOrderId.localeCompare(right.filmOrderId, "en-US", {
            numeric: true,
            sensitivity: "base"
          });
        }
      );
      const onTheWayFeet = matchingOrders
        .filter((order) => order.status === "FILM_ON_THE_WAY")
        .reduce((total, order) => total + onTheWayCoverageFeet(order), 0);
      const neededOrderFeet = Math.max(missingAfter - onTheWayFeet, 0);
      const editableFilmOrder = matchingOrders.find((order) => order.status === "FILM_ORDER") || null;

      return {
        requirementId: requirement.requirementId,
        film: {
          manufacturer: requirement.manufacturer,
          filmName: requirement.filmName,
          widthIn: requirement.widthIn
        },
        requiredFeet: requirement.requiredFeet,
        allocatedAfter,
        missingAfter,
        filmOnTheWayCoverage: onTheWayFeet,
        neededOrderFeet,
        existingFilmOrderUpdate: editableFilmOrder
          ? {
              filmOrderId: editableFilmOrder.filmOrderId,
              wouldUpdateRequestedFeetTo: neededOrderFeet,
              wouldUpdateRemainingToOrderFeetTo: neededOrderFeet,
              wouldUpdateStatusTo: neededOrderFeet === 0 ? "FULFILLED" : "FILM_ORDER"
            }
          : null,
        needsUserApprovedFilmOrder: !editableFilmOrder && neededOrderFeet > 0
      };
    });

    const lifecycleStatus = jobRequirements[0]?.lifecycleStatus || "ACTIVE";
    const allCovered = requirementReports.every((entry) => entry.missingAfter === 0);
    const allMissingCoveredByOnTheWay = requirementReports.every(
      (entry) => entry.missingAfter === 0 || entry.filmOnTheWayCoverage >= entry.missingAfter
    );
    const resultingJobStatus =
      lifecycleStatus === "COMPLETED" || lifecycleStatus === "CANCELLED"
        ? lifecycleStatus
        : allCovered
          ? "READY"
          : allMissingCoveredByOnTheWay
            ? "ORDERED"
            : "FILM_ORDER";

    affectedJobs.push({
      jobNumber,
      jobId: jobRequirements[0]?.jobId || "",
      lifecycleStatus,
      resultingJobStatus,
      requirementStatuses: requirementReports,
      needsUserApprovedFilmOrder: requirementReports.some((entry) => entry.needsUserApprovedFilmOrder),
      existingFilmOrderUpdates: requirementReports
        .map((entry) => entry.existingFilmOrderUpdate)
        .filter(Boolean)
    });
  }

  affectedJobs.sort((left, right) =>
    left.jobNumber.localeCompare(right.jobNumber, "en-US", { numeric: true, sensitivity: "base" })
  );
  return affectedJobs;
}

function buildBoxReconciliationReports({ boxRows, allocationRows, requirementRows, jobAllocationRows, matchedFilmOrderRows }) {
  const allocationsByBox = groupBy(allocationRows, (row) => asUpperTrimmedString(row.box_id || row.boxId));
  const allDecisions = [];
  const boxes = [];

  for (const row of boxRows) {
    const boxId = asUpperTrimmedString(row.box_id || row.boxId);
    const physicalLf = integerOrZero(row.physical_lf ?? row.physicalLf);
    const totalActiveReservedLf = integerOrZero(row.total_active_reserved_lf ?? row.totalActiveReservedLf);
    const totalActiveStoredLf = integerOrZero(row.total_active_stored_lf ?? row.totalActiveStoredLf);
    const decisions = planBoxAllocationDecisions(
      { physicalLf },
      allocationsByBox.get(boxId) || []
    );

    allDecisions.push(...decisions.filter((entry) => entry.decision !== "preserve"));

    const affectedJobNumbers = Array.from(
      new Set(decisions.filter((entry) => entry.decision !== "preserve").map((entry) => entry.jobNumber).filter(Boolean))
    ).sort((left, right) => left.localeCompare(right, "en-US", { numeric: true, sensitivity: "base" }));

    boxes.push({
      boxId,
      film: {
        manufacturer: asTrimmedString(row.manufacturer),
        filmName: asTrimmedString(row.film_name || row.filmName),
        widthIn: Number(row.width_in ?? row.widthIn ?? 0)
      },
      status: normalizeStatus(row.status),
      physicalLf,
      storedFeetAvailable: integerOrZero(row.feet_available ?? row.feetAvailable),
      totalActiveReservedLf,
      totalActiveStoredLf,
      overAllocatedLf: Math.max(totalActiveReservedLf - physicalLf, 0),
      resultingStoredFeetAvailable: Math.max(
        physicalLf -
          decisions
            .filter((entry) => entry.decision !== "cancel" && entry.consumesStoredCapacity)
            .reduce((total, entry) => total + entry.afterAllocatedFeet, 0),
        0
      ),
      activeAllocations: decisions.map((entry) => ({
        allocationId: entry.allocationId,
        createdAt: entry.createdAt,
        jobNumber: entry.jobNumber,
        requirementId: entry.requirementId,
        allocationSource: entry.allocationSource,
        consumesStoredCapacity: entry.consumesStoredCapacity,
        beforeAllocatedFeet: entry.beforeAllocatedFeet,
        afterAllocatedFeet: entry.afterAllocatedFeet,
        beforeCoveredFeet: entry.beforeCoveredFeet,
        afterCoveredFeet: entry.afterCoveredFeet,
        decision: entry.decision
      })),
      preservedAllocationIds: decisions
        .filter((entry) => entry.decision === "preserve")
        .map((entry) => entry.allocationId),
      reducedAllocationIds: decisions
        .filter((entry) => entry.decision === "reduce")
        .map((entry) => entry.allocationId),
      cancelledAllocationIds: decisions
        .filter((entry) => entry.decision === "cancel")
        .map((entry) => entry.allocationId),
      affectedJobNumbers
    });
  }

  const affectedJobs = buildAffectedJobReports({
    requirementRows,
    allocationRows: jobAllocationRows,
    matchedFilmOrderRows,
    simulatedAllocationDecisions: allDecisions
  });

  const jobsByNumber = new Map(affectedJobs.map((entry) => [entry.jobNumber, entry]));
  for (const box of boxes) {
    box.affectedJobs = box.affectedJobNumbers
      .map((jobNumber) => jobsByNumber.get(jobNumber))
      .filter(Boolean);
  }

  return {
    summary: {
      affectedBoxes: boxes.length,
      overAllocatedLf: boxes.reduce((total, box) => total + box.overAllocatedLf, 0),
      allocationsWouldBeReduced: boxes.reduce((total, box) => total + box.reducedAllocationIds.length, 0),
      allocationsWouldBeCancelled: boxes.reduce((total, box) => total + box.cancelledAllocationIds.length, 0),
      affectedJobs: affectedJobs.length,
      jobsNeedingUserApprovedFilmOrder: affectedJobs.filter((entry) => entry.needsUserApprovedFilmOrder).length,
      existingFilmOrdersWouldUpdate: affectedJobs.reduce(
        (total, entry) => total + entry.existingFilmOrderUpdates.length,
        0
      )
    },
    boxes
  };
}

export {
  APPLY_CONFIRMATION,
  DEV_PROJECT_REF,
  PROD_PROJECT_REF,
  asTrimmedString,
  buildAffectedJobReports,
  buildBoxReconciliationReports,
  buildClient,
  buildFilmOrderRequirementBackfillReport,
  computeCoveredFeetFromAllocation,
  extractDbProjectRef,
  extractSupabaseProjectRef,
  fetchSchemaPreflight,
  integerOrZero,
  metadataForConfig,
  parseArgs,
  planBoxAllocationDecisions,
  readJson,
  requireSchemaChecks,
  resolveDryRunConfig,
  resolveLegacyReconciliationConfig,
  withReadOnlyTransaction,
  withWriteTransaction,
  writeJson
};
