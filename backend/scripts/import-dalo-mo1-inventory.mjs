import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  BOX_IMPORT_HEADERS,
  DALO_MANUAL_MAPPING_FILE,
  DALO_WAREHOUSE_CODE,
  REVIEW_HEADERS,
  buildApplyRows,
  buildCandidateRows,
  buildCatalogCandidates,
  buildManualMappingIndex,
  buildReconciliationReport,
  buildReviewRows,
  buildRunManifest,
  defaultRunDir,
  evaluateApplyGuardrails,
  fileSha256Hex,
  findMatchingApplyManifests,
  loadManualMappings,
  parseArgs,
  parseDaloSourceCsv,
  parseEnvText,
  promoteManualMappings,
  readCsvObjects,
  readJsonFileIfExists,
  renderReconciliationMarkdown,
  saveManualMappings,
  summarizeDryRun,
  validateOrgId,
  validateSnapshotDate,
  writeCsvFile,
  writeJsonFile,
} from "./lib/dalo-mo1-import.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(backendDir, "..");
const envPath = path.join(backendDir, ".env");
const manualMappingPath = path.join(repoRoot, DALO_MANUAL_MAPPING_FILE);
const migrationPaths = [
  path.join(backendDir, "migrations", "0019_import_boxes_merge_mode.sql"),
  path.join(backendDir, "migrations", "0020_warehouse_prefix_v2.sql"),
  path.join(backendDir, "migrations", "0031_price_per_lf_asset_total_cost.sql"),
  path.join(backendDir, "migrations", "0032_purchase_cost_derives_price_per_lf.sql"),
];
const CANDIDATE_HEADERS = [
  ...BOX_IMPORT_HEADERS,
  "Decision",
  "ProposedManufacturer",
  "ProposedFilmName",
  "MappingProvenance",
  "MappingConfidence",
];
const EXCEPTION_HEADERS = [
  "source_row",
  "reason",
  "source_film_name",
  "source_width_raw",
  "source_weight_raw",
  "source_sq_ft_raw",
];

function trimText(value) {
  return String(value ?? "").trim();
}

function normalizeSpacing(value) {
  return trimText(value).replace(/\s+/g, " ");
}

function resolveCliPath(value, fallback = "") {
  const raw = trimText(value || fallback);
  if (!raw) {
    return "";
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(process.cwd(), raw);
}

function toRepoRelative(filePath) {
  const relative = path.relative(repoRoot, filePath);
  return relative.startsWith("..") ? filePath : relative.replace(/\\/g, "/");
}

function requireActor(value) {
  const actor = normalizeSpacing(value);
  if (!actor) {
    throw new Error("Missing required --actor <name>.");
  }
  return actor;
}

function requireMode(value) {
  const mode = trimText(value).toLowerCase();
  if (!mode || !["dry-run", "apply", "promote-mappings"].includes(mode)) {
    throw new Error("Missing or invalid --mode. Expected dry-run, apply, or promote-mappings.");
  }
  return mode;
}

function requireSourcePath(value) {
  const sourcePath = resolveCliPath(value);
  if (!sourcePath) {
    throw new Error("Missing required --source <path>.");
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source file not found: ${sourcePath}`);
  }
  return sourcePath;
}

function loadDatabaseUrl() {
  const envFromFile = fs.existsSync(envPath) ? parseEnvText(fs.readFileSync(envPath, "utf8")) : {};
  const env = { ...envFromFile, ...process.env };
  const databaseUrl = trimText(env.DATABASE_URL);
  if (!databaseUrl) {
    throw new Error(`DATABASE_URL is missing. Expected it in ${envPath} or the environment.`);
  }
  return databaseUrl;
}

function createPgClient(databaseUrl) {
  return new Client({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
  });
}

function parseMergeResult(value) {
  if (!value) {
    return {};
  }
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

function buildDryRunPaths(runDir) {
  return {
    mappingReview: path.join(runDir, "mapping_review.csv"),
    boxesRawCandidates: path.join(runDir, "boxes_raw_candidates.csv"),
    exceptions: path.join(runDir, "exceptions.csv"),
    summary: path.join(runDir, "summary.json"),
    manifest: path.join(runDir, "run_manifest.json"),
  };
}

function buildApplyPaths(runDir) {
  return {
    reconciliationJson: path.join(runDir, "reconciliation_report.json"),
    reconciliationMd: path.join(runDir, "reconciliation_report.md"),
    applyManifest: path.join(runDir, "apply_manifest.json"),
    boxesRawFinal: path.join(runDir, "boxes_raw_final.csv"),
  };
}

async function ensureOrgExists(client, orgId) {
  const result = await client.query(
    `
      select 1
      from app.organizations
      where id = $1::uuid
      limit 1
    `,
    [orgId]
  );
  return result.rowCount > 0;
}

async function fetchWarehouseRow(client, orgId) {
  const result = await client.query(
    `
      select code, name, box_id_prefix
      from app.warehouses
      where org_id = $1::uuid
        and code = $2
      limit 1
    `,
    [orgId, DALO_WAREHOUSE_CODE]
  );
  return result.rows[0] || null;
}

async function fetchCatalogRows(client, orgId) {
  const result = await client.query(
    `
      select manufacturer, film_name, source_width_in
      from app.film_catalog
      where org_id = $1::uuid
      order by manufacturer, film_name
    `,
    [orgId]
  );
  return result.rows;
}

async function fetchBoxRows(client, orgId) {
  const result = await client.query(
    `
      select distinct manufacturer, film_name, width_in
      from app.boxes
      where org_id = $1::uuid
      order by manufacturer, film_name, width_in
    `,
    [orgId]
  );
  return result.rows;
}

async function resolveWarehousesForBoxIds(client, orgId, boxIds) {
  if (boxIds.length === 0) {
    return [];
  }
  const result = await client.query(
    `
      select q.box_id, app_api.resolve_warehouse_from_box_id($1::uuid, q.box_id) as warehouse
      from unnest($2::text[]) as q(box_id)
      order by q.box_id
    `,
    [orgId, boxIds]
  );
  return result.rows;
}

async function listExistingBoxConflicts(client, orgId, warehouseCode, boxIds) {
  if (boxIds.length === 0) {
    return [];
  }
  const result = await client.query(
    `
      select box_id, warehouse
      from app.boxes
      where org_id = $1::uuid
        and warehouse = $2
        and box_id = any($3::text[])
      order by box_id
    `,
    [orgId, warehouseCode, boxIds]
  );
  return result.rows.map((row) => ({
    box_id: trimText(row.box_id),
    warehouse: trimText(row.warehouse),
  }));
}

async function fetchExpectedDbRows(client, orgId, boxIds) {
  if (boxIds.length === 0) {
    return [];
  }
  const result = await client.query(
    `
      select box_id, warehouse, manufacturer, film_name, width_in, status
      from app.boxes
      where org_id = $1::uuid
        and box_id = any($2::text[])
      order by box_id
    `,
    [orgId, boxIds]
  );
  return result.rows;
}

async function applyRequiredMigrations(client) {
  const migrationSql = migrationPaths
    .map((migrationPath) => {
      if (!fs.existsSync(migrationPath)) {
        throw new Error(`Required migration file is missing: ${migrationPath}`);
      }
      return fs.readFileSync(migrationPath, "utf8").replace(/^\uFEFF/, "");
    })
    .join("\n\n");

  await client.query(migrationSql);
}

async function insertImportBoxesRaw(client, rows) {
  if (rows.length === 0) {
    return 0;
  }

  const quotedColumns = BOX_IMPORT_HEADERS.map((header) => `"${header}"`).join(", ");
  let inserted = 0;

  for (let start = 0; start < rows.length; start += 200) {
    const chunk = rows.slice(start, start + 200);
    const values = [];
    const placeholders = [];
    let parameterIndex = 1;

    for (const row of chunk) {
      const rowPlaceholders = [];
      for (const header of BOX_IMPORT_HEADERS) {
        rowPlaceholders.push(`$${parameterIndex}`);
        values.push(trimText(row[header]));
        parameterIndex += 1;
      }
      placeholders.push(`(${rowPlaceholders.join(", ")})`);
    }

    await client.query(
      `insert into import.boxes_raw (${quotedColumns}) values ${placeholders.join(", ")}`,
      values
    );
    inserted += chunk.length;
  }

  return inserted;
}

function requireRunManifest(manifestPath) {
  const manifest = readJsonFileIfExists(manifestPath);
  if (!manifest) {
    throw new Error(`Run manifest not found: ${manifestPath}. Run dry-run first.`);
  }
  return manifest;
}

function requireReviewRows(reviewFilePath) {
  if (!fs.existsSync(reviewFilePath)) {
    throw new Error(`Review file not found: ${reviewFilePath}. Run dry-run first.`);
  }
  return readCsvObjects(reviewFilePath);
}

function validateDryRunOrApplyCli(options) {
  validateSnapshotDate(options["snapshot-date"]);
  validateOrgId(options["org-id"]);
  requireActor(options.actor);
  requireSourcePath(options.source);
}

function validateManifestAgainstCli(manifest, sourcePath, sourceHash, snapshotDate, orgId) {
  if (trimText(manifest.source_path) !== sourcePath) {
    throw new Error(
      `Manifest source path mismatch. Expected ${manifest.source_path}, received ${sourcePath}.`
    );
  }
  if (trimText(manifest.source_sha256) !== sourceHash) {
    throw new Error("Source file hash does not match the reviewed run manifest. Re-run dry-run before apply.");
  }
  if (trimText(manifest.snapshot_date) !== snapshotDate) {
    throw new Error(
      `Manifest snapshot date mismatch. Expected ${manifest.snapshot_date}, received ${snapshotDate}.`
    );
  }
  if (trimText(manifest.org_id) !== orgId) {
    throw new Error(`Manifest org mismatch. Expected ${manifest.org_id}, received ${orgId}.`);
  }
  if (trimText(manifest.warehouse_code) !== DALO_WAREHOUSE_CODE) {
    throw new Error(
      `Manifest warehouse mismatch. Expected ${manifest.warehouse_code}, received ${DALO_WAREHOUSE_CODE}.`
    );
  }
}

async function runDryRun(client, options) {
  const snapshotDate = validateSnapshotDate(options["snapshot-date"]);
  const orgId = validateOrgId(options["org-id"]);
  const actor = requireActor(options.actor);
  const sourcePath = requireSourcePath(options.source);
  const runDir = resolveCliPath(options["run-dir"], defaultRunDir(backendDir, snapshotDate, orgId));
  const artifactPaths = buildDryRunPaths(runDir);

  if (!(await ensureOrgExists(client, orgId))) {
    throw new Error(`Target org does not exist: ${orgId}`);
  }

  const sourceText = fs.readFileSync(sourcePath, "utf8");
  const parsedSource = parseDaloSourceCsv(sourceText);
  const sourceHash = fileSha256Hex(sourcePath);
  const manualMappings = loadManualMappings(manualMappingPath);
  const catalogRows = await fetchCatalogRows(client, orgId);
  const boxRows = await fetchBoxRows(client, orgId);
  const catalogCandidates = buildCatalogCandidates({ catalogRows, boxRows });
  const reviewRows = buildReviewRows(
    parsedSource.consideredRows,
    buildManualMappingIndex(manualMappings),
    catalogCandidates
  );
  const candidateRows = buildCandidateRows(parsedSource.consideredRows, reviewRows, snapshotDate, actor);
  const warehouseRow = await fetchWarehouseRow(client, orgId);
  const warnings = [];

  if (!warehouseRow) {
    warnings.push(
      `Warehouse ${DALO_WAREHOUSE_CODE} is not configured for org ${orgId} yet. Dry-run artifacts were generated, but apply will fail until the warehouse exists.`
    );
  } else if (trimText(warehouseRow.box_id_prefix) !== DALO_WAREHOUSE_CODE) {
    warnings.push(
      `Warehouse ${DALO_WAREHOUSE_CODE} exists but has prefix ${warehouseRow.box_id_prefix || "(blank)"}. Apply will fail until the prefix matches ${DALO_WAREHOUSE_CODE}.`
    );
  } else {
    const resolutionRows = await resolveWarehousesForBoxIds(
      client,
      orgId,
      parsedSource.consideredRows.map((row) => row.boxId)
    );
    const resolutionMismatches = resolutionRows.filter((row) => trimText(row.warehouse) !== DALO_WAREHOUSE_CODE);
    if (resolutionMismatches.length > 0) {
      warnings.push(
        `${resolutionMismatches.length} generated MO1 box IDs do not currently resolve to ${DALO_WAREHOUSE_CODE}.`
      );
    }
  }

  writeCsvFile(artifactPaths.mappingReview, REVIEW_HEADERS, reviewRows);
  writeCsvFile(artifactPaths.boxesRawCandidates, CANDIDATE_HEADERS, candidateRows);
  writeCsvFile(
    artifactPaths.exceptions,
    EXCEPTION_HEADERS,
    [...parsedSource.ignoredRows, ...parsedSource.exceptions]
  );

  const summary = summarizeDryRun({ parsedSource, reviewRows, warnings });
  writeJsonFile(artifactPaths.summary, summary);

  const manifest = buildRunManifest({
    sourcePath,
    sourceHash,
    snapshotDate,
    orgId,
    warehouseCode: DALO_WAREHOUSE_CODE,
    totalReviewedRows: reviewRows.length,
    artifactPaths: {
      mapping_review: toRepoRelative(artifactPaths.mappingReview),
      boxes_raw_candidates: toRepoRelative(artifactPaths.boxesRawCandidates),
      exceptions: toRepoRelative(artifactPaths.exceptions),
      summary: toRepoRelative(artifactPaths.summary),
    },
  });
  writeJsonFile(artifactPaths.manifest, manifest);

  console.log(
    JSON.stringify(
      {
        mode: "dry-run",
        org_id: orgId,
        warehouse_code: DALO_WAREHOUSE_CODE,
        source_path: sourcePath,
        run_dir: toRepoRelative(runDir),
        manifest_path: toRepoRelative(artifactPaths.manifest),
        summary,
      },
      null,
      2
    )
  );
}

async function runApply(client, options) {
  const snapshotDate = validateSnapshotDate(options["snapshot-date"]);
  const orgId = validateOrgId(options["org-id"]);
  const actor = requireActor(options.actor);
  const sourcePath = requireSourcePath(options.source);
  const runDir = resolveCliPath(options["run-dir"], defaultRunDir(backendDir, snapshotDate, orgId));
  const reviewFilePath = resolveCliPath(options["review-file"], path.join(runDir, "mapping_review.csv"));
  const artifactPaths = {
    ...buildDryRunPaths(runDir),
    ...buildApplyPaths(runDir),
  };
  const sourceHash = fileSha256Hex(sourcePath);
  const manifest = requireRunManifest(artifactPaths.manifest);
  validateManifestAgainstCli(manifest, sourcePath, sourceHash, snapshotDate, orgId);

  const orgExists = await ensureOrgExists(client, orgId);
  const warehouseRow = orgExists ? await fetchWarehouseRow(client, orgId) : null;
  const sourceText = fs.readFileSync(sourcePath, "utf8");
  const parsedSource = parseDaloSourceCsv(sourceText);
  const reviewRows = requireReviewRows(reviewFilePath);
  const { importRows, skippedRows, unresolvedRows } = buildApplyRows(
    parsedSource.consideredRows,
    reviewRows,
    snapshotDate,
    actor
  );
  const resolutionRows =
    orgExists && warehouseRow
      ? await resolveWarehousesForBoxIds(client, orgId, importRows.map((row) => row.BoxID))
      : [];
  const resolutionMismatches = resolutionRows.filter((row) => trimText(row.warehouse) !== DALO_WAREHOUSE_CODE);
  const duplicateExistingBoxIds =
    orgExists && warehouseRow
      ? await listExistingBoxConflicts(
          client,
          orgId,
          DALO_WAREHOUSE_CODE,
          importRows.map((row) => row.BoxID)
        )
      : [];
  const priorApplyManifestMatches = findMatchingApplyManifests(
    path.join(backendDir, "migration-dry-runs", "dalo-mo1"),
    {
      source_sha256: manifest.source_sha256,
      snapshot_date: manifest.snapshot_date,
      org_id: manifest.org_id,
      warehouse_code: manifest.warehouse_code,
    },
    runDir
  );
  const blockers = evaluateApplyGuardrails({
    unresolvedRows,
    orgExists,
    warehouseExists: Boolean(warehouseRow),
    warehousePrefix: warehouseRow?.box_id_prefix,
    warehouseResolutionMismatches: resolutionMismatches,
    duplicateExistingBoxIds,
    priorApplyManifestMatches,
    force: Boolean(options.force),
  });

  if (blockers.length > 0) {
    throw new Error(blockers.join("\n"));
  }

  const mergeResult = await (async () => {
    await client.query("begin");
    try {
      await applyRequiredMigrations(client);
      await client.query("select import.clear_staging()");
      await insertImportBoxesRaw(client, importRows);
      const mergeResponse = await client.query(
        "select import.merge_boxes_from_staging($1::uuid, true, 'keep_existing') as result",
        [orgId]
      );
      await client.query("commit");
      return parseMergeResult(mergeResponse.rows[0]?.result);
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // noop
      }
      throw error;
    }
  })();

  writeCsvFile(artifactPaths.boxesRawFinal, BOX_IMPORT_HEADERS, importRows);

  const dbRows = await fetchExpectedDbRows(
    client,
    orgId,
    importRows.map((row) => row.BoxID)
  );
  const reconciliation = buildReconciliationReport({
    sourceRows: parsedSource.consideredRows,
    skippedRows,
    importRows,
    dbRows,
    mergeResult,
    duplicateExistingBoxIds,
    priorApplyManifestMatches,
  });

  writeJsonFile(artifactPaths.reconciliationJson, reconciliation);
  fs.mkdirSync(path.dirname(artifactPaths.reconciliationMd), { recursive: true });
  fs.writeFileSync(artifactPaths.reconciliationMd, renderReconciliationMarkdown(reconciliation), "utf8");

  const applyManifest = {
    generated_at_utc: new Date().toISOString(),
    source_path: sourcePath,
    source_sha256: sourceHash,
    snapshot_date: snapshotDate,
    org_id: orgId,
    warehouse_code: DALO_WAREHOUSE_CODE,
    total_reviewed_rows: reviewRows.length,
    total_import_rows: importRows.length,
    total_skipped_rows: skippedRows.length,
    force: Boolean(options.force),
    review_file: reviewFilePath,
    merge_result: mergeResult,
    duplicate_existing_box_ids: duplicateExistingBoxIds,
    prior_apply_manifest_matches: priorApplyManifestMatches.map((entry) => entry.manifestPath),
    reconciliation_report_json: toRepoRelative(artifactPaths.reconciliationJson),
    reconciliation_report_md: toRepoRelative(artifactPaths.reconciliationMd),
  };
  writeJsonFile(artifactPaths.applyManifest, applyManifest);

  console.log(
    JSON.stringify(
      {
        mode: "apply",
        org_id: orgId,
        warehouse_code: DALO_WAREHOUSE_CODE,
        run_dir: toRepoRelative(runDir),
        merge_result: mergeResult,
        reconciliation,
        apply_manifest: toRepoRelative(artifactPaths.applyManifest),
      },
      null,
      2
    )
  );
}

async function runPromoteMappings(options) {
  const actor = requireActor(options.actor);
  const runDir = options["run-dir"] ? resolveCliPath(options["run-dir"]) : "";
  const reviewFilePath = resolveCliPath(options["review-file"], runDir ? path.join(runDir, "mapping_review.csv") : "");
  if (!reviewFilePath) {
    throw new Error("Promote-mappings requires --review-file <path> or --run-dir <path>.");
  }
  if (!fs.existsSync(reviewFilePath)) {
    throw new Error(`Review file not found: ${reviewFilePath}`);
  }

  const existingMappings = loadManualMappings(manualMappingPath);
  const reviewRows = readCsvObjects(reviewFilePath);
  const promotedAtIso = new Date().toISOString();
  const { rows, promotedCount } = promoteManualMappings(existingMappings, reviewRows, actor, promotedAtIso);
  saveManualMappings(manualMappingPath, rows);

  console.log(
    JSON.stringify(
      {
        mode: "promote-mappings",
        promoted_count: promotedCount,
        manual_mapping_file: toRepoRelative(manualMappingPath),
        review_file: reviewFilePath,
      },
      null,
      2
    )
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const mode = requireMode(options.mode);

  if (mode === "promote-mappings") {
    await runPromoteMappings(options);
    return;
  }

  validateDryRunOrApplyCli(options);

  const databaseUrl = loadDatabaseUrl();
  const client = createPgClient(databaseUrl);
  await client.connect();

  try {
    if (mode === "dry-run") {
      await runDryRun(client, options);
      return;
    }

    await runApply(client, options);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
