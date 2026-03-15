import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(backendDir, "..");
const envPath = path.join(backendDir, ".env");

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return options;
}

function parseEnv(filePath) {
  const out = {};
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\r") {
      continue;
    }
    field += ch;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function toCsvObjects(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((value, index) => index === 0 ? value.replace(/^\uFEFF/, "") : value);
  const objects = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.length === 1 && row[0] === "") continue;
    const next = {};
    for (let col = 0; col < header.length; col += 1) {
      next[header[col]] = row[col] ?? "";
    }
    objects.push(next);
  }
  return objects;
}

function escapeCsvValue(value) {
  const text = String(value ?? "");
  if (text.includes('"') || text.includes(",") || text.includes("\n") || text.includes("\r")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeCsv(filePath, rows, columns) {
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((column) => escapeCsvValue(row[column] ?? "")).join(","));
  const content = [header, ...body].join("\n");
  fs.writeFileSync(filePath, content, "utf8");
}

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function integerOrZero(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.trunc(parsed);
}

function getDetectionReason(row) {
  const combined = `${row.manufacturer || ""} ${row.film_name || ""} ${row.notes || ""}`.toLowerCase();
  if (/\bdow\s*995\b/.test(combined)) return "dow_995";
  if (/\bdow\s*795\b/.test(combined)) return "dow_795";
  if (/\bcaulk\b/.test(combined)) return "caulk_keyword";
  if (/\bsilicone\b/.test(combined)) return "silicone_keyword";
  return "";
}

function suggestCaulkFields(row, detectionReason) {
  const sourceManufacturer = asTrimmedString(row.manufacturer);
  const sourceFilmName = asTrimmedString(row.film_name);
  let suggestedManufacturer = sourceManufacturer;
  if (!suggestedManufacturer) {
    suggestedManufacturer = "Caulk";
  }
  if (detectionReason === "dow_995" || detectionReason === "dow_795") {
    suggestedManufacturer = "3M";
  }

  const suggestedProductName = sourceFilmName || asTrimmedString(row.notes) || "Unknown Caulk";
  let suggestedProductCode = "";
  const codeMatch = suggestedProductName.match(/\bdow\s*(995|795)\b/i);
  if (codeMatch) {
    suggestedProductCode = `DOW-${codeMatch[1]}`;
  }

  return {
    suggestedManufacturer,
    suggestedProductName,
    suggestedProductCode,
    suggestedTubesPerCase: 16,
  };
}

function normalizeDecision(value) {
  return asTrimmedString(value).toLowerCase();
}

function isDecisionApproved(value) {
  const normalized = normalizeDecision(value);
  return normalized === "approve" ||
    normalized === "approved" ||
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "true" ||
    normalized === "1";
}

function isDecisionRejected(value) {
  const normalized = normalizeDecision(value);
  return normalized === "reject" ||
    normalized === "rejected" ||
    normalized === "no" ||
    normalized === "n" ||
    normalized === "false" ||
    normalized === "0";
}

const args = parseArgs(process.argv.slice(2));
const mode = String(args.mode || "dry-run").toLowerCase();
if (mode !== "dry-run" && mode !== "apply") {
  throw new Error("Unsupported mode. Use --mode dry-run or --mode apply.");
}

const profile = String(args.profile || "IL").toUpperCase();
const defaultRunDir = profile === "MS"
  ? path.join(backendDir, "migration-dry-runs", "ms-inventory")
  : path.join(backendDir, "migration-dry-runs", "il-assigned");
const runDir = args["run-dir"] ? path.resolve(repoRoot, String(args["run-dir"])) : defaultRunDir;
const candidatesCsvPath = path.join(runDir, "caulk_backfill_candidates.csv");
const decisionsCsvPath = args.decisions
  ? path.resolve(repoRoot, String(args.decisions))
  : path.join(runDir, "caulk_backfill_decisions.csv");
const reportJsonPath = path.join(runDir, "caulk_backfill_report.json");
const actor = asTrimmedString(args.actor || "caulk-backfill-script");

const candidateColumns = [
  "source_box_id",
  "warehouse",
  "source_manufacturer",
  "source_film_name",
  "status",
  "initial_cases",
  "available_cases",
  "detection_reason",
  "suggested_manufacturer",
  "suggested_product_name",
  "suggested_product_code",
  "suggested_tubes_per_case",
  "source_notes",
];

const decisionColumns = [
  "source_box_id",
  "warehouse",
  "source_manufacturer",
  "source_film_name",
  "initial_cases",
  "available_cases",
  "decision",
  "canonical_manufacturer",
  "canonical_product_name",
  "canonical_product_code",
  "canonical_tubes_per_case",
  "notes",
];

if (!fs.existsSync(runDir)) {
  fs.mkdirSync(runDir, { recursive: true });
}

if (!fs.existsSync(envPath)) {
  throw new Error(`Missing env file: ${envPath}`);
}

const env = parseEnv(envPath);
const databaseUrl = env.DATABASE_URL;
const orgId = env.DEFAULT_ORG_ID;
if (!databaseUrl) {
  throw new Error("DATABASE_URL missing in backend/.env");
}
if (!orgId) {
  throw new Error("DEFAULT_ORG_ID missing in backend/.env");
}

const client = new Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  const boxRowsRes = await client.query(
    `
      select
        box_id,
        warehouse,
        manufacturer,
        film_name,
        initial_feet,
        feet_available,
        status,
        notes
      from app.boxes
      where org_id = $1::uuid
        and status <> 'RETIRED'
      order by box_id
    `,
    [orgId],
  );
  const allRows = boxRowsRes.rows || [];
  const candidateRows = [];
  for (const row of allRows) {
    const detectionReason = getDetectionReason(row);
    if (!detectionReason) continue;
    const suggested = suggestCaulkFields(row, detectionReason);
    candidateRows.push({
      source_box_id: asTrimmedString(row.box_id),
      warehouse: asTrimmedString(row.warehouse).toUpperCase(),
      source_manufacturer: asTrimmedString(row.manufacturer),
      source_film_name: asTrimmedString(row.film_name),
      status: asTrimmedString(row.status),
      initial_cases: integerOrZero(row.initial_feet),
      available_cases: integerOrZero(row.feet_available),
      detection_reason: detectionReason,
      suggested_manufacturer: suggested.suggestedManufacturer,
      suggested_product_name: suggested.suggestedProductName,
      suggested_product_code: suggested.suggestedProductCode,
      suggested_tubes_per_case: suggested.suggestedTubesPerCase,
      source_notes: asTrimmedString(row.notes),
    });
  }

  writeCsv(candidatesCsvPath, candidateRows, candidateColumns);

  let existingDecisions = [];
  if (fs.existsSync(decisionsCsvPath)) {
    existingDecisions = toCsvObjects(fs.readFileSync(decisionsCsvPath, "utf8"));
  }
  const existingByBoxId = new Map();
  for (const row of existingDecisions) {
    const boxId = asTrimmedString(row.source_box_id);
    if (!boxId) continue;
    existingByBoxId.set(boxId, row);
  }

  const decisionRows = candidateRows.map((candidate) => {
    const existing = existingByBoxId.get(candidate.source_box_id);
    return {
      source_box_id: candidate.source_box_id,
      warehouse: candidate.warehouse,
      source_manufacturer: candidate.source_manufacturer,
      source_film_name: candidate.source_film_name,
      initial_cases: candidate.initial_cases,
      available_cases: candidate.available_cases,
      decision: asTrimmedString(existing?.decision),
      canonical_manufacturer: asTrimmedString(existing?.canonical_manufacturer) || candidate.suggested_manufacturer,
      canonical_product_name: asTrimmedString(existing?.canonical_product_name) || candidate.suggested_product_name,
      canonical_product_code: asTrimmedString(existing?.canonical_product_code) || candidate.suggested_product_code,
      canonical_tubes_per_case: integerOrZero(existing?.canonical_tubes_per_case) > 0
        ? integerOrZero(existing?.canonical_tubes_per_case)
        : candidate.suggested_tubes_per_case,
      notes: asTrimmedString(existing?.notes),
    };
  });

  writeCsv(decisionsCsvPath, decisionRows, decisionColumns);

  const pending = [];
  const approved = [];
  const rejected = [];
  for (const row of decisionRows) {
    if (isDecisionApproved(row.decision)) {
      approved.push(row);
      continue;
    }
    if (isDecisionRejected(row.decision)) {
      rejected.push(row);
      continue;
    }
    pending.push(row);
  }

  const report = {
    generatedAtUtc: new Date().toISOString(),
    mode,
    profile,
    runDir,
    totals: {
      boxRowsScanned: allRows.length,
      caulkCandidates: candidateRows.length,
      decisionApproved: approved.length,
      decisionRejected: rejected.length,
      decisionPending: pending.length,
    },
    artifacts: {
      candidatesCsv: candidatesCsvPath,
      decisionsCsv: decisionsCsvPath,
      reportJson: reportJsonPath,
    },
    blockers: {
      pendingDecisions: pending.length,
    },
  };

  if (mode === "apply") {
    if (pending.length > 0) {
      throw new Error(`Cannot apply with pending decisions (${pending.length}).`);
    }

    await client.query("begin");
    const appliedRows = [];
    const skippedAlreadyMapped = [];

    for (const row of approved) {
      const sourceBoxId = asTrimmedString(row.source_box_id);
      const warehouse = asTrimmedString(row.warehouse).toUpperCase();
      const canonicalManufacturer = asTrimmedString(row.canonical_manufacturer);
      const canonicalProductName = asTrimmedString(row.canonical_product_name);
      const canonicalProductCode = asTrimmedString(row.canonical_product_code);
      const tubesPerCase = Math.max(1, integerOrZero(row.canonical_tubes_per_case));

      const mappedRes = await client.query(
        `
          select 1
          from app.caulk_backfill_map
          where org_id = $1::uuid
            and source_box_id = $2::text
        `,
        [orgId, sourceBoxId],
      );
      if ((mappedRes.rows || []).length > 0) {
        skippedAlreadyMapped.push(sourceBoxId);
        continue;
      }

      const sourceBoxRes = await client.query(
        `
          select box_id, warehouse, feet_available, status, notes
          from app.boxes
          where org_id = $1::uuid
            and box_id = $2::text
          for update
        `,
        [orgId, sourceBoxId],
      );
      const sourceBox = sourceBoxRes.rows[0];
      if (!sourceBox) {
        throw new Error(`Source box ${sourceBoxId} was not found.`);
      }
      if (String(sourceBox.status || "").toUpperCase() === "RETIRED") {
        skippedAlreadyMapped.push(sourceBoxId);
        continue;
      }

      const manufacturerRes = await client.query(
        `
          select (app_api.caulk_upsert_manufacturer($1::uuid, $2::text, $3::text, true)).id as manufacturer_id
        `,
        [orgId, actor, canonicalManufacturer],
      );
      const manufacturerId = asTrimmedString(manufacturerRes.rows[0]?.manufacturer_id);
      if (!manufacturerId) {
        throw new Error(`Unable to upsert manufacturer for ${sourceBoxId}.`);
      }

      const productRes = await client.query(
        `
          select (app_api.caulk_upsert_product(
            $1::uuid,
            $2::text,
            null::uuid,
            $3::uuid,
            $4::text,
            $5::text,
            $6::integer,
            true,
            $7::text
          )).id as product_id
        `,
        [orgId, actor, manufacturerId, canonicalProductName, canonicalProductCode, tubesPerCase, "Backfilled from film boxes"],
      );
      const productId = asTrimmedString(productRes.rows[0]?.product_id);
      if (!productId) {
        throw new Error(`Unable to upsert product for ${sourceBoxId}.`);
      }

      const availableCases = Math.max(0, integerOrZero(sourceBox.feet_available));
      const deltaTubes = availableCases * tubesPerCase;
      let transactionId = "";
      if (deltaTubes > 0) {
        const deltaRes = await client.query(
          `
            select app_api.caulk_apply_stock_delta(
              $1::uuid,
              $2::text,
              $3::uuid,
              $4::text,
              'BACKFILL_MIGRATE',
              $5::integer,
              'CAULK_BACKFILL_FROM_BOX',
              '',
              $6::text,
              'Backfilled from app.boxes'
            ) as result
          `,
          [orgId, actor, productId, warehouse, deltaTubes, sourceBoxId],
        );
        transactionId = asTrimmedString(deltaRes.rows[0]?.result?.transactionId);
      } else {
        const txRes = await client.query("select app_api.caulk_create_transaction_id() as tx_id");
        transactionId = asTrimmedString(txRes.rows[0]?.tx_id);
      }

      await client.query(
        `
          insert into app.caulk_backfill_map (
            org_id,
            source_box_id,
            product_id,
            warehouse,
            transaction_id,
            migrated_at,
            migrated_by,
            notes
          )
          values (
            $1::uuid,
            $2::text,
            $3::uuid,
            $4::text,
            $5::text,
            now(),
            $6::text,
            $7::text
          )
          on conflict (org_id, source_box_id) do nothing
        `,
        [orgId, sourceBoxId, productId, warehouse, transactionId, actor, "Backfilled to caulk subsystem"],
      );

      await client.query(
        `
          update app.boxes
          set
            status = 'RETIRED',
            notes = trim(
              both ' '
              from concat(
                coalesce(nullif(notes, ''), ''),
                case when coalesce(nullif(notes, ''), '') = '' then '' else ' ' end,
                '[CAULK_BACKFILL]',
                ' migrated_by=', $3::text,
                ' migrated_at=', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
              )
            ),
            updated_at = now(),
            updated_by = $3::text
          where org_id = $1::uuid
            and box_id = $2::text
        `,
        [orgId, sourceBoxId, actor],
      );

      appliedRows.push({
        sourceBoxId,
        warehouse,
        productId,
        transactionId,
        deltaTubes,
      });
    }

    await client.query("commit");
    report.apply = {
      appliedCount: appliedRows.length,
      skippedAlreadyMapped: skippedAlreadyMapped.length,
      appliedRows,
      skippedRows: skippedAlreadyMapped,
    };
  }

  fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Mode: ${mode}`);
  console.log(`Candidates: ${candidateRows.length}`);
  console.log(`Approved: ${approved.length}`);
  console.log(`Rejected: ${rejected.length}`);
  console.log(`Pending: ${pending.length}`);
  console.log(`Artifacts:\n  ${candidatesCsvPath}\n  ${decisionsCsvPath}\n  ${reportJsonPath}`);
} catch (error) {
  try {
    await client.query("rollback");
  } catch (_rollbackError) {
    // ignore rollback error
  }
  throw error;
} finally {
  await client.end();
}
