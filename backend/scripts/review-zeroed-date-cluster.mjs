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
  const result = {};
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = String(args.profile || "MS").toUpperCase();
  const focusDate = String(args["focus-date"] || "2026-01-14");
  const runDir = profile === "MS"
    ? path.join(backendDir, "migration-dry-runs", "ms-inventory")
    : path.join(backendDir, "migration-dry-runs", "il-assigned");
  const reportPath = args["report-json"]
    ? path.resolve(repoRoot, String(args["report-json"]))
    : path.join(runDir, "zeroed_cluster_review.json");

  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing env file: ${envPath}`);
  }

  const env = parseEnv(envPath);
  const databaseUrl = env.DATABASE_URL;
  const orgId = env.DEFAULT_ORG_ID;
  if (!databaseUrl) throw new Error("DATABASE_URL missing in backend/.env");
  if (!orgId) throw new Error("DEFAULT_ORG_ID missing in backend/.env");

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    const topOverall = await client.query(
      `
        select zeroed_date, warehouse, count(*)::int as count
        from app.boxes
        where org_id = $1::uuid
          and status = 'ZEROED'
        group by zeroed_date, warehouse
        order by count(*) desc, zeroed_date, warehouse
        limit 20
      `,
      [orgId],
    );

    const focusSummary = await client.query(
      `
        select
          count(*)::int as total_rows,
          count(*) filter (where warehouse = 'IL1')::int as il1_rows,
          count(*) filter (where warehouse = 'MS1')::int as ms1_rows,
          count(*) filter (where order_date = zeroed_date)::int as order_equals_zeroed,
          count(*) filter (where received_date = zeroed_date)::int as received_equals_zeroed,
          count(*) filter (where coalesce(notes, '') ilike '%SourceSheet=%')::int as notes_source_sheet,
          count(*) filter (where coalesce(notes, '') ilike '%ExceptionResolved=%')::int as notes_exception_resolved,
          count(*) filter (where coalesce(notes, '') ilike '%RemainingExceptionResolved=%')::int as notes_remaining_exception,
          count(*) filter (where coalesce(notes, '') = '')::int as notes_empty
        from app.boxes
        where org_id = $1::uuid
          and status = 'ZEROED'
          and zeroed_date = $2::date
      `,
      [orgId, focusDate],
    );

    const focusWarehouse = await client.query(
      `
        select warehouse, count(*)::int as count
        from app.boxes
        where org_id = $1::uuid
          and status = 'ZEROED'
          and zeroed_date = $2::date
        group by warehouse
        order by count(*) desc, warehouse
      `,
      [orgId, focusDate],
    );

    const notesPrefixes = await client.query(
      `
        select left(coalesce(notes, ''), 90) as notes_prefix, count(*)::int as count
        from app.boxes
        where org_id = $1::uuid
          and status = 'ZEROED'
          and zeroed_date = $2::date
        group by 1
        order by count(*) desc, 1
        limit 20
      `,
      [orgId, focusDate],
    );

    const focusSamples = await client.query(
      `
        select
          box_id,
          warehouse,
          manufacturer,
          film_name,
          width_in,
          initial_feet,
          feet_available,
          order_date,
          received_date,
          zeroed_date,
          left(coalesce(notes, ''), 140) as notes_prefix
        from app.boxes
        where org_id = $1::uuid
          and status = 'ZEROED'
          and zeroed_date = $2::date
        order by warehouse, box_id
        limit 40
      `,
      [orgId, focusDate],
    );

    const msSpecific = await client.query(
      `
        select
          count(*)::int as total_ms_zeroed,
          count(*) filter (where zeroed_date = $2::date)::int as ms_focus_date_rows,
          count(*) filter (where zeroed_date = '2025-07-31'::date)::int as ms_2025_07_31_rows
        from app.boxes
        where org_id = $1::uuid
          and warehouse = 'MS1'
          and status = 'ZEROED'
      `,
      [orgId, focusDate],
    );

    const report = {
      generated_at_utc: new Date().toISOString(),
      org_id: orgId,
      profile,
      focus_date: focusDate,
      top_zeroed_date_by_warehouse: topOverall.rows,
      focus_date_summary: focusSummary.rows[0] ?? null,
      focus_date_warehouse_breakdown: focusWarehouse.rows,
      focus_date_notes_prefix_top20: notesPrefixes.rows,
      focus_date_sample_rows: focusSamples.rows,
      ms1_zeroed_snapshot: msSpecific.rows[0] ?? null,
    };

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
