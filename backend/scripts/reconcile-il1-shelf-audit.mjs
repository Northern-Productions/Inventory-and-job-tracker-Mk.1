import "../load-env.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  applyZeroCandidates,
  buildShelfAuditDiff,
  parseShelfAuditText,
  validateApplyCandidates
} from "./lib/il1-shelf-audit.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const DEFAULT_WAREHOUSE = "IL1";
const DEFAULT_AUDIT_DATE = "2026-04-02";
const DEFAULT_ACTOR = `il1-shelf-audit-${DEFAULT_AUDIT_DATE}`;
const DEFAULT_REPORT_DIR = path.join(backendDir, "migration-dry-runs", `il1-shelf-audit-${DEFAULT_AUDIT_DATE}`);
const DEFAULT_INPUT_PATH = path.join(DEFAULT_REPORT_DIR, "physical-shelf-audit-input.txt");
const DEFAULT_AUDIT_NOTE = `IL1 shelf audit reconcile ${DEFAULT_AUDIT_DATE}: box not found on physical shelf list.`;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return options;
}

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function assertOk(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}

function writeCsv(filePath, rows, headers) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header] ?? "")).join(","));
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildClient(connectionString) {
  return new Client({
    connectionString,
    ssl: /localhost|127\.0\.0\.1/i.test(connectionString) ? undefined : { rejectUnauthorized: false }
  });
}

function buildArtifactPaths(reportDir, prefix) {
  return {
    summaryJson: path.join(reportDir, `${prefix}-summary.json`),
    matchedActiveCsv: path.join(reportDir, `${prefix}-matched-active.csv`),
    zeroCandidatesCsv: path.join(reportDir, `${prefix}-zero-candidates.csv`),
    checkedOutExceptionsCsv: path.join(reportDir, `${prefix}-checked-out-exceptions.csv`),
    alreadyZeroedHitsCsv: path.join(reportDir, `${prefix}-already-zeroed-hits.csv`),
    missingIdsCsv: path.join(reportDir, `${prefix}-missing-ids.csv`),
    duplicateSourceIdsCsv: path.join(reportDir, `${prefix}-duplicate-source-ids.csv`),
    unexpectedStatusHitsCsv: path.join(reportDir, `${prefix}-unexpected-status-hits.csv`),
    appliedZeroedCsv: path.join(reportDir, `${prefix}-applied-zeroed.csv`)
  };
}

function reportBoxRow(row) {
  return {
    boxId: row.boxId,
    status: row.status,
    manufacturer: row.manufacturer,
    filmName: row.filmName,
    widthIn: row.widthIn,
    initialFeet: row.initialFeet,
    feetAvailable: row.feetAvailable,
    orderDate: row.orderDate,
    receivedDate: row.receivedDate,
    lastCheckoutJob: row.lastCheckoutJob,
    lastCheckoutDate: row.lastCheckoutDate,
    zeroedDate: row.zeroedDate,
    zeroedReason: row.zeroedReason,
    zeroedBy: row.zeroedBy
  };
}

function writeArtifacts(reportDir, prefix, parsedInput, diff, extra = {}) {
  const paths = buildArtifactPaths(reportDir, prefix);
  const summary = {
    generatedAt: new Date().toISOString(),
    prefix,
    parsedInput: {
      warehouse: parsedInput.warehouse,
      sourceEntryCount: parsedInput.sourceEntryCount,
      uniqueEntryCount: parsedInput.uniqueEntryCount,
      duplicateSourceIds: parsedInput.duplicateSourceIds
    },
    summary: diff.summary,
    breakdowns: diff.breakdowns,
    extra
  };

  writeJson(paths.summaryJson, summary);
  writeCsv(
    paths.matchedActiveCsv,
    diff.activeMatches.map((row) => reportBoxRow(row)),
    [
      "boxId",
      "status",
      "manufacturer",
      "filmName",
      "widthIn",
      "initialFeet",
      "feetAvailable",
      "orderDate",
      "receivedDate",
      "lastCheckoutJob",
      "lastCheckoutDate",
      "zeroedDate",
      "zeroedReason",
      "zeroedBy"
    ]
  );
  writeCsv(
    paths.zeroCandidatesCsv,
    diff.zeroCandidates.map((row) => reportBoxRow(row)),
    [
      "boxId",
      "status",
      "manufacturer",
      "filmName",
      "widthIn",
      "initialFeet",
      "feetAvailable",
      "orderDate",
      "receivedDate",
      "lastCheckoutJob",
      "lastCheckoutDate",
      "zeroedDate",
      "zeroedReason",
      "zeroedBy"
    ]
  );
  writeCsv(
    paths.checkedOutExceptionsCsv,
    diff.checkedOutExceptions.map((row) => reportBoxRow(row)),
    [
      "boxId",
      "status",
      "manufacturer",
      "filmName",
      "widthIn",
      "initialFeet",
      "feetAvailable",
      "orderDate",
      "receivedDate",
      "lastCheckoutJob",
      "lastCheckoutDate",
      "zeroedDate",
      "zeroedReason",
      "zeroedBy"
    ]
  );
  writeCsv(
    paths.alreadyZeroedHitsCsv,
    diff.alreadyZeroedHits.map((row) => reportBoxRow(row)),
    [
      "boxId",
      "status",
      "manufacturer",
      "filmName",
      "widthIn",
      "initialFeet",
      "feetAvailable",
      "orderDate",
      "receivedDate",
      "lastCheckoutJob",
      "lastCheckoutDate",
      "zeroedDate",
      "zeroedReason",
      "zeroedBy"
    ]
  );
  writeCsv(paths.missingIdsCsv, diff.missingIds, ["boxId", "suffix"]);
  writeCsv(paths.duplicateSourceIdsCsv, parsedInput.duplicateSourceIds, ["suffix", "boxId", "occurrenceCount"]);
  writeCsv(
    paths.unexpectedStatusHitsCsv,
    diff.unexpectedStatusHits.map((row) => reportBoxRow(row)),
    [
      "boxId",
      "status",
      "manufacturer",
      "filmName",
      "widthIn",
      "initialFeet",
      "feetAvailable",
      "orderDate",
      "receivedDate",
      "lastCheckoutJob",
      "lastCheckoutDate",
      "zeroedDate",
      "zeroedReason",
      "zeroedBy"
    ]
  );

  if (Array.isArray(extra.appliedRows) && extra.appliedRows.length) {
    writeCsv(paths.appliedZeroedCsv, extra.appliedRows, [
      "boxId",
      "manufacturer",
      "filmName",
      "widthIn",
      "statusBefore",
      "logId",
      "warnings"
    ]);
  }

  return paths;
}

async function resolveActorMember(client, orgId) {
  const { rows } = await client.query(
    `
      select user_id::text as user_id, role
      from app.organization_members
      where org_id = $1::uuid
      order by
        case role when 'owner' then 0 when 'admin' then 1 else 2 end,
        created_at asc
      limit 1
    `,
    [orgId]
  );

  const userId = asTrimmedString(rows[0]?.user_id);
  const role = asTrimmedString(rows[0]?.role);
  assertOk(userId, `No org member found for org ${orgId}.`);
  assertOk(role, `No org role found for org ${orgId}.`);

  return { userId, role };
}

async function setAuthenticatedContext(client, userId) {
  await client.query(
    `
      select
        set_config('request.jwt.claim.sub', $1::text, false),
        set_config('request.jwt.claim.role', 'authenticated', false),
        set_config('request.jwt.claim.email', 'il1.shelf.audit@example.local', false),
        set_config(
          'request.jwt.claims',
          json_build_object('sub', $1::text, 'role', 'authenticated', 'email', 'il1.shelf.audit@example.local')::text,
          false
        )
    `,
    [userId]
  );
}

async function loadWarehouseRows(client, orgId, warehouse, boxIds = null, forUpdate = false) {
  const params = [orgId, warehouse];
  let whereClause = `
    where org_id = $1::uuid
      and warehouse = $2::text
  `;

  if (Array.isArray(boxIds) && boxIds.length) {
    params.push(boxIds);
    whereClause += "\n      and box_id = any($3::text[])";
  }

  const query = `
    select
      box_id,
      warehouse,
      manufacturer,
      film_name,
      width_in,
      initial_feet,
      feet_available,
      lot_run,
      status,
      order_date,
      received_date,
      initial_weight_lbs,
      last_roll_weight_lbs,
      last_weighed_date,
      film_key,
      core_type,
      core_weight_lbs,
      lf_weight_lbs_per_ft,
      price_per_lf,
      purchase_cost,
      notes,
      zeroed_date,
      zeroed_reason,
      zeroed_by,
      last_checkout_job,
      last_checkout_date
    from app.boxes
    ${whereClause}
    order by box_id
    ${forUpdate ? "for update" : ""}
  `;

  const { rows } = await client.query(query, params);
  return rows;
}

function summarizeConsoleReport(mode, orgId, warehouse, actor, parsedInput, diff, files, extra = {}) {
  return {
    mode,
    orgId,
    warehouse,
    actor,
    inputPath: extra.inputPath,
    reportDir: extra.reportDir,
    parsedInput: {
      sourceEntryCount: parsedInput.sourceEntryCount,
      uniqueEntryCount: parsedInput.uniqueEntryCount,
      duplicateSourceIds: parsedInput.duplicateSourceIds
    },
    summary: diff.summary,
    breakdowns: diff.breakdowns,
    extra: {
      actorUserId: extra.actorUserId,
      actorRole: extra.actorRole,
      auditNote: extra.auditNote,
      appliedCount: Array.isArray(extra.appliedRows) ? extra.appliedRows.length : 0,
      postApplySummary: extra.postApplySummary || null
    },
    files
  };
}

async function zeroBoxViaDirectHelpers(client, orgId, actor, payload) {
  const boxId = asTrimmedString(payload.boxId);
  const auditNote = asTrimmedString(payload.auditNote);
  const { rows: existingRows } = await client.query(
    `
      select
        b.status,
        b.received_date,
        app_api.public_box_json(b) as public_before
      from app.boxes b
      where b.org_id = $1::uuid
        and b.box_id = $2::text
      for update
    `,
    [orgId, boxId]
  );

  if (!existingRows.length) {
    throw new Error(`Box not found during apply: ${boxId}`);
  }

  const existingStatus = asTrimmedString(existingRows[0].status).toUpperCase();
  if (existingStatus !== "ORDERED" && existingStatus !== "IN_STOCK") {
    throw new Error(`Cannot zero ${boxId} because it is ${existingStatus || "UNKNOWN"}.`);
  }

  const cancelledResult = await client.query(
    `
      select app_api.cancel_active_allocations_for_box(
        $1::uuid,
        $2::text,
        $3::text,
        'Auto-cancelled because the box was moved to zeroed out inventory.'
      ) as cancelled_count
    `,
    [orgId, boxId, actor]
  );
  const cancelledCount = Number(cancelledResult.rows[0]?.cancelled_count || 0);

  const updatedResult = await client.query(
    `
      update app.boxes as b
      set
        status = 'ZEROED',
        feet_available = 0,
        zeroed_date = app_api.today_date(),
        zeroed_reason =
          app_api.determine_zeroed_reason(0, b.last_roll_weight_lbs) ||
          case
            when app_api.normalize_meaningful_zeroed_note($4::text) <> '' then
              ' Additional note: ' || app_api.normalize_meaningful_zeroed_note($4::text)
            else
              ''
          end,
        zeroed_by = $3::text
      where b.org_id = $1::uuid
        and b.box_id = $2::text
        and b.status in ('ORDERED', 'IN_STOCK')
      returning app_api.public_box_json(b) as public_after
    `,
    [orgId, boxId, actor, auditNote]
  );

  if (!updatedResult.rows.length) {
    throw new Error(`Status drift detected while zeroing ${boxId}.`);
  }

  const beforeState = existingRows[0].public_before;
  const afterState = updatedResult.rows[0].public_after;
  const auditResult = await client.query(
    `
      select app_api.append_audit_entry(
        $1::uuid,
        'ZERO_OUT_BOX',
        $2::text,
        $3::jsonb,
        $4::jsonb,
        $5::text,
        $6::text
      ) as log_id
    `,
    [orgId, boxId, JSON.stringify(beforeState), JSON.stringify(afterState), actor, auditNote]
  );

  const warnings = [];
  if (cancelledCount > 0) {
    warnings.push(
      `${cancelledCount} allocation${cancelledCount === 1 ? " was" : "s were"} cancelled because the box moved to zeroed out inventory.`
    );
  }

  return {
    logId: asTrimmedString(auditResult.rows[0]?.log_id),
    warnings
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const applyMode = args.apply === true;
  const databaseUrl = asTrimmedString(args["database-url"] || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);
  const orgId = asTrimmedString(args["org-id"] || process.env.DEFAULT_ORG_ID);
  const warehouse = asTrimmedString(args.warehouse || DEFAULT_WAREHOUSE).toUpperCase() || DEFAULT_WAREHOUSE;
  const actor = asTrimmedString(args.actor || DEFAULT_ACTOR);
  const auditNote = asTrimmedString(args["audit-note"] || DEFAULT_AUDIT_NOTE);
  const inputPath = path.resolve(args.input ? String(args.input) : DEFAULT_INPUT_PATH);
  const reportDir = path.resolve(args["report-dir"] ? String(args["report-dir"]) : DEFAULT_REPORT_DIR);

  assertOk(databaseUrl, "DATABASE_URL or SUPABASE_DB_URL is required.");
  assertOk(orgId, "DEFAULT_ORG_ID is required.");
  assertOk(warehouse === DEFAULT_WAREHOUSE, `This script is locked to ${DEFAULT_WAREHOUSE}.`);
  assertOk(fs.existsSync(inputPath), `Shelf-audit input file not found: ${inputPath}`);

  const parsedInput = parseShelfAuditText(fs.readFileSync(inputPath, "utf8"), warehouse);
  const client = buildClient(databaseUrl);

  await client.connect();

  try {
    if (!applyMode) {
      const rows = await loadWarehouseRows(client, orgId, warehouse);
      const diff = buildShelfAuditDiff(rows, parsedInput);
      const files = writeArtifacts(reportDir, "dry-run", parsedInput, diff, {
        inputPath,
        reportDir
      });
      console.log(
        JSON.stringify(
          summarizeConsoleReport("dry-run", orgId, warehouse, actor, parsedInput, diff, files, {
            inputPath,
            reportDir,
            auditNote
          }),
          null,
          2
        )
      );
      return;
    }

    await client.query("begin");
    try {
      await client.query(`set local lock_timeout = '5s'`);
      await client.query(`set local statement_timeout = '30s'`);

      const { userId, role } = await resolveActorMember(client, orgId);
      await setAuthenticatedContext(client, userId);

      const beforeRows = await loadWarehouseRows(client, orgId, warehouse);
      const beforeDiff = buildShelfAuditDiff(beforeRows, parsedInput);
      const candidateIds = beforeDiff.zeroCandidates.map((row) => row.boxId);

      let lockedCandidates = [];
      if (candidateIds.length) {
        lockedCandidates = await loadWarehouseRows(client, orgId, warehouse, candidateIds, true);
        assertOk(
          lockedCandidates.length === candidateIds.length,
          `Apply verification failed: expected to lock ${candidateIds.length} zero candidates but found ${lockedCandidates.length}.`
        );
        validateApplyCandidates(lockedCandidates);
      }

      const appliedRows = await applyZeroCandidates(
        client,
        orgId,
        actor,
        lockedCandidates,
        auditNote,
        zeroBoxViaDirectHelpers
      );
      const afterRows = await loadWarehouseRows(client, orgId, warehouse);
      const afterDiff = buildShelfAuditDiff(afterRows, parsedInput);

      assertOk(
        afterDiff.zeroCandidates.length === 0,
        `Apply verification failed: ${afterDiff.zeroCandidates.length} zero candidates still remain after apply.`
      );

      await client.query("commit");

      const files = writeArtifacts(reportDir, "apply", parsedInput, beforeDiff, {
        inputPath,
        reportDir,
        actorUserId: userId,
        actorRole: role,
        auditNote,
        appliedRows,
        postApplySummary: afterDiff.summary
      });

      console.log(
        JSON.stringify(
          summarizeConsoleReport("apply", orgId, warehouse, actor, parsedInput, beforeDiff, files, {
            inputPath,
            reportDir,
            actorUserId: userId,
            actorRole: role,
            auditNote,
            appliedRows,
            postApplySummary: afterDiff.summary
          }),
          null,
          2
        )
      );
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
