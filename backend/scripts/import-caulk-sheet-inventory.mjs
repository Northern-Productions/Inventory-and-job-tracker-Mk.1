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
  "manufacturer",
  "product_name",
  "tubes_per_case",
  "quantity_tubes",
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
  if (!fs.existsSync(filePath)) {
    return {};
  }

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

function toCsvObjects(csvRows) {
  if (csvRows.length === 0) {
    return { header: [], rows: [] };
  }

  const header = csvRows[0].map((value, index) => {
    if (index === 0) {
      return String(value ?? "").replace(/^\uFEFF/, "");
    }
    return String(value ?? "");
  });

  const rows = [];
  for (let i = 1; i < csvRows.length; i += 1) {
    const raw = csvRows[i];
    if (raw.length === 1 && raw[0] === "") continue;
    const next = {};
    for (let col = 0; col < header.length; col += 1) {
      next[header[col]] = raw[col] ?? "";
    }
    rows.push(next);
  }

  return { header, rows };
}

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function resolveRepoPath(rawValue) {
  const value = asTrimmedString(rawValue);
  if (!value) return "";
  if (path.isAbsolute(value)) return value;
  return path.resolve(repoRoot, value);
}

function deriveWarehouseCodeFromSourceBoxId(sourceBoxId) {
  const match = asTrimmedString(sourceBoxId).toUpperCase().match(/^(?<code>[A-Z]{2}[1-9][0-9]*)-/);
  if (!match?.groups?.code) return "";
  return match.groups.code;
}

function parseStrictPositiveInteger(value, fieldName, rowLabel, errors) {
  const text = asTrimmedString(value);
  if (!text) {
    errors.push(`${rowLabel}: missing ${fieldName}`);
    return null;
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    errors.push(`${rowLabel}: ${fieldName} must be an integer (received "${text}")`);
    return null;
  }

  if (parsed <= 0) {
    errors.push(`${rowLabel}: ${fieldName} must be > 0 (received "${text}")`);
    return null;
  }

  return parsed;
}

function validateCsvShape(header) {
  const headerSet = new Set(header);
  const shapeErrors = [];

  for (const column of REQUIRED_COLUMNS) {
    if (!headerSet.has(column)) {
      shapeErrors.push(`CSV missing required column: ${column}`);
    }
  }

  if (!headerSet.has("source_box_id") && !headerSet.has("box_id_candidate")) {
    shapeErrors.push("CSV must include source_box_id (or legacy fallback box_id_candidate).");
  }

  if (!headerSet.has("warehouse_code") && !headerSet.has("warehouse")) {
    shapeErrors.push("CSV must include warehouse_code (or legacy fallback warehouse).");
  }

  return shapeErrors;
}

function validateRows(rawRows) {
  const rowErrors = [];
  const normalizedRows = [];
  const seenSourceIds = new Map();

  for (let index = 0; index < rawRows.length; index += 1) {
    const raw = rawRows[index];
    const csvRowNumber = index + 2;
    const rowLabel = `row ${csvRowNumber}`;

    const sourceBoxId = asTrimmedString(raw.source_box_id || raw.box_id_candidate).toUpperCase();
    if (!sourceBoxId) {
      rowErrors.push(`${rowLabel}: source_box_id is required`);
      continue;
    }
    if (!/^[A-Z]{2}[1-9][0-9]*-[A-Z0-9]+$/.test(sourceBoxId)) {
      rowErrors.push(`${rowLabel}: source_box_id must be canonical (received "${sourceBoxId}")`);
      continue;
    }
    if (seenSourceIds.has(sourceBoxId)) {
      rowErrors.push(`${rowLabel}: duplicate source_box_id "${sourceBoxId}" (first seen on row ${seenSourceIds.get(sourceBoxId)})`);
      continue;
    }
    seenSourceIds.set(sourceBoxId, csvRowNumber);

    const manufacturer = asTrimmedString(raw.manufacturer);
    if (!manufacturer) {
      rowErrors.push(`${rowLabel}: manufacturer is required`);
      continue;
    }

    const productName = asTrimmedString(raw.product_name);
    if (!productName) {
      rowErrors.push(`${rowLabel}: product_name is required`);
      continue;
    }

    const tubesPerCase = parseStrictPositiveInteger(raw.tubes_per_case, "tubes_per_case", rowLabel, rowErrors);
    const quantityTubes = parseStrictPositiveInteger(raw.quantity_tubes, "quantity_tubes", rowLabel, rowErrors);
    if (tubesPerCase === null || quantityTubes === null) {
      continue;
    }

    const warehouseFromRow = asTrimmedString(raw.warehouse_code || raw.warehouse).toUpperCase();
    const warehouseFromId = deriveWarehouseCodeFromSourceBoxId(sourceBoxId);
    const warehouseCode = warehouseFromRow || warehouseFromId;
    if (!warehouseCode) {
      rowErrors.push(`${rowLabel}: unable to resolve warehouse_code`);
      continue;
    }

    if (warehouseFromRow && warehouseFromId && warehouseFromRow !== warehouseFromId) {
      rowErrors.push(`${rowLabel}: warehouse_code "${warehouseFromRow}" mismatches source_box_id prefix "${warehouseFromId}"`);
      continue;
    }

    normalizedRows.push({
      csvRowNumber,
      sourceBoxId,
      warehouseCode,
      manufacturer,
      productName,
      productCode: asTrimmedString(raw.product_code),
      tubesPerCase,
      quantityTubes,
      inventoryDate: asTrimmedString(raw.inventory_date),
      sourceSheet: asTrimmedString(raw.source_sheet),
      rawDescription: asTrimmedString(raw.raw_description),
    });
  }

  return { normalizedRows, rowErrors };
}

async function fetchMappedSourceBoxIds(client, orgId, sourceBoxIds) {
  if (sourceBoxIds.length === 0) return new Set();
  const result = await client.query(
    `
      select source_box_id
      from app.caulk_backfill_map
      where org_id = $1::uuid
        and source_box_id = any($2::text[])
    `,
    [orgId, sourceBoxIds],
  );

  const mapped = new Set();
  for (const row of result.rows || []) {
    const sourceBoxId = asTrimmedString(row.source_box_id).toUpperCase();
    if (sourceBoxId) mapped.add(sourceBoxId);
  }
  return mapped;
}

async function fetchExistingWarehouseCodes(client, orgId, warehouseCodes) {
  if (warehouseCodes.length === 0) return new Set();
  const result = await client.query(
    `
      select code
      from app.warehouses
      where org_id = $1::uuid
        and code = any($2::text[])
    `,
    [orgId, warehouseCodes],
  );

  const existing = new Set();
  for (const row of result.rows || []) {
    const code = asTrimmedString(row.code).toUpperCase();
    if (code) existing.add(code);
  }
  return existing;
}

function summarizeByWarehouse(rows) {
  const byWarehouse = {};
  for (const row of rows) {
    if (!byWarehouse[row.warehouseCode]) {
      byWarehouse[row.warehouseCode] = {
        rows: 0,
        tubes: 0,
      };
    }
    byWarehouse[row.warehouseCode].rows += 1;
    byWarehouse[row.warehouseCode].tubes += row.quantityTubes;
  }
  return byWarehouse;
}

async function applyRows(client, { orgId, actor, rows, initiallyMapped }) {
  const mappedSet = new Set(initiallyMapped);
  const skippedAlreadyMapped = [];
  const appliedRows = [];

  await client.query("begin");
  try {
    for (const row of rows) {
      if (mappedSet.has(row.sourceBoxId)) {
        skippedAlreadyMapped.push(row.sourceBoxId);
        continue;
      }

      const manufacturerRes = await client.query(
        `
          select (app_api.caulk_upsert_manufacturer($1::uuid, $2::text, $3::text, true)).id as manufacturer_id
        `,
        [orgId, actor, row.manufacturer],
      );
      const manufacturerId = asTrimmedString(manufacturerRes.rows[0]?.manufacturer_id);
      if (!manufacturerId) {
        throw new Error(`Unable to upsert manufacturer for ${row.sourceBoxId}.`);
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
        [
          orgId,
          actor,
          manufacturerId,
          row.productName,
          row.productCode,
          row.tubesPerCase,
          "Imported from legacy Caulk sheet",
        ],
      );
      const productId = asTrimmedString(productRes.rows[0]?.product_id);
      if (!productId) {
        throw new Error(`Unable to upsert product for ${row.sourceBoxId}.`);
      }

      const deltaRes = await client.query(
        `
          select app_api.caulk_apply_stock_delta(
            $1::uuid,
            $2::text,
            $3::uuid,
            $4::text,
            'BACKFILL_MIGRATE',
            $5::integer,
            'CAULK_SHEET_IMPORT',
            '',
            $6::text,
            $7::text
          ) as result
        `,
        [
          orgId,
          actor,
          productId,
          row.warehouseCode,
          row.quantityTubes,
          row.sourceBoxId,
          `Imported from caulk_raw_final.csv (source_sheet=${row.sourceSheet || "unknown"}, row=${row.csvRowNumber})`,
        ],
      );

      const transactionId = asTrimmedString(deltaRes.rows[0]?.result?.transactionId);
      if (!transactionId) {
        throw new Error(`Unable to capture transaction id for ${row.sourceBoxId}.`);
      }

      const mapInsertRes = await client.query(
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
          returning source_box_id
        `,
        [
          orgId,
          row.sourceBoxId,
          productId,
          row.warehouseCode,
          transactionId,
          actor,
          "Imported from caulk_raw_final.csv",
        ],
      );

      if ((mapInsertRes.rowCount ?? 0) !== 1) {
        throw new Error(`Backfill map conflict for ${row.sourceBoxId}; rolling back to prevent double-counting.`);
      }

      mappedSet.add(row.sourceBoxId);
      appliedRows.push({
        sourceBoxId: row.sourceBoxId,
        warehouseCode: row.warehouseCode,
        manufacturer: row.manufacturer,
        productName: row.productName,
        quantityTubes: row.quantityTubes,
        transactionId,
      });
    }

    await client.query("commit");
    return { appliedRows, skippedAlreadyMapped };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch (_rollbackError) {
      // ignore rollback failure
    }
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = asTrimmedString(args.mode || "dry-run").toLowerCase();
  if (mode !== "dry-run" && mode !== "apply") {
    throw new Error("Unsupported mode. Use --mode dry-run or --mode apply.");
  }

  const profile = asTrimmedString(args.profile || "IL").toUpperCase();
  if (profile !== "IL" && profile !== "MS") {
    throw new Error("Unsupported profile. Use --profile IL or --profile MS.");
  }

  const actor = asTrimmedString(args.actor);
  if (!actor) {
    throw new Error("--actor is required.");
  }

  const defaultRunDir = profile === "MS"
    ? path.join(backendDir, "migration-dry-runs", "ms-inventory")
    : path.join(backendDir, "migration-dry-runs", "il-assigned");
  const runDir = args["run-dir"] ? resolveRepoPath(args["run-dir"]) : defaultRunDir;
  const caulkCsvPath = args["caulk-csv"]
    ? resolveRepoPath(args["caulk-csv"])
    : path.join(runDir, "caulk_raw_final.csv");
  const reportPath = args.report
    ? resolveRepoPath(args.report)
    : path.join(path.dirname(caulkCsvPath), "caulk_sheet_import_report.json");

  if (!fs.existsSync(caulkCsvPath)) {
    throw new Error(`Missing caulk CSV file: ${caulkCsvPath}`);
  }

  const env = parseEnv(envPath);
  const databaseUrl = asTrimmedString(args["database-url"] || env.DATABASE_URL);
  const orgId = asTrimmedString(args["org-id"] || env.DEFAULT_ORG_ID);
  const canConnectDb = Boolean(databaseUrl && orgId);

  if (mode === "apply" && !canConnectDb) {
    throw new Error("Apply mode requires DATABASE_URL and DEFAULT_ORG_ID (or pass --database-url and --org-id).");
  }

  const csvText = fs.readFileSync(caulkCsvPath, "utf8");
  const { header, rows: rawRows } = toCsvObjects(parseCsv(csvText));
  const shapeErrors = validateCsvShape(header);
  const { normalizedRows, rowErrors } = validateRows(rawRows);

  let client = null;
  let mappedSet = new Set();
  const databaseErrors = [];
  let dbChecksSkipped = false;

  try {
    if (canConnectDb) {
      client = new Client({
        connectionString: databaseUrl,
        ssl: { rejectUnauthorized: false },
      });
      await client.connect();

      mappedSet = await fetchMappedSourceBoxIds(
        client,
        orgId,
        normalizedRows.map((row) => row.sourceBoxId),
      );

      const requiredWarehouses = [...new Set(normalizedRows.map((row) => row.warehouseCode))];
      const existingWarehouses = await fetchExistingWarehouseCodes(client, orgId, requiredWarehouses);
      for (const row of normalizedRows) {
        if (!existingWarehouses.has(row.warehouseCode)) {
          databaseErrors.push(`row ${row.csvRowNumber}: warehouse "${row.warehouseCode}" was not found for org ${orgId}`);
        }
      }
    } else {
      dbChecksSkipped = true;
    }

    const errorRows = new Set();
    for (const error of [...rowErrors, ...databaseErrors]) {
      const match = error.match(/^row\s+(\d+):/i);
      if (match) {
        errorRows.add(Number(match[1]));
      }
    }

    const validRows = normalizedRows.filter((row) => !errorRows.has(row.csvRowNumber));
    const mappedRows = validRows.filter((row) => mappedSet.has(row.sourceBoxId));
    const rowsToImport = validRows.filter((row) => !mappedSet.has(row.sourceBoxId));

    const report = {
      generatedAtUtc: new Date().toISOString(),
      mode,
      profile,
      actor,
      orgId: orgId || null,
      caulkCsvPath,
      totals: {
        csvRows: rawRows.length,
        shapeErrors: shapeErrors.length,
        rowValidationErrors: rowErrors.length,
        databaseValidationErrors: databaseErrors.length,
        validRows: validRows.length,
        alreadyMappedRows: mappedRows.length,
        wouldImportRows: rowsToImport.length,
        wouldImportTubes: rowsToImport.reduce((sum, row) => sum + row.quantityTubes, 0),
      },
      byWarehouse: summarizeByWarehouse(rowsToImport),
      flags: {
        databaseChecksSkipped: dbChecksSkipped,
      },
      errors: {
        shape: shapeErrors,
        rows: rowErrors,
        database: databaseErrors,
      },
      artifacts: {
        reportJson: reportPath,
      },
    };

    if (mode === "dry-run") {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

      console.log(`Mode: ${mode}`);
      console.log(`Profile: ${profile}`);
      console.log(`CSV rows: ${rawRows.length}`);
      console.log(`Valid rows: ${validRows.length}`);
      console.log(`Already mapped (skip): ${mappedRows.length}`);
      console.log(`Would import: ${rowsToImport.length}`);
      console.log(`Would import tubes: ${report.totals.wouldImportTubes}`);
      if (shapeErrors.length > 0 || rowErrors.length > 0 || databaseErrors.length > 0) {
        console.log("Validation errors detected. See report JSON for full details.");
      }
      console.log(`Report: ${reportPath}`);
      return;
    }

    if (shapeErrors.length > 0 || rowErrors.length > 0 || databaseErrors.length > 0) {
      throw new Error("Apply aborted because validation errors were found. Run --mode dry-run and fix report errors first.");
    }

    const { appliedRows, skippedAlreadyMapped } = await applyRows(client, {
      orgId,
      actor,
      rows: validRows,
      initiallyMapped: mappedSet,
    });

    report.apply = {
      appliedRows: appliedRows.length,
      appliedTubes: appliedRows.reduce((sum, row) => sum + row.quantityTubes, 0),
      skippedAlreadyMapped: skippedAlreadyMapped.length,
      skippedSourceBoxIds: skippedAlreadyMapped,
      appliedPreview: appliedRows.slice(0, 25),
    };

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    console.log(`Mode: ${mode}`);
    console.log(`Applied rows: ${report.apply.appliedRows}`);
    console.log(`Applied tubes: ${report.apply.appliedTubes}`);
    console.log(`Skipped already mapped: ${report.apply.skippedAlreadyMapped}`);
    console.log(`Report: ${reportPath}`);
  } finally {
    if (client) {
      await client.end();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
