import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DALO_WAREHOUSE_CODE = "MO1";
export const DALO_MANUAL_MAPPING_FILE = "backend/docs/dalo_manual_mappings.csv";
export const REVIEW_DECISION_APPROVE = "approve_proposed";
export const REVIEW_DECISION_MANUAL = "use_manual_final";
export const REVIEW_DECISION_SKIP = "skip";
export const MANUAL_MAPPING_PROMOTE_TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
export const REVIEW_HEADERS = [
  "source_row",
  "box_id",
  "source_film_name",
  "source_width_in",
  "source_weight_raw",
  "source_sq_ft_raw",
  "status",
  "proposed_manufacturer",
  "proposed_film_name",
  "provenance",
  "confidence",
  "final_manufacturer",
  "final_film_name",
  "decision",
  "promote_to_manual",
  "notes",
];
export const MANUAL_MAPPING_HEADERS = [
  "source_film_name",
  "source_width_in",
  "final_manufacturer",
  "final_film_name",
  "notes",
  "updated_at",
  "updated_by",
];
export const BOX_IMPORT_HEADERS = [
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

const FOOTER_FILM_NAMES = new Set(["SUPPLIES", "TOTAL INVENTORY"]);
const ZEROED_REASON = "Imported from DALO snapshot with zero or blank Sq. Feet";
const SOURCE_ROW_MISMATCH_FIELDS = ["box_id", "source_film_name", "source_width_in"];

function trimText(value) {
  return String(value ?? "").trim();
}

function normalizeSpacing(value) {
  return trimText(value).replace(/\s+/g, " ");
}

function upperText(value) {
  return normalizeSpacing(value).toUpperCase();
}

function normalizeLabel(value) {
  return upperText(
    String(value ?? "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[()]/g, " ")
      .replace(/[_/]+/g, " ")
      .replace(/[-]+/g, " ")
      .replace(/[^A-Za-z0-9'". ]+/g, " ")
  );
}

function toFingerprint(value) {
  return normalizeLabel(value).replace(/[^A-Z0-9]+/g, "");
}

function toTokens(value) {
  return normalizeLabel(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function toModelTokens(value) {
  return new Set(
    toTokens(value)
      .map((token) => token.replace(/[^A-Z0-9]+/g, ""))
      .filter((token) => token.length >= 2 && /\d/.test(token))
  );
}

function formatWidthKey(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }
  return Number.isInteger(numeric)
    ? String(numeric)
    : String(Number(numeric.toFixed(4))).replace(/\.?0+$/g, "");
}

function parseFiniteNumber(value) {
  const trimmed = trimText(value);
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveNumber(value) {
  const parsed = parseFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function formatDateIso(date) {
  return date.toISOString().slice(0, 10);
}

function sortLocale(left, right) {
  return String(left).localeCompare(String(right), "en-US", { numeric: true, sensitivity: "base" });
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}

function stripManufacturerPrefix(filmName, manufacturer) {
  const filmTokens = toTokens(filmName);
  const manufacturerTokens = toTokens(manufacturer);
  if (filmTokens.length === 0) {
    return "";
  }

  let removeCount = 0;
  while (
    removeCount < filmTokens.length &&
    removeCount < manufacturerTokens.length &&
    filmTokens[removeCount] === manufacturerTokens[removeCount]
  ) {
    removeCount += 1;
  }

  if (removeCount === manufacturerTokens.length && removeCount > 0) {
    return filmTokens.slice(removeCount).join(" ");
  }

  if (manufacturerTokens.length > 0 && filmTokens[0] === manufacturerTokens[0]) {
    return filmTokens.slice(1).join(" ");
  }

  if (filmTokens[0] === "3M") {
    return filmTokens.slice(1).join(" ");
  }

  return filmTokens.join(" ");
}

function normalizedLabelVariants(filmName, manufacturer) {
  const stripped = stripManufacturerPrefix(filmName, manufacturer);
  return {
    normalized: normalizeLabel(filmName),
    strippedNormalized: normalizeLabel(stripped || filmName),
    fingerprint: toFingerprint(filmName),
    strippedFingerprint: toFingerprint(stripped || filmName),
    tokens: toTokens(stripped || filmName),
    modelTokens: toModelTokens(stripped || filmName),
  };
}

function parseHeaderName(value) {
  return normalizeLabel(String(value ?? "")).replace(/[^A-Z0-9]+/g, " ").trim();
}

function parseBooleanFlag(value) {
  return MANUAL_MAPPING_PROMOTE_TRUE_VALUES.has(upperText(value).toLowerCase());
}

function isBlankRow(cells) {
  return cells.every((cell) => trimText(cell) === "");
}

function buildCountRows(countMap, leftKey, rightKey) {
  return Array.from(countMap.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return sortLocale(left.key, right.key);
    })
    .map(({ key, count }) => {
      const parts = String(key).split("|");
      return {
        [leftKey]: parts[0] || "",
        [rightKey]: parts[1] || "",
        count,
      };
    });
}

export function parseArgs(argv) {
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

export function parseEnvText(content) {
  const result = {};
  for (const rawLine of String(content ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

export function validateSnapshotDate(value) {
  const raw = trimText(value);
  if (!raw) {
    throw new Error("Missing required --snapshot-date YYYY-MM-DD.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`Invalid --snapshot-date ${value}. Expected YYYY-MM-DD.`);
  }

  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || formatDateIso(parsed) !== raw) {
    throw new Error(`Invalid --snapshot-date ${value}. Expected a real calendar date in YYYY-MM-DD format.`);
  }

  return raw;
}

export function validateOrgId(value) {
  const raw = trimText(value);
  if (!raw) {
    throw new Error("Missing required --org-id <uuid>.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    throw new Error(`Invalid --org-id ${value}. Expected a UUID.`);
  }
  return raw;
}

export function defaultRunDir(backendDir, snapshotDate, orgId) {
  return path.join(
    backendDir,
    "migration-dry-runs",
    "dalo-mo1",
    `${snapshotDate}-${trimText(orgId).slice(0, 8).toLowerCase()}`
  );
}

export function fileSha256Hex(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function parseCsvMatrix(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        const next = text[index + 1];
        if (next === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    if (char === "\r") {
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export function matrixToObjects(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    return [];
  }

  const header = matrix[0].map((cell, index) => {
    if (index === 0) {
      return String(cell ?? "").replace(/^\uFEFF/, "");
    }
    return trimText(cell);
  });

  return matrix.slice(1).flatMap((cells) => {
    if (isBlankRow(cells)) {
      return [];
    }

    const row = {};
    for (let index = 0; index < header.length; index += 1) {
      row[header[index]] = cells[index] ?? "";
    }
    return [row];
  });
}

export function writeCsvFile(filePath, headers, rows) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row?.[header] ?? "")).join(","));
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

export function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJsonFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readCsvObjects(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return matrixToObjects(parseCsvMatrix(fs.readFileSync(filePath, "utf8")));
}

export function normalizeManualMappingKey(sourceFilmName, sourceWidthIn = "") {
  return `${normalizeLabel(sourceFilmName)}|${formatWidthKey(sourceWidthIn)}`;
}

export function loadManualMappings(filePath) {
  return readCsvObjects(filePath)
    .map((row) => ({
      source_film_name: normalizeSpacing(row.source_film_name),
      source_width_in: formatWidthKey(row.source_width_in),
      final_manufacturer: normalizeSpacing(row.final_manufacturer),
      final_film_name: normalizeSpacing(row.final_film_name),
      notes: normalizeSpacing(row.notes),
      updated_at: trimText(row.updated_at),
      updated_by: normalizeSpacing(row.updated_by),
    }))
    .filter((row) => row.source_film_name && row.final_manufacturer && row.final_film_name);
}

export function saveManualMappings(filePath, rows) {
  const normalizedRows = rows
    .map((row) => ({
      source_film_name: normalizeSpacing(row.source_film_name),
      source_width_in: formatWidthKey(row.source_width_in),
      final_manufacturer: normalizeSpacing(row.final_manufacturer),
      final_film_name: normalizeSpacing(row.final_film_name),
      notes: normalizeSpacing(row.notes),
      updated_at: trimText(row.updated_at),
      updated_by: normalizeSpacing(row.updated_by),
    }))
    .filter((row) => row.source_film_name && row.final_manufacturer && row.final_film_name)
    .sort((left, right) => {
      const nameDelta = sortLocale(left.source_film_name, right.source_film_name);
      if (nameDelta !== 0) {
        return nameDelta;
      }
      return sortLocale(left.source_width_in, right.source_width_in);
    });

  writeCsvFile(filePath, MANUAL_MAPPING_HEADERS, normalizedRows);
}

export function buildManualMappingIndex(rows) {
  const exactWidth = new Map();
  const anyWidth = new Map();

  for (const row of rows) {
    const mapping = {
      sourceFilmName: normalizeSpacing(row.source_film_name),
      sourceWidthIn: formatWidthKey(row.source_width_in),
      finalManufacturer: normalizeSpacing(row.final_manufacturer),
      finalFilmName: normalizeSpacing(row.final_film_name),
      notes: normalizeSpacing(row.notes),
      updatedAt: trimText(row.updated_at),
      updatedBy: normalizeSpacing(row.updated_by),
    };
    const key = normalizeManualMappingKey(mapping.sourceFilmName, mapping.sourceWidthIn);
    if (mapping.sourceWidthIn) {
      exactWidth.set(key, mapping);
    } else {
      anyWidth.set(normalizeManualMappingKey(mapping.sourceFilmName, ""), mapping);
    }
  }

  return { exactWidth, anyWidth };
}

export function findManualMapping(index, sourceFilmName, sourceWidthIn) {
  const widthKey = normalizeManualMappingKey(sourceFilmName, sourceWidthIn);
  const noWidthKey = normalizeManualMappingKey(sourceFilmName, "");
  return index.exactWidth.get(widthKey) || index.anyWidth.get(noWidthKey) || null;
}

export function buildMo1BoxId(sourceRowNumber) {
  return `${DALO_WAREHOUSE_CODE}-${String(sourceRowNumber).padStart(4, "0")}`;
}

export function deriveLinearFeetFromSqFt(widthIn, squareFeet) {
  const widthNumeric = Number(widthIn);
  const squareFeetNumeric = Number(squareFeet);
  if (!Number.isFinite(widthNumeric) || widthNumeric <= 0) {
    throw new Error(`Width must be a positive number. Received ${widthIn}.`);
  }
  if (!Number.isFinite(squareFeetNumeric) || squareFeetNumeric < 0) {
    throw new Error(`Sq. Feet must be zero or greater. Received ${squareFeet}.`);
  }
  return Math.round(squareFeetNumeric / (widthNumeric / 12));
}

export function parseDaloSourceCsv(csvText) {
  const matrix = parseCsvMatrix(csvText);
  if (matrix.length === 0) {
    throw new Error("Source CSV is empty.");
  }

  const header = matrix[0].map((cell) => String(cell ?? "").replace(/^\uFEFF/, ""));
  const normalizedHeader = header.map((cell) => parseHeaderName(cell));
  if (normalizedHeader[0] !== "FILM" || normalizedHeader[1] !== "SIZE" || normalizedHeader[2] !== "WEIGHT") {
    throw new Error("Unexpected DALO CSV header. Expected Film, Size, Weight, Sq. Feet in the first columns.");
  }
  if (normalizedHeader[3] !== "SQ FEET") {
    throw new Error("Unexpected DALO CSV header. Expected Sq. Feet as the fourth column.");
  }

  const consideredRows = [];
  const exceptions = [];
  const ignoredRows = [];

  for (let index = 1; index < matrix.length; index += 1) {
    const cells = matrix[index];
    if (isBlankRow(cells)) {
      continue;
    }

    const spreadsheetRow = index + 1;
    const sourceFilmName = normalizeSpacing(cells[0]);
    const sizeRaw = trimText(cells[1]);
    const weightRaw = trimText(cells[2]);
    const sqFeetRaw = trimText(cells[3]);

    if (!sourceFilmName) {
      ignoredRows.push({
        source_row: spreadsheetRow,
        reason: "blank_film_name",
        source_film_name: "",
        source_width_raw: sizeRaw,
        source_weight_raw: weightRaw,
        source_sq_ft_raw: sqFeetRaw,
      });
      continue;
    }

    if (FOOTER_FILM_NAMES.has(upperText(sourceFilmName))) {
      ignoredRows.push({
        source_row: spreadsheetRow,
        reason: "footer_or_non_box_row",
        source_film_name: sourceFilmName,
        source_width_raw: sizeRaw,
        source_weight_raw: weightRaw,
        source_sq_ft_raw: sqFeetRaw,
      });
      continue;
    }

    const widthIn = parsePositiveNumber(sizeRaw);
    if (widthIn === null) {
      exceptions.push({
        source_row: spreadsheetRow,
        reason: "invalid_or_missing_width",
        source_film_name: sourceFilmName,
        source_width_raw: sizeRaw,
        source_weight_raw: weightRaw,
        source_sq_ft_raw: sqFeetRaw,
      });
      continue;
    }

    const squareFeet = parsePositiveNumber(sqFeetRaw);
    const isPositiveSquareFeet = squareFeet !== null;
    const initialFeet = isPositiveSquareFeet ? deriveLinearFeetFromSqFt(widthIn, squareFeet) : 0;
    const numericWeight = parseFiniteNumber(weightRaw);
    const status = isPositiveSquareFeet ? "IN_STOCK" : "ZEROED";

    consideredRows.push({
      sourceRow: spreadsheetRow,
      boxId: buildMo1BoxId(spreadsheetRow),
      sourceFilmName,
      sourceWidthIn: widthIn,
      sourceWidthInKey: formatWidthKey(widthIn),
      sourceWeightRaw: weightRaw,
      sourceWeightLbs: numericWeight,
      sourceSqFtRaw: sqFeetRaw,
      sourceSquareFeet: squareFeet ?? 0,
      status,
      initialFeet,
      feetAvailable: initialFeet,
      zeroedReason: isPositiveSquareFeet ? "" : ZEROED_REASON,
    });
  }

  return {
    header,
    consideredRows,
    ignoredRows,
    exceptions,
    summary: {
      total_csv_rows: Math.max(matrix.length - 1, 0),
      considered_rows: consideredRows.length,
      ignored_rows: ignoredRows.length,
      exception_rows: exceptions.length,
      in_stock_rows: consideredRows.filter((row) => row.status === "IN_STOCK").length,
      zeroed_rows: consideredRows.filter((row) => row.status === "ZEROED").length,
    },
  };
}

export function buildCatalogCandidates({ catalogRows = [], boxRows = [] }) {
  const byIdentity = new Map();

  const addCandidate = (manufacturer, filmName, widthIn, sourceTag) => {
    const normalizedManufacturer = normalizeSpacing(manufacturer);
    const normalizedFilmName = normalizeSpacing(filmName);
    if (!normalizedManufacturer || !normalizedFilmName) {
      return;
    }

    const key = `${upperText(normalizedManufacturer)}|${upperText(normalizedFilmName)}`;
    if (!byIdentity.has(key)) {
      const variants = normalizedLabelVariants(normalizedFilmName, normalizedManufacturer);
      byIdentity.set(key, {
        manufacturer: normalizedManufacturer,
        filmName: normalizedFilmName,
        widths: new Set(),
        sources: new Set(),
        ...variants,
      });
    }

    const candidate = byIdentity.get(key);
    const widthKey = formatWidthKey(widthIn);
    if (widthKey) {
      candidate.widths.add(widthKey);
    }
    candidate.sources.add(sourceTag);
  };

  for (const row of catalogRows) {
    addCandidate(row.manufacturer, row.film_name || row.filmName, row.source_width_in || row.sourceWidthIn, "catalog");
  }
  for (const row of boxRows) {
    addCandidate(row.manufacturer, row.film_name || row.filmName, row.width_in || row.widthIn, "boxes");
  }

  return Array.from(byIdentity.values());
}

function pickUniqueCandidate(candidates, sourceWidthInKey) {
  if (candidates.length === 0) {
    return null;
  }

  const widthMatched = sourceWidthInKey
    ? candidates.filter((candidate) => candidate.widths.size === 0 || candidate.widths.has(sourceWidthInKey))
    : candidates;
  const effective = widthMatched.length > 0 ? widthMatched : candidates;

  if (effective.length === 1) {
    return effective[0];
  }

  const uniqueIdentity = new Map();
  for (const candidate of effective) {
    uniqueIdentity.set(`${upperText(candidate.manufacturer)}|${upperText(candidate.filmName)}`, candidate);
  }

  return uniqueIdentity.size === 1 ? Array.from(uniqueIdentity.values())[0] : null;
}

function tokenOverlapScore(sourceTokens, candidateTokens) {
  if (sourceTokens.length === 0 || candidateTokens.length === 0) {
    return 0;
  }
  const sourceSet = new Set(sourceTokens);
  const candidateSet = new Set(candidateTokens);
  const intersection = Array.from(sourceSet).filter((token) => candidateSet.has(token)).length;
  const union = new Set([...sourceSet, ...candidateSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function modelTokenBonus(sourceModelTokens, candidateModelTokens) {
  if (sourceModelTokens.size === 0 || candidateModelTokens.size === 0) {
    return 0;
  }
  for (const token of sourceModelTokens) {
    if (candidateModelTokens.has(token)) {
      return 0.18;
    }
  }
  return 0;
}

function computeFuzzyScore(sourceRow, candidate) {
  const sourceLabel = normalizeLabel(sourceRow.sourceFilmName);
  const sourceFingerprint = toFingerprint(sourceRow.sourceFilmName);
  const sourceTokens = toTokens(sourceRow.sourceFilmName);
  const sourceModelTokens = toModelTokens(sourceRow.sourceFilmName);
  const widthKey = sourceRow.sourceWidthInKey;

  let score = 0;

  if (candidate.strippedNormalized.includes(sourceLabel) || sourceLabel.includes(candidate.strippedNormalized)) {
    score = Math.max(score, 0.76);
  }

  if (candidate.strippedFingerprint && sourceFingerprint && candidate.strippedFingerprint.includes(sourceFingerprint)) {
    score = Math.max(score, 0.78);
  }

  score = Math.max(score, 0.52 + tokenOverlapScore(sourceTokens, candidate.tokens) * 0.36);
  score += modelTokenBonus(sourceModelTokens, candidate.modelTokens);

  if (widthKey && candidate.widths.has(widthKey)) {
    score += 0.06;
  }

  if (candidate.sources.has("catalog")) {
    score += 0.02;
  }

  return Math.min(score, 0.94);
}

export function proposeMappingForSourceRow(sourceRow, manualMappingIndex, catalogCandidates) {
  const manualMapping = findManualMapping(
    manualMappingIndex,
    sourceRow.sourceFilmName,
    sourceRow.sourceWidthInKey
  );

  if (manualMapping) {
    return {
      proposedManufacturer: manualMapping.finalManufacturer,
      proposedFilmName: manualMapping.finalFilmName,
      provenance: "manual_mapping",
      confidence: "high",
      autoApprove: true,
      notes: manualMapping.notes,
    };
  }

  const sourceLabel = normalizeLabel(sourceRow.sourceFilmName);
  const sourceFingerprint = toFingerprint(sourceRow.sourceFilmName);
  const sourceWidthInKey = sourceRow.sourceWidthInKey;

  const exactMatches = catalogCandidates.filter(
    (candidate) =>
      candidate.sources.has("catalog") &&
      (candidate.normalized === sourceLabel || candidate.strippedNormalized === sourceLabel)
  );
  const exactMatch = pickUniqueCandidate(exactMatches, sourceWidthInKey);
  if (exactMatch) {
    return {
      proposedManufacturer: exactMatch.manufacturer,
      proposedFilmName: exactMatch.filmName,
      provenance: "catalog_exact",
      confidence: "high",
      autoApprove: true,
      notes: "",
    };
  }

  const fingerprintMatches = catalogCandidates.filter(
    (candidate) =>
      candidate.sources.has("catalog") &&
      sourceFingerprint &&
      (candidate.fingerprint === sourceFingerprint || candidate.strippedFingerprint === sourceFingerprint)
  );
  const fingerprintMatch = pickUniqueCandidate(fingerprintMatches, sourceWidthInKey);
  if (fingerprintMatch) {
    return {
      proposedManufacturer: fingerprintMatch.manufacturer,
      proposedFilmName: fingerprintMatch.filmName,
      provenance: "catalog_fingerprint",
      confidence: "high",
      autoApprove: true,
      notes: "",
    };
  }

  const rankedCandidates = catalogCandidates
    .map((candidate) => ({
      candidate,
      score: computeFuzzyScore(sourceRow, candidate),
    }))
    .filter((entry) => entry.score >= 0.74)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const leftCatalog = left.candidate.sources.has("catalog") ? 1 : 0;
      const rightCatalog = right.candidate.sources.has("catalog") ? 1 : 0;
      if (rightCatalog !== leftCatalog) {
        return rightCatalog - leftCatalog;
      }
      return sortLocale(left.candidate.filmName, right.candidate.filmName);
    });

  if (rankedCandidates.length === 0) {
    return null;
  }

  const top = rankedCandidates[0];
  const runnerUp = rankedCandidates[1];
  if (runnerUp && runnerUp.score >= top.score - 0.03) {
    return null;
  }

  return {
    proposedManufacturer: top.candidate.manufacturer,
    proposedFilmName: top.candidate.filmName,
    provenance: "fuzzy_candidate",
    confidence: top.score >= 0.88 ? "high" : top.score >= 0.82 ? "medium" : "low",
    autoApprove: false,
    notes: "",
  };
}

export function buildReviewRows(sourceRows, manualMappingIndex, catalogCandidates) {
  return sourceRows.map((sourceRow) => {
    const proposal = proposeMappingForSourceRow(sourceRow, manualMappingIndex, catalogCandidates);
    const proposedManufacturer = normalizeSpacing(proposal?.proposedManufacturer);
    const proposedFilmName = normalizeSpacing(proposal?.proposedFilmName);
    const autoApprove = Boolean(proposal?.autoApprove && proposedManufacturer && proposedFilmName);

    return {
      source_row: String(sourceRow.sourceRow),
      box_id: sourceRow.boxId,
      source_film_name: sourceRow.sourceFilmName,
      source_width_in: sourceRow.sourceWidthInKey,
      source_weight_raw: sourceRow.sourceWeightRaw,
      source_sq_ft_raw: sourceRow.sourceSqFtRaw,
      status: sourceRow.status,
      proposed_manufacturer: proposedManufacturer,
      proposed_film_name: proposedFilmName,
      provenance: proposal?.provenance || "",
      confidence: proposal?.confidence || "",
      final_manufacturer: proposedManufacturer,
      final_film_name: proposedFilmName,
      decision: autoApprove ? REVIEW_DECISION_APPROVE : "",
      promote_to_manual: "",
      notes: normalizeSpacing(
        [
          proposal?.notes,
          sourceRow.status === "ZEROED" ? sourceRow.zeroedReason : "",
          sourceRow.sourceWeightRaw ? `SourceWeight=${sourceRow.sourceWeightRaw}` : "",
          sourceRow.sourceSqFtRaw ? `SourceSqFt=${sourceRow.sourceSqFtRaw}` : "SourceSqFt=(blank)",
        ]
          .filter(Boolean)
          .join("; ")
      ),
    };
  });
}

export function buildCandidateRows(sourceRows, reviewRows, snapshotDate, actor) {
  const reviewByBoxId = new Map(reviewRows.map((row) => [trimText(row.box_id), row]));

  return sourceRows.map((sourceRow) => {
    const reviewRow = reviewByBoxId.get(sourceRow.boxId);
    const decision = normalizeReviewDecision(reviewRow?.decision);
    const effectiveManufacturer =
      normalizeSpacing(reviewRow?.final_manufacturer) || normalizeSpacing(reviewRow?.proposed_manufacturer);
    const effectiveFilmName =
      normalizeSpacing(reviewRow?.final_film_name) || normalizeSpacing(reviewRow?.proposed_film_name);

    return {
      ...buildStagingImportRow(
        sourceRow,
        {
          manufacturer: effectiveManufacturer,
          filmName: effectiveFilmName,
          provenance: trimText(reviewRow?.provenance),
          decision,
        },
        snapshotDate,
        actor
      ),
      Decision: decision,
      ProposedManufacturer: trimText(reviewRow?.proposed_manufacturer),
      ProposedFilmName: trimText(reviewRow?.proposed_film_name),
      MappingProvenance: trimText(reviewRow?.provenance),
      MappingConfidence: trimText(reviewRow?.confidence),
    };
  });
}

export function normalizeReviewDecision(value) {
  const normalized = trimText(value).toLowerCase();
  if (normalized === REVIEW_DECISION_APPROVE) {
    return REVIEW_DECISION_APPROVE;
  }
  if (normalized === REVIEW_DECISION_MANUAL) {
    return REVIEW_DECISION_MANUAL;
  }
  if (normalized === REVIEW_DECISION_SKIP) {
    return REVIEW_DECISION_SKIP;
  }
  return "";
}

function effectiveReviewMapping(reviewRow) {
  const decision = normalizeReviewDecision(reviewRow?.decision);
  const proposedManufacturer = normalizeSpacing(reviewRow?.proposed_manufacturer);
  const proposedFilmName = normalizeSpacing(reviewRow?.proposed_film_name);
  const finalManufacturer = normalizeSpacing(reviewRow?.final_manufacturer);
  const finalFilmName = normalizeSpacing(reviewRow?.final_film_name);

  if (decision === REVIEW_DECISION_SKIP) {
    return {
      decision,
      skipped: true,
      provenance: trimText(reviewRow?.provenance),
      manufacturer: "",
      filmName: "",
    };
  }

  if (decision === REVIEW_DECISION_APPROVE) {
    const manufacturer = finalManufacturer || proposedManufacturer;
    const filmName = finalFilmName || proposedFilmName;
    return {
      decision,
      skipped: false,
      provenance: trimText(reviewRow?.provenance),
      manufacturer,
      filmName,
    };
  }

  if (decision === REVIEW_DECISION_MANUAL) {
    return {
      decision,
      skipped: false,
      provenance: "review_manual_override",
      manufacturer: finalManufacturer,
      filmName: finalFilmName,
    };
  }

  return {
    decision: "",
    skipped: false,
    provenance: trimText(reviewRow?.provenance),
    manufacturer: "",
    filmName: "",
  };
}

export function validateReviewRowsAgainstSource(sourceRows, reviewRows) {
  const reviewByKey = new Map(reviewRows.map((row) => [`${trimText(row.source_row)}|${trimText(row.box_id)}`, row]));
  const errors = [];

  for (const sourceRow of sourceRows) {
    const key = `${sourceRow.sourceRow}|${sourceRow.boxId}`;
    const reviewRow = reviewByKey.get(key);
    if (!reviewRow) {
      errors.push(`Missing review row for ${sourceRow.boxId} (source row ${sourceRow.sourceRow}).`);
      continue;
    }

    for (const fieldName of SOURCE_ROW_MISMATCH_FIELDS) {
      const sourceValue =
        fieldName === "source_film_name"
          ? sourceRow.sourceFilmName
          : fieldName === "source_width_in"
            ? sourceRow.sourceWidthInKey
            : sourceRow.boxId;
      const reviewValue = trimText(reviewRow[fieldName]);
      if (normalizeSpacing(sourceValue) !== normalizeSpacing(reviewValue)) {
        errors.push(
          `Review row mismatch for ${sourceRow.boxId}: ${fieldName} expected "${sourceValue}" but found "${reviewValue}".`
        );
      }
    }
  }

  for (const reviewRow of reviewRows) {
    const key = `${trimText(reviewRow.source_row)}|${trimText(reviewRow.box_id)}`;
    if (!sourceRows.some((sourceRow) => `${sourceRow.sourceRow}|${sourceRow.boxId}` === key)) {
      errors.push(`Unexpected review row ${trimText(reviewRow.box_id)} (source row ${trimText(reviewRow.source_row)}).`);
    }
  }

  return errors;
}

function buildFilmKey(manufacturer, filmName) {
  return `${upperText(manufacturer)}|${upperText(filmName)}`;
}

export function buildStagingImportRow(sourceRow, mapping, snapshotDate, actor) {
  const manufacturer = normalizeSpacing(mapping?.manufacturer);
  const filmName = normalizeSpacing(mapping?.filmName);
  const provenance = trimText(mapping?.provenance);
  const decision = normalizeReviewDecision(mapping?.decision);
  const notes = [
    `SourceRow=${sourceRow.sourceRow}`,
    `SourceFilm=${sourceRow.sourceFilmName}`,
    `SourceWeight=${sourceRow.sourceWeightRaw || "(blank)"}`,
    `SourceSqFt=${sourceRow.sourceSqFtRaw || "(blank)"}`,
    provenance ? `MappingProvenance=${provenance}` : "",
    decision ? `ReviewDecision=${decision}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  return {
    BoxID: sourceRow.boxId,
    Manufacturer: manufacturer,
    FilmName: filmName,
    WidthIn: sourceRow.sourceWidthInKey,
    InitialFeet: String(sourceRow.initialFeet),
    FeetAvailable: String(sourceRow.feetAvailable),
    LotRun: "",
    Status: sourceRow.status,
    OrderDate: snapshotDate,
    ReceivedDate: snapshotDate,
    InitialWeightLbs: sourceRow.sourceWeightLbs === null ? "" : String(Number(sourceRow.sourceWeightLbs.toFixed(2))),
    LastRollWeightLbs: "",
    LastWeighedDate: "",
    FilmKey: manufacturer && filmName ? buildFilmKey(manufacturer, filmName) : "",
    CoreType: "",
    CoreWeightLbs: "",
    LfWeightLbsPerFt: "",
    PricePerLf: "",
    PurchaseCost: "",
    Notes: notes,
    HasEverBeenCheckedOut: "false",
    LastCheckoutJob: "",
    LastCheckoutDate: "",
    ZeroedDate: sourceRow.status === "ZEROED" ? snapshotDate : "",
    ZeroedReason: sourceRow.status === "ZEROED" ? sourceRow.zeroedReason : "",
    ZeroedBy: sourceRow.status === "ZEROED" ? normalizeSpacing(actor) : "",
  };
}

export function buildApplyRows(sourceRows, reviewRows, snapshotDate, actor) {
  const validationErrors = validateReviewRowsAgainstSource(sourceRows, reviewRows);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("\n"));
  }

  const reviewByKey = new Map(reviewRows.map((row) => [`${trimText(row.source_row)}|${trimText(row.box_id)}`, row]));
  const importRows = [];
  const unresolvedRows = [];
  const skippedRows = [];

  for (const sourceRow of sourceRows) {
    const reviewRow = reviewByKey.get(`${sourceRow.sourceRow}|${sourceRow.boxId}`);
    const effective = effectiveReviewMapping(reviewRow);

    if (effective.skipped) {
      skippedRows.push({
        source_row: String(sourceRow.sourceRow),
        box_id: sourceRow.boxId,
        source_film_name: sourceRow.sourceFilmName,
        source_width_in: sourceRow.sourceWidthInKey,
        decision: REVIEW_DECISION_SKIP,
      });
      continue;
    }

    if (!effective.manufacturer || !effective.filmName) {
      unresolvedRows.push({
        source_row: String(sourceRow.sourceRow),
        box_id: sourceRow.boxId,
        source_film_name: sourceRow.sourceFilmName,
        source_width_in: sourceRow.sourceWidthInKey,
        decision: effective.decision,
        provenance: effective.provenance,
      });
      continue;
    }

    importRows.push(
      buildStagingImportRow(
        sourceRow,
        {
          manufacturer: effective.manufacturer,
          filmName: effective.filmName,
          provenance: effective.provenance,
          decision: effective.decision,
        },
        snapshotDate,
        actor
      )
    );
  }

  return { importRows, skippedRows, unresolvedRows };
}

export function buildRunManifest({
  sourcePath,
  sourceHash,
  snapshotDate,
  orgId,
  warehouseCode,
  totalReviewedRows,
  artifactPaths,
}) {
  return {
    source_path: sourcePath,
    source_sha256: sourceHash,
    snapshot_date: snapshotDate,
    org_id: orgId,
    warehouse_code: warehouseCode,
    total_reviewed_rows: totalReviewedRows,
    artifacts: artifactPaths,
  };
}

export function findMatchingApplyManifests(rootDir, manifestTuple, currentRunDir = "") {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const matches = [];
  const stack = [rootDir];
  const currentRunDirNormalized = currentRunDir ? path.resolve(currentRunDir) : "";

  while (stack.length > 0) {
    const currentDir = stack.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (!entry.isFile() || entry.name !== "apply_manifest.json") {
        continue;
      }

      if (currentRunDirNormalized && path.dirname(absolutePath) === currentRunDirNormalized) {
        continue;
      }

      try {
        const manifest = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
        if (
          trimText(manifest.source_sha256) === trimText(manifestTuple.source_sha256) &&
          trimText(manifest.snapshot_date) === trimText(manifestTuple.snapshot_date) &&
          trimText(manifest.org_id) === trimText(manifestTuple.org_id) &&
          trimText(manifest.warehouse_code) === trimText(manifestTuple.warehouse_code)
        ) {
          matches.push({
            manifestPath: absolutePath,
            manifest,
          });
        }
      } catch {
        // Ignore invalid manifests while scanning historical artifacts.
      }
    }
  }

  return matches.sort((left, right) => sortLocale(left.manifestPath, right.manifestPath));
}

export function evaluateApplyGuardrails({
  unresolvedRows = [],
  orgExists = true,
  warehouseExists = true,
  warehousePrefix = "",
  warehouseResolutionMismatches = [],
  duplicateExistingBoxIds = [],
  priorApplyManifestMatches = [],
  force = false,
}) {
  const blockers = [];

  if (!orgExists) {
    blockers.push("Target org does not exist.");
  }

  if (!warehouseExists) {
    blockers.push(`Warehouse ${DALO_WAREHOUSE_CODE} is not configured for the target org.`);
  }

  if (warehouseExists && upperText(warehousePrefix) !== DALO_WAREHOUSE_CODE) {
    blockers.push(
      `Warehouse ${DALO_WAREHOUSE_CODE} does not use prefix ${DALO_WAREHOUSE_CODE}. Found ${warehousePrefix || "(blank)"}.`
    );
  }

  if (warehouseResolutionMismatches.length > 0) {
    blockers.push(
      `${warehouseResolutionMismatches.length} generated box IDs did not resolve to ${DALO_WAREHOUSE_CODE}.`
    );
  }

  if (unresolvedRows.length > 0) {
    blockers.push(`${unresolvedRows.length} non-skipped rows still have unresolved film mappings.`);
  }

  if (!force && duplicateExistingBoxIds.length > 0) {
    blockers.push(
      `${duplicateExistingBoxIds.length} incoming BoxIDs already exist in app.boxes for the target org/warehouse.`
    );
  }

  if (!force && priorApplyManifestMatches.length > 0) {
    blockers.push(
      `Matching prior apply manifests were found for this source hash / snapshot date / org / warehouse tuple (${priorApplyManifestMatches.length} hit(s)).`
    );
  }

  return blockers;
}

export function promoteManualMappings(existingRows, reviewRows, actor, promotedAtIso) {
  const byKey = new Map(
    existingRows.map((row) => [normalizeManualMappingKey(row.source_film_name, row.source_width_in), { ...row }])
  );
  let promotedCount = 0;

  for (const reviewRow of reviewRows) {
    const decision = normalizeReviewDecision(reviewRow.decision);
    if (decision !== REVIEW_DECISION_APPROVE && decision !== REVIEW_DECISION_MANUAL) {
      continue;
    }
    if (!parseBooleanFlag(reviewRow.promote_to_manual)) {
      continue;
    }

    const effective = effectiveReviewMapping(reviewRow);
    if (!effective.manufacturer || !effective.filmName) {
      continue;
    }

    const key = normalizeManualMappingKey(reviewRow.source_film_name, reviewRow.source_width_in);
    byKey.set(key, {
      source_film_name: normalizeSpacing(reviewRow.source_film_name),
      source_width_in: formatWidthKey(reviewRow.source_width_in),
      final_manufacturer: effective.manufacturer,
      final_film_name: effective.filmName,
      notes: normalizeSpacing(reviewRow.notes),
      updated_at: promotedAtIso,
      updated_by: normalizeSpacing(actor),
    });
    promotedCount += 1;
  }

  const rows = Array.from(byKey.values()).sort((left, right) => {
    const sourceDelta = sortLocale(left.source_film_name, right.source_film_name);
    if (sourceDelta !== 0) {
      return sourceDelta;
    }
    return sortLocale(left.source_width_in, right.source_width_in);
  });

  return { rows, promotedCount };
}

export function summarizeDryRun({ parsedSource, reviewRows, warnings = [] }) {
  const provenanceCounts = new Map();
  const decisionCounts = new Map();

  for (const reviewRow of reviewRows) {
    provenanceCounts.set(trimText(reviewRow.provenance) || "(blank)", (provenanceCounts.get(trimText(reviewRow.provenance) || "(blank)") || 0) + 1);
    decisionCounts.set(normalizeReviewDecision(reviewRow.decision) || "(blank)", (decisionCounts.get(normalizeReviewDecision(reviewRow.decision) || "(blank)") || 0) + 1);
  }

  return {
    source_summary: parsedSource.summary,
    review_summary: {
      total_review_rows: reviewRows.length,
      unresolved_rows: reviewRows.filter((row) => !normalizeReviewDecision(row.decision)).length,
      auto_approved_rows: reviewRows.filter((row) => normalizeReviewDecision(row.decision) === REVIEW_DECISION_APPROVE).length,
      provenance_counts: Object.fromEntries(
        Array.from(provenanceCounts.entries()).sort((left, right) => sortLocale(left[0], right[0]))
      ),
      decision_counts: Object.fromEntries(
        Array.from(decisionCounts.entries()).sort((left, right) => sortLocale(left[0], right[0]))
      ),
    },
    warnings,
  };
}

export function buildReconciliationReport({
  sourceRows,
  skippedRows,
  importRows,
  dbRows,
  mergeResult,
  duplicateExistingBoxIds = [],
  priorApplyManifestMatches = [],
}) {
  const dbByBoxId = new Map(dbRows.map((row) => [trimText(row.box_id || row.boxId), row]));
  const missingRows = importRows.filter((row) => !dbByBoxId.has(trimText(row.BoxID)));
  const foundRows = importRows
    .map((row) => dbByBoxId.get(trimText(row.BoxID)))
    .filter(Boolean);

  const statusCounts = new Map();
  const manufacturerFilmCounts = new Map();
  const widthCounts = new Map();
  const warehouseCounts = new Map();

  for (const row of foundRows) {
    const status = upperText(row.status);
    const manufacturer = normalizeSpacing(row.manufacturer);
    const filmName = normalizeSpacing(row.film_name || row.filmName);
    const width = formatWidthKey(row.width_in || row.widthIn);
    const warehouse = upperText(row.warehouse);

    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    manufacturerFilmCounts.set(`${manufacturer}|${filmName}`, (manufacturerFilmCounts.get(`${manufacturer}|${filmName}`) || 0) + 1);
    widthCounts.set(width, (widthCounts.get(width) || 0) + 1);
    warehouseCounts.set(warehouse, (warehouseCounts.get(warehouse) || 0) + 1);
  }

  return {
    totals: {
      source_rows_considered: sourceRows.length,
      skipped_rows: skippedRows.length,
      reviewed_import_rows: importRows.length,
      imported_rows: Number(mergeResult?.inserted_rows || 0),
      db_rows_found_for_expected_box_ids: foundRows.length,
      in_stock_count: statusCounts.get("IN_STOCK") || 0,
      zeroed_count: statusCounts.get("ZEROED") || 0,
    },
    counts: {
      by_manufacturer_and_film: buildCountRows(manufacturerFilmCounts, "manufacturer", "film_name"),
      by_width: Array.from(widthCounts.entries())
        .map(([width_in, count]) => ({ width_in, count }))
        .sort((left, right) => {
          if (Number(left.width_in) !== Number(right.width_in)) {
            return Number(left.width_in) - Number(right.width_in);
          }
          return sortLocale(left.width_in, right.width_in);
        }),
      by_warehouse: Array.from(warehouseCounts.entries())
        .map(([warehouse, count]) => ({ warehouse, count }))
        .sort((left, right) => sortLocale(left.warehouse, right.warehouse)),
    },
    conflicts: {
      existing_box_id_conflicts: duplicateExistingBoxIds,
      prior_apply_manifest_matches: priorApplyManifestMatches.map((entry) => entry.manifestPath),
      merge_result: mergeResult,
    },
    expected_but_missing_rows: missingRows.map((row) => ({
      box_id: row.BoxID,
      manufacturer: row.Manufacturer,
      film_name: row.FilmName,
      width_in: row.WidthIn,
      status: row.Status,
    })),
  };
}

export function renderReconciliationMarkdown(report) {
  const lines = [
    "# DALO MO1 Reconciliation Report",
    "",
    "## Totals",
    `- Source rows considered: ${report.totals.source_rows_considered}`,
    `- Skipped rows: ${report.totals.skipped_rows}`,
    `- Reviewed import rows: ${report.totals.reviewed_import_rows}`,
    `- Imported rows: ${report.totals.imported_rows}`,
    `- DB rows found for expected BoxIDs: ${report.totals.db_rows_found_for_expected_box_ids}`,
    `- IN_STOCK count: ${report.totals.in_stock_count}`,
    `- ZEROED count: ${report.totals.zeroed_count}`,
    "",
    "## Count By Manufacturer + Film",
  ];

  if (report.counts.by_manufacturer_and_film.length === 0) {
    lines.push("- (none)");
  } else {
    for (const row of report.counts.by_manufacturer_and_film) {
      lines.push(`- ${row.manufacturer} | ${row.film_name}: ${row.count}`);
    }
  }

  lines.push("", "## Count By Width");
  if (report.counts.by_width.length === 0) {
    lines.push("- (none)");
  } else {
    for (const row of report.counts.by_width) {
      lines.push(`- ${row.width_in || "(blank)"}: ${row.count}`);
    }
  }

  lines.push("", "## Count By Warehouse");
  if (report.counts.by_warehouse.length === 0) {
    lines.push("- (none)");
  } else {
    for (const row of report.counts.by_warehouse) {
      lines.push(`- ${row.warehouse || "(blank)"}: ${row.count}`);
    }
  }

  lines.push(
    "",
    "## Duplicate / Conflict Summary",
    `- Existing BoxID conflicts: ${report.conflicts.existing_box_id_conflicts.length}`,
    `- Prior apply manifest matches: ${report.conflicts.prior_apply_manifest_matches.length}`,
    `- Merge prepared rows: ${report.conflicts.merge_result?.prepared_rows ?? 0}`,
    `- Merge existing conflicts: ${report.conflicts.merge_result?.existing_conflicts ?? 0}`,
    `- Merge skipped rows: ${report.conflicts.merge_result?.skipped_rows ?? 0}`,
    "",
    "## Expected But Not Found",
  );

  if (report.expected_but_missing_rows.length === 0) {
    lines.push("- (none)");
  } else {
    for (const row of report.expected_but_missing_rows) {
      lines.push(`- ${row.box_id}: ${row.manufacturer} | ${row.film_name} | ${row.width_in} | ${row.status}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
