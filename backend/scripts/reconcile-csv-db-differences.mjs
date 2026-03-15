import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(backendDir, "..");
const envPath = path.join(backendDir, ".env");

const REQUIRED_COLUMNS = [
  "BoxID",
  "Manufacturer",
  "FilmName",
  "WidthIn",
  "InitialFeet",
  "FeetAvailable",
  "Status",
  "OrderDate",
  "ReceivedDate",
  "ZeroedDate",
];

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
    throw new Error(`CSV missing required columns for reconciliation: ${missing.join(", ")}`);
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

function canonicalizeManufacturerLabel(value) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  switch (normalized.toLowerCase()) {
    case "3m":
      return "3M Solar";
    case "fasara":
    case "3m fasara":
      return "3M Fasara";
    case "avery":
      return "Avery Dennison";
    case "solar guard":
      return "Solar Gard";
    default:
      return normalized;
  }
}

async function loadCsvTempTable(client, rows) {
  await client.query(`
    create temporary table tmp_csv_reconcile (
      box_id text primary key,
      manufacturer text not null,
      film_name text not null,
      width_in numeric(10,4),
      initial_feet integer,
      feet_available integer,
      status app.box_status,
      order_date date,
      received_date date,
      zeroed_date date
    ) on commit drop
  `);

  for (const part of chunk(rows, 250)) {
    const values = [];
    const placeholders = [];
    let p = 1;
    for (const row of part) {
      placeholders.push(`($${p},$${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},$${p + 8},$${p + 9})`);
      values.push(
        (row.BoxID ?? "").trim(),
        canonicalizeManufacturerLabel(row.Manufacturer ?? ""),
        (row.FilmName ?? "").trim(),
        (row.WidthIn ?? "").trim() === "" ? null : Number(row.WidthIn),
        (row.InitialFeet ?? "").trim() === "" ? null : Number(row.InitialFeet),
        (row.FeetAvailable ?? "").trim() === "" ? null : Number(row.FeetAvailable),
        (row.Status ?? "").trim(),
        (row.OrderDate ?? "").trim() === "" ? null : (row.OrderDate ?? "").trim(),
        (row.ReceivedDate ?? "").trim() === "" ? null : (row.ReceivedDate ?? "").trim(),
        (row.ZeroedDate ?? "").trim() === "" ? null : (row.ZeroedDate ?? "").trim(),
      );
      p += 10;
    }

    await client.query(
      `
        insert into tmp_csv_reconcile (
          box_id, manufacturer, film_name, width_in, initial_feet, feet_available, status, order_date, received_date, zeroed_date
        ) values ${placeholders.join(", ")}
      `,
      values,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profile = String(args.profile || "IL").toUpperCase();
  const defaultRunDir = profile === "MS"
    ? path.join(backendDir, "migration-dry-runs", "ms-inventory")
    : path.join(backendDir, "migration-dry-runs", "il-assigned");
  const runDir = args["run-dir"] ? path.resolve(repoRoot, String(args["run-dir"])) : defaultRunDir;
  const csvPath = args.csv ? path.resolve(repoRoot, String(args.csv)) : path.join(runDir, "boxes_raw_final_with_zeroed.csv");
  const reportPath = args["report-json"]
    ? path.resolve(repoRoot, String(args["report-json"]))
    : path.join(runDir, "reconcile_csv_db_differences_report.json");
  const apply = Boolean(args.apply);

  if (!fs.existsSync(envPath)) throw new Error(`Missing env file: ${envPath}`);
  if (!fs.existsSync(csvPath)) throw new Error(`Missing CSV file: ${csvPath}`);

  const env = parseEnv(envPath);
  const databaseUrl = env.DATABASE_URL;
  const orgId = env.DEFAULT_ORG_ID;
  if (!databaseUrl) throw new Error("DATABASE_URL missing in backend/.env");
  if (!orgId) throw new Error("DEFAULT_ORG_ID missing in backend/.env");

  const csvRows = toObjects(parseCsv(fs.readFileSync(csvPath, "utf8")));
  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query("begin");
    await loadCsvTempTable(client, csvRows);

    const diffRes = await client.query(
      `
        with j as (
          select
            c.box_id,
            b.manufacturer as db_manufacturer,
            c.manufacturer as csv_manufacturer,
            b.film_name as db_film_name,
            c.film_name as csv_film_name,
            b.width_in as db_width_in,
            c.width_in as csv_width_in,
            b.initial_feet as db_initial_feet,
            c.initial_feet as csv_initial_feet,
            b.feet_available as db_feet_available,
            c.feet_available as csv_feet_available,
            b.status as db_status,
            c.status as csv_status,
            b.order_date as db_order_date,
            c.order_date as csv_order_date,
            b.received_date as db_received_date,
            c.received_date as csv_received_date,
            b.zeroed_date as db_zeroed_date,
            c.zeroed_date as csv_zeroed_date
          from tmp_csv_reconcile c
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
          or db_status is distinct from csv_status
          or db_order_date is distinct from csv_order_date
          or db_received_date is distinct from csv_received_date
          or db_zeroed_date is distinct from csv_zeroed_date
        order by box_id
      `,
      [orgId],
    );

    let updatedCount = 0;
    if (apply && diffRes.rows.length > 0) {
      const updateRes = await client.query(
        `
          with diff as (
            select
              c.box_id,
              c.manufacturer,
              c.film_name,
              c.width_in,
              c.initial_feet,
              c.feet_available,
              c.status,
              c.order_date,
              c.received_date,
              c.zeroed_date
            from tmp_csv_reconcile c
            join app.boxes b
              on b.org_id = $1::uuid
             and b.box_id = c.box_id
            where
              b.manufacturer is distinct from c.manufacturer
              or b.film_name is distinct from c.film_name
              or b.width_in is distinct from c.width_in
              or b.initial_feet is distinct from c.initial_feet
              or b.feet_available is distinct from c.feet_available
              or b.status is distinct from c.status
              or b.order_date is distinct from c.order_date
              or b.received_date is distinct from c.received_date
              or b.zeroed_date is distinct from c.zeroed_date
          )
          update app.boxes b
          set
            manufacturer = d.manufacturer,
            film_name = d.film_name,
            width_in = d.width_in,
            initial_feet = d.initial_feet,
            feet_available = d.feet_available,
            status = d.status,
            order_date = d.order_date,
            received_date = d.received_date,
            zeroed_date = d.zeroed_date,
            updated_at = now()
          from diff d
          where b.org_id = $1::uuid
            and b.box_id = d.box_id
        `,
        [orgId],
      );
      updatedCount = updateRes.rowCount ?? 0;
    }

    const remainingRes = await client.query(
      `
        with j as (
          select
            c.box_id,
            b.manufacturer as db_manufacturer,
            c.manufacturer as csv_manufacturer,
            b.film_name as db_film_name,
            c.film_name as csv_film_name,
            b.width_in as db_width_in,
            c.width_in as csv_width_in,
            b.initial_feet as db_initial_feet,
            c.initial_feet as csv_initial_feet,
            b.feet_available as db_feet_available,
            c.feet_available as csv_feet_available,
            b.status as db_status,
            c.status as csv_status,
            b.order_date as db_order_date,
            c.order_date as csv_order_date,
            b.received_date as db_received_date,
            c.received_date as csv_received_date,
            b.zeroed_date as db_zeroed_date,
            c.zeroed_date as csv_zeroed_date
          from tmp_csv_reconcile c
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
          or db_status is distinct from csv_status
          or db_order_date is distinct from csv_order_date
          or db_received_date is distinct from csv_received_date
          or db_zeroed_date is distinct from csv_zeroed_date
      `,
      [orgId],
    );
    const remainingCount = Number(remainingRes.rows[0]?.c ?? 0);

    const report = {
      generated_at_utc: new Date().toISOString(),
      profile,
      org_id: orgId,
      csv_path: path.relative(repoRoot, csvPath).replace(/\\/g, "/"),
      apply,
      differing_rows_before: diffRes.rows.length,
      updated_rows: updatedCount,
      differing_rows_after: remainingCount,
      differing_box_ids_sample: diffRes.rows.slice(0, 40).map((r) => r.box_id),
      differing_rows_sample: diffRes.rows.slice(0, 20),
    };

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    await client.query("commit");
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // noop
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
