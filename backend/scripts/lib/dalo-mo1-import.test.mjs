import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DALO_WAREHOUSE_CODE,
  REVIEW_DECISION_APPROVE,
  REVIEW_DECISION_MANUAL,
  REVIEW_DECISION_SKIP,
  buildApplyRows,
  buildManualMappingIndex,
  buildReconciliationReport,
  buildReviewRows,
  buildRunManifest,
  evaluateApplyGuardrails,
  findMatchingApplyManifests,
  parseDaloSourceCsv,
  promoteManualMappings,
  validateOrgId,
  validateSnapshotDate,
} from "./dalo-mo1-import.mjs";

const SAMPLE_DALO_CSV = [
  "Film,Size,Weight,Sq. Feet,$  Sq. Feet,Beg. Inv.,Purchases,Date,Weight,Sq. Feet,$  Sq. Feet,End. Inv.,,Inv. Used",
  "DL 05 GSR,72,4.6,252,1.58,398.16,,,,,,0,,398.16",
  "DL 05 GSR,60,full,,1.58,0,,,,,,0,,0.00",
  "Supplies,,,,,,,,,,,,,",
  "Total Inventory,,,,,98141.32,,,,,,,,",
].join("\n");

test("validateSnapshotDate rejects missing and invalid values", () => {
  assert.throws(() => validateSnapshotDate(""), /Missing required --snapshot-date/);
  assert.throws(() => validateSnapshotDate("2026-02-30"), /real calendar date/);
  assert.equal(validateSnapshotDate("2026-04-21"), "2026-04-21");
});

test("validateOrgId rejects missing and invalid UUIDs", () => {
  assert.throws(() => validateOrgId(""), /Missing required --org-id/);
  assert.throws(() => validateOrgId("not-a-uuid"), /Expected a UUID/);
  assert.equal(validateOrgId("123e4567-e89b-12d3-a456-426614174000"), "123e4567-e89b-12d3-a456-426614174000");
});

test("parseDaloSourceCsv handles duplicate headers, footer rows, row-number box ids, and zeroed classification", () => {
  const parsed = parseDaloSourceCsv(SAMPLE_DALO_CSV);

  assert.equal(parsed.summary.considered_rows, 2);
  assert.equal(parsed.summary.ignored_rows, 2);
  assert.equal(parsed.summary.in_stock_rows, 1);
  assert.equal(parsed.summary.zeroed_rows, 1);

  assert.deepEqual(
    parsed.consideredRows.map((row) => ({
      sourceRow: row.sourceRow,
      boxId: row.boxId,
      status: row.status,
      initialFeet: row.initialFeet,
    })),
    [
      {
        sourceRow: 2,
        boxId: `${DALO_WAREHOUSE_CODE}-0002`,
        status: "IN_STOCK",
        initialFeet: 42,
      },
      {
        sourceRow: 3,
        boxId: `${DALO_WAREHOUSE_CODE}-0003`,
        status: "ZEROED",
        initialFeet: 0,
      },
    ]
  );
});

test("buildReviewRows prefers persistent manual mappings before catalog or fuzzy candidates", () => {
  const parsed = parseDaloSourceCsv(SAMPLE_DALO_CSV);
  const manualMappingIndex = buildManualMappingIndex([
    {
      source_film_name: "DL 05 GSR",
      source_width_in: "72",
      final_manufacturer: "DALO",
      final_film_name: "DL 05 GSR",
      notes: "known mapping",
      updated_at: "2026-04-21T00:00:00.000Z",
      updated_by: "tester",
    },
  ]);

  const reviewRows = buildReviewRows(parsed.consideredRows, manualMappingIndex, []);
  assert.equal(reviewRows[0].provenance, "manual_mapping");
  assert.equal(reviewRows[0].decision, REVIEW_DECISION_APPROVE);
  assert.equal(reviewRows[0].final_manufacturer, "DALO");
  assert.equal(reviewRows[0].final_film_name, "DL 05 GSR");
  assert.equal(reviewRows[1].decision, "");
});

test("buildApplyRows keeps unresolved mappings blocked and skips explicit review skips", () => {
  const parsed = parseDaloSourceCsv(SAMPLE_DALO_CSV);
  const reviewRows = [
    {
      source_row: "2",
      box_id: "MO1-0002",
      source_film_name: "DL 05 GSR",
      source_width_in: "72",
      proposed_manufacturer: "DALO",
      proposed_film_name: "DL 05 GSR",
      provenance: "manual_mapping",
      confidence: "high",
      final_manufacturer: "DALO",
      final_film_name: "DL 05 GSR",
      decision: REVIEW_DECISION_APPROVE,
      promote_to_manual: "",
      notes: "",
    },
    {
      source_row: "3",
      box_id: "MO1-0003",
      source_film_name: "DL 05 GSR",
      source_width_in: "60",
      proposed_manufacturer: "",
      proposed_film_name: "",
      provenance: "",
      confidence: "",
      final_manufacturer: "",
      final_film_name: "",
      decision: "",
      promote_to_manual: "",
      notes: "",
    },
  ];

  const result = buildApplyRows(parsed.consideredRows, reviewRows, "2026-04-21", "Tester");
  assert.equal(result.importRows.length, 1);
  assert.equal(result.skippedRows.length, 0);
  assert.equal(result.unresolvedRows.length, 1);

  const skippedResult = buildApplyRows(parsed.consideredRows, [
    reviewRows[0],
    { ...reviewRows[1], decision: REVIEW_DECISION_SKIP },
  ], "2026-04-21", "Tester");
  assert.equal(skippedResult.importRows.length, 1);
  assert.equal(skippedResult.skippedRows.length, 1);
  assert.equal(skippedResult.unresolvedRows.length, 0);
});

test("evaluateApplyGuardrails blocks org or warehouse mismatches and only lets force bypass duplicate/rerun blockers", () => {
  const unresolvedBlockers = evaluateApplyGuardrails({
    unresolvedRows: [{ box_id: "MO1-0002" }],
    orgExists: false,
    warehouseExists: false,
    warehouseResolutionMismatches: [{ box_id: "MO1-0002" }],
    duplicateExistingBoxIds: [{ box_id: "MO1-0002" }],
    priorApplyManifestMatches: [{ manifestPath: "apply_manifest.json" }],
    force: true,
  });

  assert.match(unresolvedBlockers.join("\n"), /Target org does not exist/);
  assert.match(unresolvedBlockers.join("\n"), /Warehouse MO1 is not configured/);
  assert.match(unresolvedBlockers.join("\n"), /did not resolve to MO1/);
  assert.match(unresolvedBlockers.join("\n"), /unresolved film mappings/);
  assert.doesNotMatch(unresolvedBlockers.join("\n"), /already exist/);
  assert.doesNotMatch(unresolvedBlockers.join("\n"), /Matching prior apply manifests/);

  const duplicateBlockers = evaluateApplyGuardrails({
    unresolvedRows: [],
    orgExists: true,
    warehouseExists: true,
    warehousePrefix: "MO1",
    duplicateExistingBoxIds: [{ box_id: "MO1-0002" }],
    priorApplyManifestMatches: [{ manifestPath: "apply_manifest.json" }],
    force: false,
  });

  assert.match(duplicateBlockers.join("\n"), /already exist/);
  assert.match(duplicateBlockers.join("\n"), /Matching prior apply manifests/);
});

test("promoteManualMappings upserts only resolved rows explicitly flagged for promotion", () => {
  const promotedAt = "2026-04-21T12:00:00.000Z";
  const existingRows = [
    {
      source_film_name: "OLD NAME",
      source_width_in: "",
      final_manufacturer: "Legacy",
      final_film_name: "Legacy Film",
      notes: "",
      updated_at: "2026-01-01T00:00:00.000Z",
      updated_by: "seed",
    },
  ];
  const reviewRows = [
    {
      source_film_name: "DL 05 GSR",
      source_width_in: "72",
      final_manufacturer: "DALO",
      final_film_name: "DL 05 GSR",
      proposed_manufacturer: "DALO",
      proposed_film_name: "DL 05 GSR",
      decision: REVIEW_DECISION_MANUAL,
      promote_to_manual: "true",
      notes: "promote this",
    },
    {
      source_film_name: "IGNORE ME",
      source_width_in: "60",
      final_manufacturer: "Nope",
      final_film_name: "Nope",
      proposed_manufacturer: "Nope",
      proposed_film_name: "Nope",
      decision: REVIEW_DECISION_APPROVE,
      promote_to_manual: "",
      notes: "",
    },
  ];

  const result = promoteManualMappings(existingRows, reviewRows, "Tester", promotedAt);
  assert.equal(result.promotedCount, 1);
  assert.equal(result.rows.length, 2);
  const promotedRow = result.rows.find((row) => row.source_film_name === "DL 05 GSR");
  assert.equal(promotedRow.final_manufacturer, "DALO");
  assert.equal(promotedRow.source_width_in, "72");
  assert.equal(promotedRow.updated_at, promotedAt);
  assert.equal(promotedRow.updated_by, "Tester");
});

test("buildRunManifest records the required tuple for replay safety", () => {
  const manifest = buildRunManifest({
    sourcePath: "C:/tmp/dalo.csv",
    sourceHash: "abc123",
    snapshotDate: "2026-04-21",
    orgId: "123e4567-e89b-12d3-a456-426614174000",
    warehouseCode: "MO1",
    totalReviewedRows: 17,
    artifactPaths: { mapping_review: "mapping_review.csv" },
  });

  assert.deepEqual(manifest, {
    source_path: "C:/tmp/dalo.csv",
    source_sha256: "abc123",
    snapshot_date: "2026-04-21",
    org_id: "123e4567-e89b-12d3-a456-426614174000",
    warehouse_code: "MO1",
    total_reviewed_rows: 17,
    artifacts: { mapping_review: "mapping_review.csv" },
  });
});

test("findMatchingApplyManifests detects matching prior apply manifests for rerun protection", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dalo-mo1-manifest-"));
  const matchingDir = path.join(tempDir, "match");
  const otherDir = path.join(tempDir, "other");
  fs.mkdirSync(matchingDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });

  fs.writeFileSync(
    path.join(matchingDir, "apply_manifest.json"),
    JSON.stringify({
      source_sha256: "same-hash",
      snapshot_date: "2026-04-21",
      org_id: "123e4567-e89b-12d3-a456-426614174000",
      warehouse_code: "MO1",
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(otherDir, "apply_manifest.json"),
    JSON.stringify({
      source_sha256: "other-hash",
      snapshot_date: "2026-04-21",
      org_id: "123e4567-e89b-12d3-a456-426614174000",
      warehouse_code: "MO1",
    }),
    "utf8"
  );

  const matches = findMatchingApplyManifests(
    tempDir,
    {
      source_sha256: "same-hash",
      snapshot_date: "2026-04-21",
      org_id: "123e4567-e89b-12d3-a456-426614174000",
      warehouse_code: "MO1",
    },
    path.join(tempDir, "current")
  );

  assert.equal(matches.length, 1);
  assert.match(matches[0].manifestPath, /match/);
});

test("buildReconciliationReport summarizes reviewed rows against database results", () => {
  const parsed = parseDaloSourceCsv(SAMPLE_DALO_CSV);
  const importRows = [
    {
      BoxID: "MO1-0002",
      Manufacturer: "DALO",
      FilmName: "DL 05 GSR",
      WidthIn: "72",
      Status: "IN_STOCK",
    },
    {
      BoxID: "MO1-0003",
      Manufacturer: "DALO",
      FilmName: "DL 05 GSR",
      WidthIn: "60",
      Status: "ZEROED",
    },
  ];

  const report = buildReconciliationReport({
    sourceRows: parsed.consideredRows,
    skippedRows: [],
    importRows,
    dbRows: [
      {
        box_id: "MO1-0002",
        warehouse: "MO1",
        manufacturer: "DALO",
        film_name: "DL 05 GSR",
        width_in: 72,
        status: "IN_STOCK",
      },
    ],
    mergeResult: {
      prepared_rows: 2,
      existing_conflicts: 1,
      inserted_rows: 1,
      skipped_rows: 1,
    },
    duplicateExistingBoxIds: [{ box_id: "MO1-0003" }],
    priorApplyManifestMatches: [],
  });

  assert.equal(report.totals.source_rows_considered, 2);
  assert.equal(report.totals.reviewed_import_rows, 2);
  assert.equal(report.totals.imported_rows, 1);
  assert.equal(report.totals.in_stock_count, 1);
  assert.equal(report.totals.zeroed_count, 0);
  assert.equal(report.expected_but_missing_rows.length, 1);
  assert.equal(report.expected_but_missing_rows[0].box_id, "MO1-0003");
});
