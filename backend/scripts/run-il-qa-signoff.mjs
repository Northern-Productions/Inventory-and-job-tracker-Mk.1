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

const args = parseArgs(process.argv.slice(2));
const profile = String(args.profile || "IL").toUpperCase();
const defaultRunDir = profile === "MS"
  ? path.join(backendDir, "migration-dry-runs", "ms-inventory")
  : path.join(backendDir, "migration-dry-runs", "il-assigned");
const runDir = args["run-dir"] ? path.resolve(repoRoot, String(args["run-dir"])) : defaultRunDir;
const csvPath = args.csv ? path.resolve(repoRoot, String(args.csv)) : path.join(runDir, "boxes_raw_final_with_zeroed.csv");
const reportJsonPath = args["report-json"]
  ? path.resolve(repoRoot, String(args["report-json"]))
  : path.join(runDir, "qa_signoff_report.json");
const reportMdPath = args["report-md"]
  ? path.resolve(repoRoot, String(args["report-md"]))
  : path.join(runDir, "qa_signoff_report.md");

const REQUIRED_COLUMNS = [
  "BoxID",
  "Manufacturer",
  "FilmName",
  "WidthIn",
  "InitialFeet",
  "FeetAvailable",
  "LotRun",
  "Status",
  "OrderDate",
  "ReceivedDate",
  "InitialWeightLbs",
  "LastRollWeightLbs",
  "LastWeighedDate",
  "FilmKey",
  "CoreType",
  "CoreWeightLbs",
  "LfWeightLbsPerFt",
  "PricePerLf",
  "PurchaseCost",
  "Notes",
  "HasEverBeenCheckedOut",
  "LastCheckoutJob",
  "LastCheckoutDate",
  "ZeroedDate",
  "ZeroedReason",
  "ZeroedBy",
];

function parseEnv(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
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
    if (ch === "\r") continue;
    field += ch;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function toObjects(csvRows) {
  if (csvRows.length === 0) return [];
  const header = csvRows[0].map((h, idx) => (idx === 0 ? h.replace(/^\uFEFF/, "") : h));
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(`CSV missing required columns: ${missing.join(", ")}`);
  }

  const rows = [];
  for (let i = 1; i < csvRows.length; i += 1) {
    const raw = csvRows[i];
    if (raw.length === 1 && raw[0] === "") continue;
    const obj = {};
    for (let col = 0; col < header.length; col += 1) {
      obj[header[col]] = raw[col] ?? "";
    }
    rows.push(obj);
  }
  return rows;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function loadCsvTempTable(client, rows) {
  await client.query(`
    create temporary table tmp_csv_boxes (
      box_id text primary key,
      manufacturer text not null,
      film_name text not null,
      width_in text,
      initial_feet text,
      feet_available text,
      status text,
      order_date text,
      received_date text
    ) on commit drop
  `);

  const parts = chunk(rows, 250);
  for (const part of parts) {
    const values = [];
    const placeholders = [];
    let p = 1;
    for (const row of part) {
      placeholders.push(`($${p},$${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},$${p + 8})`);
      values.push(
        (row.BoxID ?? "").trim(),
        (row.Manufacturer ?? "").trim(),
        (row.FilmName ?? "").trim(),
        (row.WidthIn ?? "").trim(),
        (row.InitialFeet ?? "").trim(),
        (row.FeetAvailable ?? "").trim(),
        (row.Status ?? "").trim(),
        (row.OrderDate ?? "").trim(),
        (row.ReceivedDate ?? "").trim(),
      );
      p += 9;
    }
    await client.query(
      `
        insert into tmp_csv_boxes (
          box_id, manufacturer, film_name, width_in, initial_feet, feet_available, status, order_date, received_date
        ) values ${placeholders.join(", ")}
      `,
      values,
    );
  }
}

function mdList(items) {
  if (!items || items.length === 0) return "- (none)";
  return items.map((x) => `- ${x}`).join("\n");
}

async function main() {
  if (!fs.existsSync(envPath)) throw new Error(`Missing env file: ${envPath}`);
  if (!fs.existsSync(csvPath)) throw new Error(`Missing CSV file: ${csvPath}`);

  const env = parseEnv(envPath);
  const databaseUrl = env.DATABASE_URL;
  const orgId = env.DEFAULT_ORG_ID;
  if (!databaseUrl) throw new Error("DATABASE_URL missing in backend/.env");
  if (!orgId) throw new Error("DEFAULT_ORG_ID missing in backend/.env");

  const csvRows = toObjects(parseCsv(fs.readFileSync(csvPath, "utf8")));
  const uniqueCsvIds = new Set(csvRows.map((r) => (r.BoxID ?? "").trim())).size;

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query("begin");
    await loadCsvTempTable(client, csvRows);

    const nowRes = await client.query("select now() at time zone 'UTC' as now_utc");
    const dbNowUtc = nowRes.rows[0]?.now_utc ?? null;

    const totalRes = await client.query(
      "select count(*)::int as c from app.boxes where org_id = $1::uuid",
      [orgId],
    );
    const totalBoxes = totalRes.rows[0]?.c ?? 0;

    const presentRes = await client.query(
      `
        select count(*)::int as c
        from tmp_csv_boxes c
        join app.boxes b
          on b.org_id = $1::uuid
         and b.box_id = c.box_id
      `,
      [orgId],
    );
    const presentCsvIds = presentRes.rows[0]?.c ?? 0;

    const missingRes = await client.query(
      `
        select c.box_id
        from tmp_csv_boxes c
        left join app.boxes b
          on b.org_id = $1::uuid
         and b.box_id = c.box_id
        where b.box_id is null
        order by c.box_id
        limit 50
      `,
      [orgId],
    );
    const missingSample = missingRes.rows.map((r) => r.box_id);

    const missingCountRes = await client.query(
      `
        select count(*)::int as c
        from tmp_csv_boxes c
        left join app.boxes b
          on b.org_id = $1::uuid
         and b.box_id = c.box_id
        where b.box_id is null
      `,
      [orgId],
    );
    const missingCount = missingCountRes.rows[0]?.c ?? 0;

    const dupesRes = await client.query(
      `
        select count(*)::int as c
        from (
          select box_id
          from app.boxes
          where org_id = $1::uuid
          group by box_id
          having count(*) > 1
        ) d
      `,
      [orgId],
    );
    const duplicateCount = dupesRes.rows[0]?.c ?? 0;

    const invalidRequiredRes = await client.query(
      `
        select count(*)::int as c
        from app.boxes
        where org_id = $1::uuid
          and (
            trim(box_id) = ''
            or trim(manufacturer) = ''
            or trim(film_name) = ''
            or width_in <= 0
            or initial_feet < 0
            or feet_available < 0
            or feet_available > initial_feet
            or order_date is null
          )
      `,
      [orgId],
    );
    const invalidRequiredCount = invalidRequiredRes.rows[0]?.c ?? 0;

    const routeMismatchRes = await client.query(
      `
        select count(*)::int as c
        from app.boxes b
        where b.org_id = $1::uuid
          and app_api.resolve_warehouse_from_box_id($1::uuid, b.box_id) <> b.warehouse
      `,
      [orgId],
    );
    const routeMismatchCount = routeMismatchRes.rows[0]?.c ?? 0;

    const statusRes = await client.query(
      `
        select status, count(*)::int as count
        from app.boxes
        where org_id = $1::uuid
        group by status
        order by count(*) desc, status
      `,
      [orgId],
    );

    const warehouseRes = await client.query(
      `
        select warehouse, count(*)::int as count
        from app.boxes
        where org_id = $1::uuid
        group by warehouse
        order by count(*) desc, warehouse
      `,
      [orgId],
    );

    const csvDiffCountRes = await client.query(
      `
        with j as (
          select
            c.box_id,
            b.manufacturer as db_manufacturer,
            c.manufacturer as csv_manufacturer,
            b.film_name as db_film_name,
            c.film_name as csv_film_name,
            b.width_in as db_width_in,
            nullif(c.width_in, '')::numeric as csv_width_in,
            b.initial_feet as db_initial_feet,
            nullif(c.initial_feet, '')::integer as csv_initial_feet,
            b.feet_available as db_feet_available,
            nullif(c.feet_available, '')::integer as csv_feet_available,
            b.status as db_status,
            c.status as csv_status,
            b.order_date as db_order_date,
            nullif(c.order_date, '')::date as csv_order_date,
            b.received_date as db_received_date,
            nullif(c.received_date, '')::date as csv_received_date
          from tmp_csv_boxes c
          join app.boxes b
            on b.org_id = $1::uuid
           and b.box_id = c.box_id
        )
        select count(*)::int as c
        from j
        where
          db_manufacturer is distinct from csv_manufacturer
          or db_film_name is distinct from csv_film_name
          or db_width_in is distinct from csv_width_in
          or db_initial_feet is distinct from csv_initial_feet
          or db_feet_available is distinct from csv_feet_available
          or db_status::text is distinct from csv_status
          or db_order_date is distinct from csv_order_date
          or db_received_date is distinct from csv_received_date
      `,
      [orgId],
    );
    const csvDiffCount = csvDiffCountRes.rows[0]?.c ?? 0;

    const csvDiffSampleRes = await client.query(
      `
        with j as (
          select
            c.box_id,
            b.manufacturer as db_manufacturer,
            c.manufacturer as csv_manufacturer,
            b.film_name as db_film_name,
            c.film_name as csv_film_name,
            b.width_in as db_width_in,
            nullif(c.width_in, '')::numeric as csv_width_in,
            b.initial_feet as db_initial_feet,
            nullif(c.initial_feet, '')::integer as csv_initial_feet,
            b.feet_available as db_feet_available,
            nullif(c.feet_available, '')::integer as csv_feet_available,
            b.status as db_status,
            c.status as csv_status,
            b.order_date as db_order_date,
            nullif(c.order_date, '')::date as csv_order_date,
            b.received_date as db_received_date,
            nullif(c.received_date, '')::date as csv_received_date
          from tmp_csv_boxes c
          join app.boxes b
            on b.org_id = $1::uuid
           and b.box_id = c.box_id
        )
        select *
        from j
        where
          db_manufacturer is distinct from csv_manufacturer
          or db_film_name is distinct from csv_film_name
          or db_width_in is distinct from csv_width_in
          or db_initial_feet is distinct from csv_initial_feet
          or db_feet_available is distinct from csv_feet_available
          or db_status::text is distinct from csv_status
          or db_order_date is distinct from csv_order_date
          or db_received_date is distinct from csv_received_date
        order by box_id
        limit 40
      `,
      [orgId],
    );

    const zeroedDistRes = await client.query(
      `
        select zeroed_date, count(*)::int as count
        from app.boxes
        where org_id = $1::uuid
          and status = 'ZEROED'
        group by zeroed_date
        order by count(*) desc, zeroed_date
        limit 10
      `,
      [orgId],
    );

    const blockers = [];
    if (missingCount > 0) blockers.push(`Missing CSV box IDs in app.boxes: ${missingCount}`);
    if (duplicateCount > 0) blockers.push(`Duplicate box_id rows: ${duplicateCount}`);
    if (invalidRequiredCount > 0) blockers.push(`Invalid required/numeric rows: ${invalidRequiredCount}`);
    if (routeMismatchCount > 0) blockers.push(`Warehouse routing mismatches: ${routeMismatchCount}`);

    const warnings = [];
    if (csvDiffCount > 0) warnings.push(`CSV vs DB field differences on matched BoxIDs: ${csvDiffCount} (expected when keep_existing skipped conflicts)`);
    const topZeroed = zeroedDistRes.rows[0];
    if (topZeroed && Number(topZeroed.count) > 1000) {
      warnings.push(`Large inferred zeroed-date concentration remains (${topZeroed.count} rows on ${topZeroed.zeroed_date}).`);
    }

    const report = {
      generated_at_utc: new Date().toISOString(),
      profile,
      db_now_utc: dbNowUtc,
      org_id: orgId,
      run_dir: path.relative(repoRoot, runDir).replace(/\\/g, "/"),
      csv_path: path.relative(repoRoot, csvPath).replace(/\\/g, "/"),
      totals: {
        csv_rows: csvRows.length,
        csv_unique_box_ids: uniqueCsvIds,
        db_boxes_for_org: totalBoxes,
        csv_box_ids_present_in_db: presentCsvIds,
        csv_box_ids_missing_in_db: missingCount,
      },
      integrity: {
        duplicate_box_ids: duplicateCount,
        invalid_required_or_numeric_rows: invalidRequiredCount,
        warehouse_routing_mismatches: routeMismatchCount,
      },
      distribution: {
        status_counts: statusRes.rows,
        warehouse_counts: warehouseRes.rows,
        zeroed_date_top10: zeroedDistRes.rows,
      },
      compare_csv_to_db: {
        differing_box_ids_count: csvDiffCount,
        differing_box_ids_sample: csvDiffSampleRes.rows,
        missing_box_ids_sample: missingSample,
      },
      signoff: {
        passed: blockers.length === 0,
        blockers,
        warnings,
      },
    };

    fs.mkdirSync(path.dirname(reportJsonPath), { recursive: true });
    fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const md = [
      `# ${profile} Merge QA Sign-Off`,
      "",
      `- Generated (UTC): ${report.generated_at_utc}`,
      `- Org: \`${orgId}\``,
      `- CSV: \`${report.csv_path}\``,
      "",
      "## Totals",
      `- CSV rows: ${report.totals.csv_rows}`,
      `- CSV unique BoxIDs: ${report.totals.csv_unique_box_ids}`,
      `- DB boxes for org: ${report.totals.db_boxes_for_org}`,
      `- CSV BoxIDs present in DB: ${report.totals.csv_box_ids_present_in_db}`,
      `- CSV BoxIDs missing in DB: ${report.totals.csv_box_ids_missing_in_db}`,
      "",
      "## Integrity Gates",
      `- Duplicate box_id rows: ${report.integrity.duplicate_box_ids}`,
      `- Invalid required/numeric rows: ${report.integrity.invalid_required_or_numeric_rows}`,
      `- Warehouse routing mismatches: ${report.integrity.warehouse_routing_mismatches}`,
      "",
      "## Status Counts",
      ...report.distribution.status_counts.map((r) => `- ${r.status}: ${r.count}`),
      "",
      "## Warehouse Counts",
      ...report.distribution.warehouse_counts.map((r) => `- ${r.warehouse}: ${r.count}`),
      "",
      "## Sign-Off",
      `- Passed: ${report.signoff.passed ? "YES" : "NO"}`,
      "- Blockers:",
      mdList(report.signoff.blockers),
      "- Warnings:",
      mdList(report.signoff.warnings),
      "",
    ].join("\n");

    fs.writeFileSync(reportMdPath, `${md}\n`, "utf8");

    await client.query("commit");
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // noop
    }
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exitCode = 1;
});
