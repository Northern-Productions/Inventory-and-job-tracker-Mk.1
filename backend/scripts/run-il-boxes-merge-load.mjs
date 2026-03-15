import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(backendDir, "..");

const envPath = path.join(backendDir, ".env");
const migrationPaths = [
  path.join(backendDir, "migrations", "0019_import_boxes_merge_mode.sql"),
  path.join(backendDir, "migrations", "0020_warehouse_prefix_v2.sql"),
];
const csvPath = path.join(backendDir, "migration-dry-runs", "il-assigned", "boxes_raw_final_with_zeroed.csv");

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
  const result = {};
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    result[key] = value;
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

function toObjects(csvRows) {
  if (csvRows.length === 0) return [];
  const header = csvRows[0].map((h, idx) => {
    if (idx === 0 && typeof h === "string") {
      return h.replace(/^\uFEFF/, "");
    }
    return h;
  });
  const missingColumns = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missingColumns.length > 0) {
    throw new Error(`CSV missing required columns: ${missingColumns.join(", ")}`);
  }

  const rows = [];
  for (let i = 1; i < csvRows.length; i += 1) {
    const raw = csvRows[i];
    if (raw.length === 1 && raw[0] === "") continue;
    const obj = {};
    for (let colIdx = 0; colIdx < header.length; colIdx += 1) {
      obj[header[colIdx]] = raw[colIdx] ?? "";
    }
    rows.push(obj);
  }
  return rows;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function insertImportBoxesRaw(client, rows) {
  const quotedColumns = REQUIRED_COLUMNS.map((c) => `"${c}"`).join(", ");
  const chunked = chunk(rows, 200);
  let inserted = 0;

  for (const part of chunked) {
    const values = [];
    const placeholders = [];
    let paramIndex = 1;

    for (const row of part) {
      const rowPlaceholders = [];
      for (const col of REQUIRED_COLUMNS) {
        rowPlaceholders.push(`$${paramIndex}`);
        values.push(row[col] ?? "");
        paramIndex += 1;
      }
      placeholders.push(`(${rowPlaceholders.join(", ")})`);
    }

    const sql = `insert into import.boxes_raw (${quotedColumns}) values ${placeholders.join(", ")}`;
    await client.query(sql, values);
    inserted += part.length;
  }

  return inserted;
}

async function main() {
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing env file: ${envPath}`);
  }
  for (const migrationPath of migrationPaths) {
    if (!fs.existsSync(migrationPath)) {
      throw new Error(`Missing migration file: ${migrationPath}`);
    }
  }
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Missing CSV file: ${csvPath}`);
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

  const migrationSql = migrationPaths
    .map((migrationPath) => fs.readFileSync(migrationPath, "utf8"))
    .join("\n\n");
  const csvText = fs.readFileSync(csvPath, "utf8");
  const csvRows = parseCsv(csvText);
  const rows = toObjects(csvRows);

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    const beforeRes = await client.query(
      "select count(*)::int as c from app.boxes where org_id = $1::uuid",
      [orgId],
    );
    const beforeCount = beforeRes.rows[0]?.c ?? 0;

    await client.query("begin");
    await client.query(migrationSql);
    await client.query("select import.clear_staging()");
    const stagedRows = await insertImportBoxesRaw(client, rows);

    const mergeRes = await client.query(
      "select import.merge_boxes_from_staging($1::uuid, true, 'keep_existing') as result",
      [orgId],
    );
    await client.query("commit");

    const afterRes = await client.query(
      "select count(*)::int as c from app.boxes where org_id = $1::uuid",
      [orgId],
    );
    const afterCount = afterRes.rows[0]?.c ?? 0;

    const output = {
      org_id: orgId,
      csv_path: path.relative(repoRoot, csvPath).replace(/\\/g, "/"),
      csv_rows: rows.length,
      staged_rows: stagedRows,
      boxes_before: beforeCount,
      boxes_after: afterCount,
      merge_result: mergeRes.rows[0]?.result ?? null,
    };
    console.log(JSON.stringify(output, null, 2));
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
