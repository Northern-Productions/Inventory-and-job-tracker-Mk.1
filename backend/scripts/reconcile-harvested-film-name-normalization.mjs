
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(backendDir, "..");
const envPath = path.join(backendDir, ".env");

const CONFIDENCE_HIGH = "high";
const REASON_EXACT = "exact_normalized_match";
const REASON_FP_UNIQUE = "fingerprint_unique_match";
const REASON_TOKEN_UNIQUE = "token_unique_match";
const REASON_PREFIX_POLICY = "manufacturer_prefix_policy";
const REASON_AVERY_NATURA_SHADE_FORMAT = "avery_natura_shade_format";
const REASON_AVERY_NATURA_INFERRED_SHADE = "avery_natura_inferred_shade";
const REASON_AVERY_NATURA_MISSING_SHADE = "avery_natura_missing_shade";
const REASON_AMBIGUOUS = "ambiguous_multi_candidate";
const REASON_NO_MATCH = "no_match";
const REASON_NO_MANUFACTURER = "no_manufacturer_catalog";
const REASON_TOKEN_ONLY = "token_only_excluded";

const PREFIX_POLICY_TARGET_MANUFACTURERS = new Set([
  "3M Solar",
  "3M Fasara",
  "Madico",
  "Avery Dennison",
  "Llumar",
  "Solar Gard",
  "SOLYX",
]);
const PREFIX_POLICY_EXEMPT_MANUFACTURERS = new Set(["Security", "Vinyl"]);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
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

function parseBooleanOption(value, fallbackValue = false) {
  if (value === undefined || value === null) return fallbackValue;
  if (typeof value === "boolean") return value;
  const normalized = normalizeCollapsedLabel(value).toLowerCase();
  if (!normalized) return fallbackValue;
  if (["1", "true", "t", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean option value "${value}"`);
}

function parseEnv(filePath) {
  const result = {};
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        const next = text[index + 1];
        if (next === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      continue;
    }
    if (character === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (character === "\r") continue;
    field += character;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function toSimpleCsv(rows, headers) {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header] ?? "")).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function toPosixPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function normalizeCollapsedLabel(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function toLookup(value) {
  return normalizeCollapsedLabel(value).toLowerCase();
}

function canonicalizeManufacturerLabel(value) {
  const normalized = normalizeCollapsedLabel(value);
  const key = normalized.toLowerCase();

  if (key === "3m" || key === "3m solar") return "3M Solar";
  if (key === "3m fasara" || key === "fasara") return "3M Fasara";
  if (key === "avery" || key === "avery dennison") return "Avery Dennison";
  if (key === "llumar" || key === "llumar vista") return "Llumar";
  if (key === "solar gard" || key === "solar guard" || key === "solargard" || key === "sg") return "Solar Gard";
  if (key === "solyx" || key === "sol") return "SOLYX";
  if (key === "madico") return "Madico";
  if (key === "security") return "Security";
  if (key === "di-noc" || key === "dinoc") return "Di-Noc";
  if (key === "aswfvkool" || key === "v-kool" || key === "vkool") return "ASWFVKOOL";
  return normalized;
}

function normalizeManufacturerLookupKey(value) {
  return toLookup(canonicalizeManufacturerLabel(value));
}

function normalizeFilmLookupKey(value) {
  return toLookup(normalizeCollapsedLabel(value));
}

function canonicalizeNumericDigits(value) {
  const digitsOnly = String(value ?? "").replace(/[^0-9]/g, "");
  const withoutLeadingZeros = digitsOnly.replace(/^0+/, "");
  return withoutLeadingZeros || "0";
}

function isAveryDennisonManufacturer(value) {
  return normalizeManufacturerLookupKey(value) === normalizeManufacturerLookupKey("Avery Dennison");
}

function normalizeAveryNaturaShadeFormat(filmName) {
  const normalizedFilmName = normalizeCollapsedLabel(filmName);
  if (!normalizedFilmName) return normalizedFilmName;

  const shadeMatch = normalizedFilmName.match(/^natura\s+0*([0-9]{1,3})(.*)$/i);
  if (!shadeMatch) return normalizedFilmName;

  const shadeDigits = canonicalizeNumericDigits(shadeMatch[1]);
  const suffix = normalizeCollapsedLabel(shadeMatch[2] || "");
  if (!suffix) return `Natura ${shadeDigits}`;
  return `Natura ${shadeDigits}${suffix.startsWith("-") ? "" : " "}${suffix}`;
}

function isBareAveryNaturaFilmName(filmName) {
  return normalizeFilmLookupKey(filmName) === normalizeFilmLookupKey("Natura");
}

function inferAveryNaturaShadeFromNotes(noteSamples) {
  if (!Array.isArray(noteSamples) || noteSamples.length === 0) return "";

  const shades = new Set();
  for (const noteSample of noteSamples) {
    const text = normalizeCollapsedLabel(noteSample);
    if (!text) continue;
    for (const match of text.matchAll(/\bnatura\s*[- ]?0*([0-9]{1,3})\b/gi)) {
      const shade = canonicalizeNumericDigits(match[1] || "");
      if (!shade || shade === "0") continue;
      shades.add(shade);
    }
  }

  if (shades.size !== 1) return "";
  return `Natura ${[...shades][0]}`;
}
function manufacturerPrefixPatterns(manufacturer) {
  if (manufacturer === "3M Solar") return [/^3m\s+/i];
  if (manufacturer === "3M Fasara") return [/^3m\s+fasara\s+/i, /^fasara\s+/i, /^3m\s+/i];
  if (manufacturer === "Solar Gard") return [/^sg\s+/i, /^solar\s*guard\s+/i, /^solar\s+gard\s+/i, /^solarguard\s+/i, /^solargard\s+/i];
  if (manufacturer === "Llumar") return [/^llumar\s+vista\s+/i, /^llumarvista\s+/i, /^llumar\s+/i];
  if (manufacturer === "Avery Dennison") return [/^avery\s+dennison\s+/i, /^avery\s+/i, /^ad\s+/i];
  if (manufacturer === "SOLYX") return [/^solyx\s+/i, /^sol\s+/i];
  if (manufacturer === "Madico") return [/^madico\s+/i];
  if (manufacturer === "Security") return [/^security\s+/i];
  return [];
}

function stripManufacturerPrefixes(manufacturer, filmName) {
  let value = normalizeCollapsedLabel(filmName);
  let changed = true;
  const patterns = manufacturerPrefixPatterns(manufacturer);
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const next = normalizeCollapsedLabel(value.replace(pattern, ""));
      if (next && next !== value) {
        value = next;
        changed = true;
      }
    }
  }
  return value;
}

function shouldApplyManufacturerPrefixPolicy(manufacturer) {
  const canonicalManufacturer = canonicalizeManufacturerLabel(manufacturer);
  if (!canonicalManufacturer) return false;
  if (PREFIX_POLICY_EXEMPT_MANUFACTURERS.has(canonicalManufacturer)) return false;
  return PREFIX_POLICY_TARGET_MANUFACTURERS.has(canonicalManufacturer);
}

function normalizeFilmNameByManufacturerPrefixPolicy(manufacturer, filmName) {
  const canonicalManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizeCollapsedLabel(filmName);
  if (!normalizedFilmName) return normalizedFilmName;
  if (!shouldApplyManufacturerPrefixPolicy(canonicalManufacturer)) return normalizedFilmName;

  const stripped = stripManufacturerPrefixes(canonicalManufacturer, normalizedFilmName);
  if (!stripped) return normalizedFilmName;
  if (normalizeFilmLookupKey(stripped) === normalizeFilmLookupKey(normalizedFilmName)) {
    return normalizedFilmName;
  }
  return stripped;
}

function cleanVariantText(rawText) {
  return normalizeCollapsedLabel(
    String(rawText ?? "")
      .replace(/["'`]/g, " ")
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\bexterior\b/gi, "ext")
      .replace(/\((.*?)\)/g, " ")
      .replace(/\[(.*?)\]/g, " ")
      .replace(/\s*[-|/]\s*/g, " "),
  );
}

function toFingerprint(rawText) {
  return cleanVariantText(rawText).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function addFingerprint(set, rawText) {
  const fingerprint = toFingerprint(rawText);
  if (fingerprint) set.add(fingerprint);
}

function buildFingerprints(manufacturer, rawFilmName) {
  const fingerprints = new Set();
  const base = normalizeCollapsedLabel(rawFilmName);
  if (!base) return fingerprints;

  addFingerprint(fingerprints, base);
  const withoutPrefix = stripManufacturerPrefixes(manufacturer, base);
  if (withoutPrefix && withoutPrefix !== base) addFingerprint(fingerprints, withoutPrefix);

  const withoutLeadingDigits = normalizeCollapsedLabel(base.replace(/^\d+\s+/, ""));
  if (withoutLeadingDigits && withoutLeadingDigits !== base) {
    addFingerprint(fingerprints, withoutLeadingDigits);
    addFingerprint(fingerprints, stripManufacturerPrefixes(manufacturer, withoutLeadingDigits));
  }

  const splitAtMetadata = normalizeCollapsedLabel(base.split("  ")[0]);
  if (splitAtMetadata && splitAtMetadata !== base) {
    addFingerprint(fingerprints, splitAtMetadata);
  }

  return fingerprints;
}

function tokenFromMatch(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function extractModelTokens(rawFilmName) {
  const text = normalizeCollapsedLabel(rawFilmName).toUpperCase();
  const tokens = new Set();

  const add = (value) => {
    const token = tokenFromMatch(value);
    if (!token || token.length < 4 || !/\d/.test(token)) return;
    tokens.add(token);
  };

  for (const match of text.matchAll(/\b(?:SH|SX|SXC|SXR|SXP|SXJ|SXWF|SXD|SXF|SXSC|SXL|SXMD|SXWV|SXO|SXSG|SXGF)[A-Z0-9-]*\b/g)) add(match[0]);
  for (const match of text.matchAll(/\bPR\s*-?\s*(\d{1,3})(\s*EXT)?\b/g)) add(`PR${match[1]}${match[2] ? "EXT" : ""}`);
  for (const match of text.matchAll(/\bNV\s*-?\s*(\d{1,3})\b/g)) add(`NV${match[1]}`);
  for (const match of text.matchAll(/\bAG\s*-?\s*(\d{1,3})\b/g)) add(`AG${match[1]}`);
  for (const match of text.matchAll(/\bV\s*-?\s*(\d{2,3})\b/g)) add(`V${match[1]}`);
  for (const match of text.matchAll(/\bNRM[VW]?\s*PS?\s*\d+\b/g)) add(match[0]);
  for (const match of text.matchAll(/\bN\d{3,4}[A-Z]?\b/g)) add(match[0]);
  for (const match of text.matchAll(/\bDX\s*-?\s*\d{1,3}\b/g)) add(match[0]);

  return tokens;
}

function intersectSets(left, right) {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function parseHarvestedCatalog(catalogCsvPath) {
  const rows = parseCsv(fs.readFileSync(catalogCsvPath, "utf8"));
  if (!rows.length) throw new Error(`Catalog CSV is empty: ${catalogCsvPath}`);

  const header = rows[0].map((entry, index) => (index === 0 ? entry.replace(/^\uFEFF/, "") : entry));
  const manufacturerIndex = header.indexOf("manufacturer");
  const filmNameIndex = header.indexOf("film_name");
  if (manufacturerIndex === -1 || filmNameIndex === -1) {
    throw new Error(`Catalog CSV must include manufacturer and film_name columns: ${catalogCsvPath}`);
  }

  const deduped = new Map();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const manufacturer = canonicalizeManufacturerLabel(row[manufacturerIndex] ?? "");
    const rawFilmName = normalizeCollapsedLabel(row[filmNameIndex] ?? "");
    const filmName = normalizeFilmNameByManufacturerPrefixPolicy(manufacturer, rawFilmName);
    if (!manufacturer || !filmName) continue;

    const key = `${normalizeManufacturerLookupKey(manufacturer)}|${normalizeFilmLookupKey(filmName)}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        manufacturer,
        film_name: filmName,
        manufacturer_lookup_key: normalizeManufacturerLookupKey(manufacturer),
        film_lookup_key: normalizeFilmLookupKey(filmName),
      });
    }
  }

  const entries = [...deduped.values()].map((entry) => ({
    ...entry,
    fingerprints: buildFingerprints(entry.manufacturer, entry.film_name),
    model_tokens: extractModelTokens(entry.film_name),
  }));

  const byManufacturer = new Map();
  for (const entry of entries) {
    if (!byManufacturer.has(entry.manufacturer)) byManufacturer.set(entry.manufacturer, []);
    byManufacturer.get(entry.manufacturer).push(entry);
  }

  return { entries, byManufacturer };
}

async function loadBoxCombos(client, orgId) {
  const { rows } = await client.query(
    `
      select
        manufacturer,
        film_name,
        count(*)::int as box_count,
        array_remove(array_agg(distinct nullif(notes, '')), null) as note_samples
      from app.boxes
      where org_id = $1::uuid
      group by manufacturer, film_name
      order by manufacturer asc, film_name asc
    `,
    [orgId],
  );

  return rows.map((row) => ({
    manufacturer: normalizeCollapsedLabel(row.manufacturer),
    film_name: normalizeCollapsedLabel(row.film_name),
    box_count: Number(row.box_count || 0),
    note_samples: Array.isArray(row.note_samples) ? row.note_samples.map((value) => normalizeCollapsedLabel(value)) : [],
  }));
}

async function loadSupplementalCombosFromRelatedTables(client, orgId) {
  const { rows } = await client.query(
    `
      with source_rows as (
        select manufacturer, film_name, notes from app.film_catalog where org_id = $1::uuid
        union all
        select manufacturer, film_name, notes from app.job_requirements where org_id = $1::uuid
        union all
        select manufacturer, film_name, notes from app.film_orders where org_id = $1::uuid
        union all
        select manufacturer, film_name, notes from app.roll_weight_log where org_id = $1::uuid
      )
      select
        manufacturer,
        film_name,
        count(*)::int as source_row_count,
        array_remove(array_agg(distinct nullif(notes, '')), null) as note_samples
      from source_rows
      group by manufacturer, film_name
      order by manufacturer asc, film_name asc
    `,
    [orgId],
  );

  return rows.map((row) => ({
    manufacturer: normalizeCollapsedLabel(row.manufacturer),
    film_name: normalizeCollapsedLabel(row.film_name),
    source_row_count: Number(row.source_row_count || 0),
    note_samples: Array.isArray(row.note_samples) ? row.note_samples.map((value) => normalizeCollapsedLabel(value)) : [],
  }));
}

async function buildSupplementalPrefixPolicyMappings(client, orgId, existingMappings) {
  const existingKeys = new Set((existingMappings || []).map((row) => row.mapping_key));
  const supplementalRows = await loadSupplementalCombosFromRelatedTables(client, orgId);
  const supplementalMappings = [];

  for (const row of supplementalRows) {
    const canonicalManufacturer = canonicalizeManufacturerLabel(row.manufacturer);
    const oldFilmName = normalizeCollapsedLabel(row.film_name);
    if (!canonicalManufacturer || !oldFilmName) continue;

    const canonicalFilmName = normalizeFilmNameByManufacturerPrefixPolicy(canonicalManufacturer, oldFilmName);
    if (!canonicalFilmName) continue;
    if (normalizeFilmLookupKey(canonicalFilmName) === normalizeFilmLookupKey(oldFilmName)) continue;

    const manufacturerLookupKey = normalizeManufacturerLookupKey(canonicalManufacturer);
    const oldFilmLookupKey = normalizeFilmLookupKey(oldFilmName);
    const mappingKey = `${manufacturerLookupKey}|${oldFilmLookupKey}`;
    if (existingKeys.has(mappingKey)) continue;

    const mapping = {
      mapping_key: mappingKey,
      old_manufacturer: canonicalManufacturer,
      old_manufacturer_lookup_key: manufacturerLookupKey,
      old_film_name: oldFilmName,
      old_film_name_lookup_key: oldFilmLookupKey,
      canonical_manufacturer: canonicalManufacturer,
      canonical_manufacturer_lookup_key: manufacturerLookupKey,
      canonical_film_name: canonicalFilmName,
      canonical_film_lookup_key: normalizeFilmLookupKey(canonicalFilmName),
      reason: REASON_PREFIX_POLICY,
      confidence: CONFIDENCE_HIGH,
      box_count: Number(row.source_row_count || 0),
    };

    supplementalMappings.push(mapping);
    existingKeys.add(mappingKey);
  }

  return supplementalMappings;
}

async function buildSupplementalAveryNaturaPolicyMappings(client, orgId, existingMappings) {
  const existingKeys = new Set((existingMappings || []).map((row) => row.mapping_key));
  const supplementalRows = await loadSupplementalCombosFromRelatedTables(client, orgId);
  const supplementalMappings = [];

  for (const row of supplementalRows) {
    const canonicalManufacturer = canonicalizeManufacturerLabel(row.manufacturer);
    const oldFilmName = normalizeCollapsedLabel(row.film_name);
    if (!canonicalManufacturer || !oldFilmName) continue;
    if (!isAveryDennisonManufacturer(canonicalManufacturer)) continue;

    const manufacturerLookupKey = normalizeManufacturerLookupKey(canonicalManufacturer);
    const oldFilmLookupKey = normalizeFilmLookupKey(oldFilmName);
    const mappingKey = `${manufacturerLookupKey}|${oldFilmLookupKey}`;
    if (existingKeys.has(mappingKey)) continue;

    const normalizedShadeName = normalizeAveryNaturaShadeFormat(oldFilmName);
    if (
      normalizedShadeName
      && normalizeFilmLookupKey(normalizedShadeName) !== normalizeFilmLookupKey(oldFilmName)
    ) {
      const mapping = {
        mapping_key: mappingKey,
        old_manufacturer: canonicalManufacturer,
        old_manufacturer_lookup_key: manufacturerLookupKey,
        old_film_name: oldFilmName,
        old_film_name_lookup_key: oldFilmLookupKey,
        canonical_manufacturer: canonicalManufacturer,
        canonical_manufacturer_lookup_key: manufacturerLookupKey,
        canonical_film_name: normalizedShadeName,
        canonical_film_lookup_key: normalizeFilmLookupKey(normalizedShadeName),
        reason: REASON_AVERY_NATURA_SHADE_FORMAT,
        confidence: CONFIDENCE_HIGH,
        box_count: Number(row.source_row_count || 0),
      };
      supplementalMappings.push(mapping);
      existingKeys.add(mappingKey);
      continue;
    }

    if (!isBareAveryNaturaFilmName(oldFilmName)) continue;
    const inferredShade = inferAveryNaturaShadeFromNotes(row.note_samples || []);
    if (!inferredShade) continue;

    const mapping = {
      mapping_key: mappingKey,
      old_manufacturer: canonicalManufacturer,
      old_manufacturer_lookup_key: manufacturerLookupKey,
      old_film_name: oldFilmName,
      old_film_name_lookup_key: oldFilmLookupKey,
      canonical_manufacturer: canonicalManufacturer,
      canonical_manufacturer_lookup_key: manufacturerLookupKey,
      canonical_film_name: inferredShade,
      canonical_film_lookup_key: normalizeFilmLookupKey(inferredShade),
      reason: REASON_AVERY_NATURA_INFERRED_SHADE,
      confidence: CONFIDENCE_HIGH,
      box_count: Number(row.source_row_count || 0),
    };

    supplementalMappings.push(mapping);
    existingKeys.add(mappingKey);
  }

  return supplementalMappings;
}
function classifyBoxLabels(boxRows, harvestedCatalogByManufacturer, options = {}) {
  const includeTokenOnlyUnique = Boolean(options.includeTokenOnlyUnique);
  const includeManufacturerPrefixPolicy = options.includeManufacturerPrefixPolicy !== false;
  const includeAveryNaturaShadePolicy = options.includeAveryNaturaShadePolicy !== false;
  const classifications = [];
  const renameMappings = [];

  for (const row of boxRows) {
    const canonicalManufacturer = canonicalizeManufacturerLabel(row.manufacturer);
    const sourceFilmName = normalizeCollapsedLabel(row.film_name);
    const sourceLookupKey = normalizeFilmLookupKey(sourceFilmName);
    const sourceManufacturerLookupKey = normalizeManufacturerLookupKey(canonicalManufacturer);
    const noteSamples = Array.isArray(row.note_samples) ? row.note_samples : [];

    if (includeAveryNaturaShadePolicy && isAveryDennisonManufacturer(canonicalManufacturer)) {
      const normalizedShadeName = normalizeAveryNaturaShadeFormat(sourceFilmName);
      if (
        normalizedShadeName
        && normalizeFilmLookupKey(normalizedShadeName) !== normalizeFilmLookupKey(sourceFilmName)
      ) {
        renameMappings.push({
          mapping_key: `${sourceManufacturerLookupKey}|${sourceLookupKey}`,
          old_manufacturer: canonicalManufacturer,
          old_manufacturer_lookup_key: sourceManufacturerLookupKey,
          old_film_name: sourceFilmName,
          old_film_name_lookup_key: sourceLookupKey,
          canonical_manufacturer: canonicalManufacturer,
          canonical_manufacturer_lookup_key: sourceManufacturerLookupKey,
          canonical_film_name: normalizedShadeName,
          canonical_film_lookup_key: normalizeFilmLookupKey(normalizedShadeName),
          reason: REASON_AVERY_NATURA_SHADE_FORMAT,
          confidence: CONFIDENCE_HIGH,
          box_count: row.box_count,
        });
        classifications.push({
          old_manufacturer: row.manufacturer,
          old_film_name: sourceFilmName,
          canonical_manufacturer: canonicalManufacturer,
          new_film_name: normalizedShadeName,
          reason: REASON_AVERY_NATURA_SHADE_FORMAT,
          confidence: CONFIDENCE_HIGH,
          box_count: row.box_count,
          candidate_count: 1,
          candidate_examples: normalizedShadeName,
        });
        continue;
      }

      if (isBareAveryNaturaFilmName(sourceFilmName)) {
        const inferredShade = inferAveryNaturaShadeFromNotes(noteSamples);
        if (inferredShade) {
          renameMappings.push({
            mapping_key: `${sourceManufacturerLookupKey}|${sourceLookupKey}`,
            old_manufacturer: canonicalManufacturer,
            old_manufacturer_lookup_key: sourceManufacturerLookupKey,
            old_film_name: sourceFilmName,
            old_film_name_lookup_key: sourceLookupKey,
            canonical_manufacturer: canonicalManufacturer,
            canonical_manufacturer_lookup_key: sourceManufacturerLookupKey,
            canonical_film_name: inferredShade,
            canonical_film_lookup_key: normalizeFilmLookupKey(inferredShade),
            reason: REASON_AVERY_NATURA_INFERRED_SHADE,
            confidence: CONFIDENCE_HIGH,
            box_count: row.box_count,
          });
          classifications.push({
            old_manufacturer: row.manufacturer,
            old_film_name: sourceFilmName,
            canonical_manufacturer: canonicalManufacturer,
            new_film_name: inferredShade,
            reason: REASON_AVERY_NATURA_INFERRED_SHADE,
            confidence: CONFIDENCE_HIGH,
            box_count: row.box_count,
            candidate_count: 1,
            candidate_examples: inferredShade,
          });
        } else {
          classifications.push({
            old_manufacturer: row.manufacturer,
            old_film_name: sourceFilmName,
            canonical_manufacturer: canonicalManufacturer,
            new_film_name: "",
            reason: REASON_AVERY_NATURA_MISSING_SHADE,
            confidence: "",
            box_count: row.box_count,
            candidate_count: 0,
            candidate_examples: "",
          });
        }
        continue;
      }
    }

    const catalogEntries = harvestedCatalogByManufacturer.get(canonicalManufacturer) || [];
    if (!catalogEntries.length) {
      classifications.push({
        old_manufacturer: row.manufacturer,
        old_film_name: sourceFilmName,
        canonical_manufacturer: canonicalManufacturer,
        new_film_name: "",
        reason: REASON_NO_MANUFACTURER,
        confidence: "",
        box_count: row.box_count,
        candidate_count: 0,
        candidate_examples: "",
      });
      continue;
    }

    const exactMatch = catalogEntries.find((entry) => entry.film_lookup_key === sourceLookupKey);
    if (exactMatch) {
      classifications.push({
        old_manufacturer: row.manufacturer,
        old_film_name: sourceFilmName,
        canonical_manufacturer: canonicalManufacturer,
        new_film_name: exactMatch.film_name,
        reason: REASON_EXACT,
        confidence: CONFIDENCE_HIGH,
        box_count: row.box_count,
        candidate_count: 1,
        candidate_examples: exactMatch.film_name,
      });
      continue;
    }

    const sourceFingerprints = buildFingerprints(canonicalManufacturer, sourceFilmName);
    const fingerprintMatches = [];
    for (const entry of catalogEntries) {
      if (intersectSets(sourceFingerprints, entry.fingerprints)) {
        fingerprintMatches.push(entry);
      }
    }

    if (fingerprintMatches.length === 1) {
      const target = fingerprintMatches[0];
      renameMappings.push({
        mapping_key: `${sourceManufacturerLookupKey}|${sourceLookupKey}`,
        old_manufacturer: canonicalManufacturer,
        old_manufacturer_lookup_key: sourceManufacturerLookupKey,
        old_film_name: sourceFilmName,
        old_film_name_lookup_key: sourceLookupKey,
        canonical_manufacturer: canonicalManufacturer,
        canonical_manufacturer_lookup_key: sourceManufacturerLookupKey,
        canonical_film_name: target.film_name,
        canonical_film_lookup_key: target.film_lookup_key,
        reason: REASON_FP_UNIQUE,
        confidence: CONFIDENCE_HIGH,
        box_count: row.box_count,
      });

      classifications.push({
        old_manufacturer: row.manufacturer,
        old_film_name: sourceFilmName,
        canonical_manufacturer: canonicalManufacturer,
        new_film_name: target.film_name,
        reason: REASON_FP_UNIQUE,
        confidence: CONFIDENCE_HIGH,
        box_count: row.box_count,
        candidate_count: 1,
        candidate_examples: target.film_name,
      });
      continue;
    }

    if (fingerprintMatches.length > 1) {
      classifications.push({
        old_manufacturer: row.manufacturer,
        old_film_name: sourceFilmName,
        canonical_manufacturer: canonicalManufacturer,
        new_film_name: "",
        reason: REASON_AMBIGUOUS,
        confidence: "",
        box_count: row.box_count,
        candidate_count: fingerprintMatches.length,
        candidate_examples: fingerprintMatches.slice(0, 5).map((entry) => entry.film_name).join(" | "),
      });
      continue;
    }

    const sourceTokens = extractModelTokens(sourceFilmName);
    if (sourceTokens.size) {
      const tokenMatches = [];
      for (const entry of catalogEntries) {
        if (intersectSets(sourceTokens, entry.model_tokens)) tokenMatches.push(entry);
      }
      if (tokenMatches.length > 0) {
        if (tokenMatches.length === 1 && includeTokenOnlyUnique) {
          const target = tokenMatches[0];
          renameMappings.push({
            mapping_key: `${sourceManufacturerLookupKey}|${sourceLookupKey}`,
            old_manufacturer: canonicalManufacturer,
            old_manufacturer_lookup_key: sourceManufacturerLookupKey,
            old_film_name: sourceFilmName,
            old_film_name_lookup_key: sourceLookupKey,
            canonical_manufacturer: canonicalManufacturer,
            canonical_manufacturer_lookup_key: sourceManufacturerLookupKey,
            canonical_film_name: target.film_name,
            canonical_film_lookup_key: target.film_lookup_key,
            reason: REASON_TOKEN_UNIQUE,
            confidence: CONFIDENCE_HIGH,
            box_count: row.box_count,
          });

          classifications.push({
            old_manufacturer: row.manufacturer,
            old_film_name: sourceFilmName,
            canonical_manufacturer: canonicalManufacturer,
            new_film_name: target.film_name,
            reason: REASON_TOKEN_UNIQUE,
            confidence: CONFIDENCE_HIGH,
            box_count: row.box_count,
            candidate_count: 1,
            candidate_examples: target.film_name,
          });
          continue;
        }

        classifications.push({
          old_manufacturer: row.manufacturer,
          old_film_name: sourceFilmName,
          canonical_manufacturer: canonicalManufacturer,
          new_film_name: "",
          reason: tokenMatches.length === 1 ? REASON_TOKEN_ONLY : REASON_AMBIGUOUS,
          confidence: "",
          box_count: row.box_count,
          candidate_count: tokenMatches.length,
          candidate_examples: tokenMatches.slice(0, 5).map((entry) => entry.film_name).join(" | "),
        });
        continue;
      }
    }

    classifications.push({
      old_manufacturer: row.manufacturer,
      old_film_name: sourceFilmName,
      canonical_manufacturer: canonicalManufacturer,
      new_film_name: "",
      reason: REASON_NO_MATCH,
      confidence: "",
      box_count: row.box_count,
      candidate_count: 0,
      candidate_examples: "",
    });
  }

  const dedupedMappings = new Map();
  for (const mapping of renameMappings) {
    if (!dedupedMappings.has(mapping.mapping_key)) {
      dedupedMappings.set(mapping.mapping_key, mapping);
    }
  }

  if (includeManufacturerPrefixPolicy) {
    for (const row of classifications) {
      const canonicalManufacturer = canonicalizeManufacturerLabel(row.canonical_manufacturer || row.old_manufacturer);
      const oldFilmName = normalizeCollapsedLabel(row.old_film_name);
      if (!canonicalManufacturer || !oldFilmName) continue;

      const normalizedByPolicy = normalizeFilmNameByManufacturerPrefixPolicy(canonicalManufacturer, oldFilmName);
      if (!normalizedByPolicy) continue;
      if (normalizeFilmLookupKey(normalizedByPolicy) === normalizeFilmLookupKey(oldFilmName)) continue;

      const sourceManufacturerLookupKey = normalizeManufacturerLookupKey(canonicalManufacturer);
      const sourceLookupKey = normalizeFilmLookupKey(oldFilmName);
      const mappingKey = `${sourceManufacturerLookupKey}|${sourceLookupKey}`;
      if (dedupedMappings.has(mappingKey)) continue;

      dedupedMappings.set(mappingKey, {
        mapping_key: mappingKey,
        old_manufacturer: canonicalManufacturer,
        old_manufacturer_lookup_key: sourceManufacturerLookupKey,
        old_film_name: oldFilmName,
        old_film_name_lookup_key: sourceLookupKey,
        canonical_manufacturer: canonicalManufacturer,
        canonical_manufacturer_lookup_key: sourceManufacturerLookupKey,
        canonical_film_name: normalizedByPolicy,
        canonical_film_lookup_key: normalizeFilmLookupKey(normalizedByPolicy),
        reason: REASON_PREFIX_POLICY,
        confidence: CONFIDENCE_HIGH,
        box_count: Number(row.box_count || 0),
      });

      row.new_film_name = normalizedByPolicy;
      row.reason = REASON_PREFIX_POLICY;
      row.confidence = CONFIDENCE_HIGH;
      row.candidate_count = 1;
      row.candidate_examples = normalizedByPolicy;
    }
  }

  return {
    classifications,
    renameMappings: [...dedupedMappings.values()],
  };
}

function summarizeClassifications(classifications) {
  const summary = {
    distinct_labels_total: classifications.length,
    box_rows_total: 0,
    by_reason: {},
  };

  for (const row of classifications) {
    const reason = row.reason || REASON_NO_MATCH;
    if (!Object.prototype.hasOwnProperty.call(summary.by_reason, reason)) {
      summary.by_reason[reason] = { distinct_labels: 0, box_rows: 0 };
    }
    summary.by_reason[reason].distinct_labels += 1;
    summary.by_reason[reason].box_rows += Number(row.box_count || 0);
    summary.box_rows_total += Number(row.box_count || 0);
  }

  return summary;
}

async function createTempApprovedMappings(client, mappings) {
  await client.query("drop table if exists tmp_harvested_film_name_mapping");
  await client.query(`
    create temporary table tmp_harvested_film_name_mapping (
      mapping_key text not null,
      old_manufacturer_lookup_key text not null,
      old_film_name_lookup_key text not null,
      canonical_manufacturer text not null,
      canonical_manufacturer_lookup_key text not null,
      canonical_film_name text not null
    ) on commit drop
  `);

  if (!mappings.length) return;

  const values = [];
  const placeholders = [];
  for (let index = 0; index < mappings.length; index += 1) {
    const row = mappings[index];
    const offset = index * 6;
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`);
    values.push(
      row.mapping_key,
      row.old_manufacturer_lookup_key,
      row.old_film_name_lookup_key,
      row.canonical_manufacturer,
      row.canonical_manufacturer_lookup_key,
      row.canonical_film_name,
    );
  }

  await client.query(
    `
      insert into tmp_harvested_film_name_mapping (
        mapping_key,
        old_manufacturer_lookup_key,
        old_film_name_lookup_key,
        canonical_manufacturer,
        canonical_manufacturer_lookup_key,
        canonical_film_name
      )
      values ${placeholders.join(",\n")}
    `,
    values,
  );
}

async function queryInt(client, sql, params = []) {
  const { rows } = await client.query(sql, params);
  return Number(rows[0]?.count ?? rows[0]?.value ?? 0);
}

async function buildPreflight(client, orgId, approvedMappings) {
  await createTempApprovedMappings(client, approvedMappings);

  const candidateUpdates = {
    boxes: 0,
    film_catalog: 0,
    film_catalog_missing_upserts: 0,
    job_requirements: 0,
    film_orders: 0,
    roll_weight_log: 0,
  };

  if (!approvedMappings.length) {
    return {
      approved_mapping_count: 0,
      candidate_updates: candidateUpdates,
      preflight_blockers: {
        film_catalog_key_collisions: [],
        job_requirement_lookup_collisions: [],
      },
    };
  }

  candidateUpdates.boxes = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.boxes b
      join tmp_harvested_film_name_mapping m
        on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(b.manufacturer)
       and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(b.film_name)
      where b.org_id = $1::uuid
        and (
          app_api.normalize_catalog_manufacturer_lookup_key(b.manufacturer)
            is distinct from m.canonical_manufacturer_lookup_key
          or app_api.normalize_catalog_lookup_key(b.film_name)
            is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
        )
    `,
    [orgId],
  );
  candidateUpdates.film_catalog = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.film_catalog f
      join tmp_harvested_film_name_mapping m
        on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(f.manufacturer)
       and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(f.film_name)
      where f.org_id = $1::uuid
        and (
          app_api.normalize_catalog_manufacturer_lookup_key(f.manufacturer)
            is distinct from m.canonical_manufacturer_lookup_key
          or app_api.normalize_catalog_lookup_key(f.film_name)
            is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
        )
    `,
    [orgId],
  );

  candidateUpdates.film_catalog_missing_upserts = await queryInt(
    client,
    `
      with canonical_targets as (
        select distinct
          m.canonical_manufacturer as manufacturer,
          m.canonical_film_name as film_name,
          upper(app_api.canonical_manufacturer_label(m.canonical_manufacturer))
            || '|'
            || upper(m.canonical_film_name) as film_key
        from tmp_harvested_film_name_mapping m
      )
      select count(*)::int as count
      from canonical_targets t
      left join app.film_catalog f
        on f.org_id = $1::uuid
       and f.film_key = t.film_key
      where f.id is null
    `,
    [orgId],
  );

  candidateUpdates.job_requirements = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.job_requirements r
      join tmp_harvested_film_name_mapping m
        on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(r.manufacturer)
       and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(r.film_name)
      where r.org_id = $1::uuid
        and (
          app_api.normalize_catalog_manufacturer_lookup_key(r.manufacturer)
            is distinct from m.canonical_manufacturer_lookup_key
          or app_api.normalize_catalog_lookup_key(r.film_name)
            is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
        )
    `,
    [orgId],
  );

  candidateUpdates.film_orders = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.film_orders o
      join tmp_harvested_film_name_mapping m
        on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(o.manufacturer)
       and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(o.film_name)
      where o.org_id = $1::uuid
        and (
          app_api.normalize_catalog_manufacturer_lookup_key(o.manufacturer)
            is distinct from m.canonical_manufacturer_lookup_key
          or app_api.normalize_catalog_lookup_key(o.film_name)
            is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
        )
    `,
    [orgId],
  );

  candidateUpdates.roll_weight_log = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.roll_weight_log l
      join tmp_harvested_film_name_mapping m
        on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(l.manufacturer)
       and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(l.film_name)
      where l.org_id = $1::uuid
        and (
          app_api.normalize_catalog_manufacturer_lookup_key(l.manufacturer)
            is distinct from m.canonical_manufacturer_lookup_key
          or app_api.normalize_catalog_lookup_key(l.film_name)
            is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
        )
    `,
    [orgId],
  );

  const filmCatalogCollisionsRes = await client.query(
    `
      with mapped as (
        select
          f.id,
          f.film_key as old_film_key,
          coalesce(m.canonical_manufacturer, app_api.canonical_manufacturer_label(f.manufacturer)) as canonical_manufacturer,
          coalesce(m.canonical_film_name, app_api.normalize_collapsed_catalog_label(f.film_name)) as canonical_film_name,
          upper(coalesce(m.canonical_manufacturer, app_api.canonical_manufacturer_label(f.manufacturer)))
            || '|'
            || upper(coalesce(m.canonical_film_name, app_api.normalize_collapsed_catalog_label(f.film_name))) as canonical_film_key
        from app.film_catalog f
        left join tmp_harvested_film_name_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(f.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(f.film_name)
        where f.org_id = $1::uuid
      )
      select
        canonical_film_key,
        count(*)::int as row_count,
        array_agg(old_film_key order by old_film_key) as source_film_keys
      from mapped
      group by canonical_film_key
      having count(*) > 1
      order by row_count desc, canonical_film_key asc
    `,
    [orgId],
  );

  const requirementCollisionRes = await client.query(
    `
      with mapped as (
        select
          r.id,
          r.job_id,
          coalesce(j.job_number, '') as job_number,
          m.canonical_manufacturer_lookup_key,
          app_api.normalize_catalog_lookup_key(m.canonical_film_name) as canonical_film_lookup_key,
          round(coalesce(r.width_in, 0)::numeric, 4)::text as width_key
        from app.job_requirements r
        left join app.jobs j
          on j.org_id = r.org_id
         and j.id = r.job_id
        join tmp_harvested_film_name_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(r.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(r.film_name)
        where r.org_id = $1::uuid
      ),
      grouped as (
        select
          m.job_id,
          m.job_number,
          m.canonical_manufacturer_lookup_key || '|' || m.canonical_film_lookup_key || '|' || m.width_key as canonical_lookup_key,
          count(*)::int as row_count,
          array_agg(m.id order by m.id) as source_requirement_ids
        from mapped m
        group by m.job_id, m.job_number, canonical_lookup_key
      )
      select job_id, job_number, canonical_lookup_key, row_count, source_requirement_ids
      from grouped
      where row_count > 1
      order by row_count desc, job_number asc, canonical_lookup_key asc
    `,
    [orgId],
  );

  return {
    approved_mapping_count: approvedMappings.length,
    candidate_updates: candidateUpdates,
    preflight_blockers: {
      film_catalog_key_collisions: filmCatalogCollisionsRes.rows,
      job_requirement_lookup_collisions: requirementCollisionRes.rows,
    },
  };
}

async function runApply(client, orgId, actor, approvedMappings) {
  await createTempApprovedMappings(client, approvedMappings);

  const updates = {
    aliases_upserted: 0,
    boxes: 0,
    film_catalog: 0,
    film_catalog_missing_upserts: 0,
    job_requirements: 0,
    film_orders: 0,
    roll_weight_log: 0,
  };

  if (!approvedMappings.length) return updates;

  const aliasUpsert = await client.query(
    `
      insert into app.film_name_aliases (
        org_id, manufacturer_lookup_key, old_film_name_lookup_key, canonical_film_name, created_by, updated_by
      )
      select
        $1::uuid,
        m.canonical_manufacturer_lookup_key,
        m.old_film_name_lookup_key,
        m.canonical_film_name,
        $2,
        $2
      from tmp_harvested_film_name_mapping m
      where app_api.normalize_catalog_lookup_key(m.canonical_film_name) <> m.old_film_name_lookup_key
      on conflict (org_id, manufacturer_lookup_key, old_film_name_lookup_key) do update set
        canonical_film_name = excluded.canonical_film_name,
        updated_at = now(),
        updated_by = excluded.updated_by
    `,
    [orgId, actor],
  );
  updates.aliases_upserted = aliasUpsert.rowCount ?? 0;

  const updateRows = [
    {
      key: "boxes",
      sql: `
        with candidates as (
          select b.id, m.canonical_manufacturer, m.canonical_film_name
          from app.boxes b
          join tmp_harvested_film_name_mapping m
            on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(b.manufacturer)
           and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(b.film_name)
          where b.org_id = $1::uuid
            and (
              app_api.normalize_catalog_manufacturer_lookup_key(b.manufacturer) is distinct from m.canonical_manufacturer_lookup_key
              or app_api.normalize_catalog_lookup_key(b.film_name) is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
            )
        )
        update app.boxes b
        set manufacturer = c.canonical_manufacturer,
            film_name = c.canonical_film_name,
            film_key = upper(app_api.canonical_manufacturer_label(c.canonical_manufacturer)) || '|' || upper(c.canonical_film_name),
            updated_at = now()
        from candidates c
        where b.id = c.id
      `,
      params: [orgId],
    },
    {
      key: "film_catalog",
      sql: `
        with candidates as (
          select f.id, m.canonical_manufacturer, m.canonical_film_name
          from app.film_catalog f
          join tmp_harvested_film_name_mapping m
            on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(f.manufacturer)
           and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(f.film_name)
          where f.org_id = $1::uuid
            and (
              app_api.normalize_catalog_manufacturer_lookup_key(f.manufacturer) is distinct from m.canonical_manufacturer_lookup_key
              or app_api.normalize_catalog_lookup_key(f.film_name) is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
            )
        )
        update app.film_catalog f
        set manufacturer = c.canonical_manufacturer,
            film_name = c.canonical_film_name,
            film_key = upper(app_api.canonical_manufacturer_label(c.canonical_manufacturer)) || '|' || upper(c.canonical_film_name),
            updated_at = now()
        from candidates c
        where f.id = c.id
      `,
      params: [orgId],
    },
    {
      key: "job_requirements",
      sql: `
        with candidates as (
          select r.id, m.canonical_manufacturer, m.canonical_film_name
          from app.job_requirements r
          join tmp_harvested_film_name_mapping m
            on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(r.manufacturer)
           and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(r.film_name)
          where r.org_id = $1::uuid
            and (
              app_api.normalize_catalog_manufacturer_lookup_key(r.manufacturer) is distinct from m.canonical_manufacturer_lookup_key
              or app_api.normalize_catalog_lookup_key(r.film_name) is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
            )
        )
        update app.job_requirements r
        set manufacturer = c.canonical_manufacturer,
            film_name = c.canonical_film_name,
            updated_at = now(),
            updated_by = $2
        from candidates c
        where r.id = c.id
      `,
      params: [orgId, actor],
    },
    {
      key: "film_orders",
      sql: `
        with candidates as (
          select o.id, m.canonical_manufacturer, m.canonical_film_name
          from app.film_orders o
          join tmp_harvested_film_name_mapping m
            on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(o.manufacturer)
           and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(o.film_name)
          where o.org_id = $1::uuid
            and (
              app_api.normalize_catalog_manufacturer_lookup_key(o.manufacturer) is distinct from m.canonical_manufacturer_lookup_key
              or app_api.normalize_catalog_lookup_key(o.film_name) is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
            )
        )
        update app.film_orders o
        set manufacturer = c.canonical_manufacturer,
            film_name = c.canonical_film_name
        from candidates c
        where o.id = c.id
      `,
      params: [orgId],
    },
    {
      key: "roll_weight_log",
      sql: `
        with candidates as (
          select l.id, m.canonical_manufacturer, m.canonical_film_name
          from app.roll_weight_log l
          join tmp_harvested_film_name_mapping m
            on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(l.manufacturer)
           and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(l.film_name)
          where l.org_id = $1::uuid
            and (
              app_api.normalize_catalog_manufacturer_lookup_key(l.manufacturer) is distinct from m.canonical_manufacturer_lookup_key
              or app_api.normalize_catalog_lookup_key(l.film_name) is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
            )
        )
        update app.roll_weight_log l
        set manufacturer = c.canonical_manufacturer,
            film_name = c.canonical_film_name
        from candidates c
        where l.id = c.id
      `,
      params: [orgId],
    },
  ];

  for (const op of updateRows) {
    const result = await client.query(op.sql, op.params);
    updates[op.key] = result.rowCount ?? 0;
  }

  const upsertMissingCatalog = await client.query(
    `
      with canonical_targets as (
        select distinct
          m.canonical_manufacturer as manufacturer,
          m.canonical_film_name as film_name,
          upper(app_api.canonical_manufacturer_label(m.canonical_manufacturer)) || '|' || upper(m.canonical_film_name) as film_key
        from tmp_harvested_film_name_mapping m
      ),
      missing as (
        select t.manufacturer, t.film_name, t.film_key
        from canonical_targets t
        left join app.film_catalog f
          on f.org_id = $1::uuid
         and f.film_key = t.film_key
        where f.id is null
      )
      insert into app.film_catalog (id, org_id, film_key, manufacturer, film_name, notes, updated_at)
      select gen_random_uuid(), $1::uuid, m.film_key, m.manufacturer, m.film_name, '', now()
      from missing m
      on conflict (org_id, film_key) do update set
        manufacturer = excluded.manufacturer,
        film_name = excluded.film_name,
        updated_at = excluded.updated_at
    `,
    [orgId],
  );
  updates.film_catalog_missing_upserts = upsertMissingCatalog.rowCount ?? 0;

  return updates;
}

function compareDateTextAscending(left, right) {
  const leftValue = normalizeCollapsedLabel(left);
  const rightValue = normalizeCollapsedLabel(right);
  if (!leftValue && !rightValue) return 0;
  if (!leftValue) return 1;
  if (!rightValue) return -1;
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

function pickFirstNonNull(rows, fieldName) {
  for (const row of rows) {
    if (row[fieldName] !== null && row[fieldName] !== undefined) return row[fieldName];
  }
  return null;
}

function parseCanonicalFilmKey(canonicalFilmKey) {
  const key = normalizeCollapsedLabel(canonicalFilmKey);
  const separator = key.indexOf("|");
  if (separator <= 0) {
    return { manufacturer: "", filmName: "" };
  }
  return {
    manufacturer: key.slice(0, separator).trim(),
    filmName: key.slice(separator + 1).trim(),
  };
}

async function mergeFilmCatalogPrefixPolicyCollisions(client, orgId, collisionGroups) {
  const mergeAudit = {
    attempted: true,
    collision_groups_detected: Number(collisionGroups?.length || 0),
    merged_groups: 0,
    merged_rows_updated: 0,
    merged_rows_deleted: 0,
    skipped_groups: [],
    merged_group_details: [],
  };

  if (!Array.isArray(collisionGroups) || collisionGroups.length === 0) {
    return mergeAudit;
  }

  for (const group of collisionGroups) {
    const canonicalFilmKey = normalizeCollapsedLabel(group.canonical_film_key);
    const sourceFilmKeys = Array.isArray(group.source_film_keys) ? group.source_film_keys : [];
    if (!canonicalFilmKey || sourceFilmKeys.length < 2) {
      mergeAudit.skipped_groups.push({
        canonical_film_key: canonicalFilmKey,
        reason: "invalid_collision_group",
      });
      continue;
    }

    const { rows } = await client.query(
      `
        select
          id,
          film_key,
          manufacturer,
          film_name,
          sq_ft_weight_lbs_per_sq_ft,
          default_core_type,
          source_width_in,
          source_initial_feet,
          source_initial_weight_lbs,
          source_box_id,
          notes,
          updated_at
        from app.film_catalog
        where org_id = $1::uuid
          and film_key = any($2::text[])
        order by updated_at asc nulls last, id asc
      `,
      [orgId, sourceFilmKeys],
    );

    if (rows.length < 2) {
      mergeAudit.skipped_groups.push({
        canonical_film_key: canonicalFilmKey,
        reason: "insufficient_rows",
      });
      continue;
    }

    const canonicalRows = rows.map((row) => {
      const canonicalManufacturer = canonicalizeManufacturerLabel(row.manufacturer);
      const normalizedByPrefixPolicy = normalizeFilmNameByManufacturerPrefixPolicy(canonicalManufacturer, row.film_name);
      const normalizedFilmName = isAveryDennisonManufacturer(canonicalManufacturer)
        ? normalizeAveryNaturaShadeFormat(normalizedByPrefixPolicy)
        : normalizedByPrefixPolicy;
      const normalizedFilmKey = `${canonicalManufacturer.toUpperCase()}|${normalizedFilmName.toUpperCase()}`;
      return {
        ...row,
        canonical_manufacturer: canonicalManufacturer,
        canonical_film_name: normalizedFilmName,
        canonical_film_key: normalizedFilmKey,
      };
    });

    const allResolveToCanonical = canonicalRows.every((row) => row.canonical_film_key === canonicalFilmKey);
    if (!allResolveToCanonical) {
      mergeAudit.skipped_groups.push({
        canonical_film_key: canonicalFilmKey,
        reason: "non_prefix_policy_collision",
      });
      continue;
    }

    const canonicalKeyParts = parseCanonicalFilmKey(canonicalFilmKey);
    let keeper =
      canonicalRows.find((row) => normalizeCollapsedLabel(row.film_key).toUpperCase() === canonicalFilmKey) || null;
    if (!keeper) {
      keeper = [...canonicalRows].sort((left, right) => {
        const updatedAtCompare = compareDateTextAscending(left.updated_at, right.updated_at);
        if (updatedAtCompare !== 0) return updatedAtCompare;
        return String(left.id).localeCompare(String(right.id), undefined, { sensitivity: "base" });
      })[0];
    }

    const rowsById = new Map(canonicalRows.map((row) => [String(row.id), row]));
    const orderedRows = [rowsById.get(String(keeper.id)), ...canonicalRows.filter((row) => String(row.id) !== String(keeper.id))].filter(Boolean);
    const removedRows = canonicalRows.filter((row) => String(row.id) !== String(keeper.id));

    const mergedNotes = [...new Set(orderedRows.map((row) => normalizeCollapsedLabel(row.notes)).filter((value) => value))]
      .join(" | ");
    const canonicalManufacturer = orderedRows[0]?.canonical_manufacturer || canonicalizeManufacturerLabel(keeper.manufacturer);
    const canonicalFilmName = orderedRows[0]?.canonical_film_name || normalizeCollapsedLabel(keeper.film_name);

    await client.query(
      `
        update app.film_catalog
        set manufacturer = $2,
            film_name = $3,
            film_key = $4,
            sq_ft_weight_lbs_per_sq_ft = $5,
            default_core_type = $6,
            source_width_in = $7,
            source_initial_feet = $8,
            source_initial_weight_lbs = $9,
            source_box_id = $10,
            notes = $11,
            updated_at = now()
        where org_id = $1::uuid
          and id = $12::uuid
      `,
      [
        orgId,
        canonicalManufacturer || canonicalKeyParts.manufacturer,
        canonicalFilmName || canonicalKeyParts.filmName,
        canonicalFilmKey,
        pickFirstNonNull(orderedRows, "sq_ft_weight_lbs_per_sq_ft"),
        pickFirstNonNull(orderedRows, "default_core_type"),
        pickFirstNonNull(orderedRows, "source_width_in"),
        pickFirstNonNull(orderedRows, "source_initial_feet"),
        pickFirstNonNull(orderedRows, "source_initial_weight_lbs"),
        pickFirstNonNull(orderedRows, "source_box_id"),
        mergedNotes,
        keeper.id,
      ],
    );

    if (removedRows.length > 0) {
      await client.query(
        `
          delete from app.film_catalog
          where org_id = $1::uuid
            and id = any($2::uuid[])
        `,
        [orgId, removedRows.map((row) => row.id)],
      );
    }

    mergeAudit.merged_groups += 1;
    mergeAudit.merged_rows_updated += 1;
    mergeAudit.merged_rows_deleted += removedRows.length;
    mergeAudit.merged_group_details.push({
      canonical_film_key: canonicalFilmKey,
      kept_film_catalog_id: keeper.id,
      removed_film_catalog_ids: removedRows.map((row) => row.id),
      merged_source_film_keys: canonicalRows.map((row) => row.film_key),
    });
  }

  return mergeAudit;
}

function buildHarvestedCoverage(boxRows, harvestedEntries) {
  const harvestedSet = new Set(
    harvestedEntries.map((entry) => `${entry.manufacturer_lookup_key}|${entry.film_lookup_key}`),
  );

  const aggregate = {
    distinct_labels_total: 0,
    box_rows_total: 0,
    distinct_labels_matched: 0,
    distinct_labels_unmatched: 0,
    box_rows_matched: 0,
    box_rows_unmatched: 0,
  };

  for (const row of boxRows) {
    aggregate.distinct_labels_total += 1;
    aggregate.box_rows_total += row.box_count;
    const manufacturer = canonicalizeManufacturerLabel(row.manufacturer);
    const key = `${normalizeManufacturerLookupKey(manufacturer)}|${normalizeFilmLookupKey(row.film_name)}`;
    if (harvestedSet.has(key)) {
      aggregate.distinct_labels_matched += 1;
      aggregate.box_rows_matched += row.box_count;
    } else {
      aggregate.distinct_labels_unmatched += 1;
      aggregate.box_rows_unmatched += row.box_count;
    }
  }

  return aggregate;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = parseBooleanOption(args.apply, false);
  const includeTokenOnlyUnique = parseBooleanOption(args["include-token-only-unique"], false);
  const includeManufacturerPrefixPolicy = parseBooleanOption(args["include-manufacturer-prefix-policy"], true);
  const includeAveryNaturaShadePolicy = parseBooleanOption(args["include-avery-natura-shade-policy"], true);

  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing env file: ${envPath}`);
  }
  const env = parseEnv(envPath);

  const databaseUrl = args["database-url"] ? String(args["database-url"]) : env.DATABASE_URL || env.SUPABASE_DB_URL;
  const orgId = args["org-id"] ? String(args["org-id"]) : env.DEFAULT_ORG_ID;
  const actor = args.actor ? normalizeCollapsedLabel(args.actor) : "harvested-film-name-normalization-script";

  if (!databaseUrl) throw new Error("DATABASE_URL (or SUPABASE_DB_URL) missing in backend/.env");
  if (!orgId) throw new Error("DEFAULT_ORG_ID missing in backend/.env");

  const catalogCsvPath = args["catalog-csv"]
    ? path.resolve(repoRoot, String(args["catalog-csv"]))
    : path.join(repoRoot, "tmp", "catalog_harvest", "architectural_film_catalog_final.csv");
  if (!fs.existsSync(catalogCsvPath)) {
    throw new Error(`Catalog CSV not found at ${catalogCsvPath}`);
  }

  const reportDir = args["report-dir"]
    ? path.resolve(repoRoot, String(args["report-dir"]))
    : path.join(backendDir, "migration-dry-runs", "harvested-film-name-normalization");
  const summaryJsonPath = path.join(reportDir, "harvested_film_name_summary.json");
  const preflightJsonPath = path.join(reportDir, "harvested_film_name_preflight.json");
  const proposedCsvPath = path.join(reportDir, "harvested_film_name_proposed_mappings.csv");
  const skippedCsvPath = path.join(reportDir, "harvested_film_name_skipped_or_ambiguous.csv");
  const fullClassificationCsvPath = path.join(reportDir, "harvested_film_name_classification_full.csv");
  const sampleAppliedCsvPath = path.join(reportDir, "harvested_film_name_sample_applied.csv");
  const mergeAuditJsonPath = path.join(reportDir, "harvested_film_catalog_collision_merge_prefix_policy.json");

  const harvestedCatalog = parseHarvestedCatalog(catalogCsvPath);

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query("begin");

    const boxRowsBefore = await loadBoxCombos(client, orgId);
    const coverageBefore = buildHarvestedCoverage(boxRowsBefore, harvestedCatalog.entries);

    const { classifications, renameMappings } = classifyBoxLabels(boxRowsBefore, harvestedCatalog.byManufacturer, {
      includeTokenOnlyUnique,
      includeManufacturerPrefixPolicy,
      includeAveryNaturaShadePolicy,
    });

    const supplementalPrefixPolicyMappings = includeManufacturerPrefixPolicy
      ? await buildSupplementalPrefixPolicyMappings(client, orgId, renameMappings)
      : [];
    if (supplementalPrefixPolicyMappings.length > 0) {
      renameMappings.push(...supplementalPrefixPolicyMappings);
      for (const mapping of supplementalPrefixPolicyMappings) {
        classifications.push({
          old_manufacturer: mapping.old_manufacturer,
          old_film_name: mapping.old_film_name,
          canonical_manufacturer: mapping.canonical_manufacturer,
          new_film_name: mapping.canonical_film_name,
          reason: mapping.reason,
          confidence: mapping.confidence,
          box_count: mapping.box_count,
          candidate_count: 1,
          candidate_examples: mapping.canonical_film_name,
        });
      }
    }

    const supplementalAveryNaturaMappings = includeAveryNaturaShadePolicy
      ? await buildSupplementalAveryNaturaPolicyMappings(client, orgId, renameMappings)
      : [];
    if (supplementalAveryNaturaMappings.length > 0) {
      renameMappings.push(...supplementalAveryNaturaMappings);
      for (const mapping of supplementalAveryNaturaMappings) {
        classifications.push({
          old_manufacturer: mapping.old_manufacturer,
          old_film_name: mapping.old_film_name,
          canonical_manufacturer: mapping.canonical_manufacturer,
          new_film_name: mapping.canonical_film_name,
          reason: mapping.reason,
          confidence: mapping.confidence,
          box_count: mapping.box_count,
          candidate_count: 1,
          candidate_examples: mapping.canonical_film_name,
        });
      }
    }

    const classificationSummary = summarizeClassifications(classifications);

    const approvedMappings = renameMappings.map((row) => ({
      mapping_key: row.mapping_key,
      old_manufacturer_lookup_key: row.old_manufacturer_lookup_key,
      old_film_name_lookup_key: row.old_film_name_lookup_key,
      canonical_manufacturer: row.canonical_manufacturer,
      canonical_manufacturer_lookup_key: row.canonical_manufacturer_lookup_key,
      canonical_film_name: row.canonical_film_name,
      box_count: row.box_count,
    }));

    let preflight = await buildPreflight(client, orgId, approvedMappings);
    let blockers = {
      film_catalog_key_collisions: preflight.preflight_blockers.film_catalog_key_collisions.length,
      job_requirement_lookup_collisions: preflight.preflight_blockers.job_requirement_lookup_collisions.length,
    };
    let mergeAudit = {
      attempted: false,
      collision_groups_detected: 0,
      merged_groups: 0,
      merged_rows_updated: 0,
      merged_rows_deleted: 0,
      skipped_groups: [],
      merged_group_details: [],
    };

    let updatesApplied = {
      aliases_upserted: 0,
      boxes: 0,
      film_catalog: 0,
      film_catalog_missing_upserts: 0,
      job_requirements: 0,
      film_orders: 0,
      roll_weight_log: 0,
    };
    let coverageAfter = coverageBefore;

    if (apply) {
      if (blockers.film_catalog_key_collisions > 0 && (includeManufacturerPrefixPolicy || includeAveryNaturaShadePolicy)) {
        mergeAudit = await mergeFilmCatalogPrefixPolicyCollisions(
          client,
          orgId,
          preflight.preflight_blockers.film_catalog_key_collisions,
        );
        preflight = await buildPreflight(client, orgId, approvedMappings);
        blockers = {
          film_catalog_key_collisions: preflight.preflight_blockers.film_catalog_key_collisions.length,
          job_requirement_lookup_collisions: preflight.preflight_blockers.job_requirement_lookup_collisions.length,
        };
      }

      if (blockers.film_catalog_key_collisions > 0 || blockers.job_requirement_lookup_collisions > 0) {
        throw new Error(
          `Preflight blocked apply: film_catalog_key_collisions=${blockers.film_catalog_key_collisions}, job_requirement_lookup_collisions=${blockers.job_requirement_lookup_collisions}`,
        );
      }

      updatesApplied = await runApply(client, orgId, actor, approvedMappings);
      const boxRowsAfter = await loadBoxCombos(client, orgId);
      coverageAfter = buildHarvestedCoverage(boxRowsAfter, harvestedCatalog.entries);
    }

    await client.query(apply ? "commit" : "rollback");

    fs.mkdirSync(reportDir, { recursive: true });

    const proposedRows = renameMappings
      .slice()
      .sort((left, right) => {
        if (right.box_count !== left.box_count) return right.box_count - left.box_count;
        const mCompare = left.old_manufacturer.localeCompare(right.old_manufacturer, undefined, { sensitivity: "base" });
        if (mCompare !== 0) return mCompare;
        return left.old_film_name.localeCompare(right.old_film_name, undefined, { sensitivity: "base" });
      })
      .map((row) => ({
        old_manufacturer: row.old_manufacturer,
        old_film_name: row.old_film_name,
        new_film_name: row.canonical_film_name,
        reason: row.reason,
        confidence: row.confidence,
        box_count: row.box_count,
        mapping_key: row.mapping_key,
      }));

    const skippedRows = classifications
      .filter(
        (row) =>
          row.reason !== REASON_FP_UNIQUE
          && row.reason !== REASON_EXACT
          && row.reason !== REASON_TOKEN_UNIQUE
          && row.reason !== REASON_PREFIX_POLICY
          && row.reason !== REASON_AVERY_NATURA_SHADE_FORMAT
          && row.reason !== REASON_AVERY_NATURA_INFERRED_SHADE,
      )
      .sort((left, right) => {
        if (right.box_count !== left.box_count) return right.box_count - left.box_count;
        const mCompare = left.canonical_manufacturer.localeCompare(right.canonical_manufacturer, undefined, { sensitivity: "base" });
        if (mCompare !== 0) return mCompare;
        return left.old_film_name.localeCompare(right.old_film_name, undefined, { sensitivity: "base" });
      });

    const sampleAppliedRows = proposedRows.slice(0, 30);

    fs.writeFileSync(
      proposedCsvPath,
      toSimpleCsv(proposedRows, [
        "old_manufacturer",
        "old_film_name",
        "new_film_name",
        "reason",
        "confidence",
        "box_count",
        "mapping_key",
      ]),
      "utf8",
    );

    fs.writeFileSync(
      skippedCsvPath,
      toSimpleCsv(skippedRows, [
        "old_manufacturer",
        "old_film_name",
        "canonical_manufacturer",
        "new_film_name",
        "reason",
        "confidence",
        "box_count",
        "candidate_count",
        "candidate_examples",
      ]),
      "utf8",
    );
    fs.writeFileSync(
      fullClassificationCsvPath,
      toSimpleCsv(classifications, [
        "old_manufacturer",
        "old_film_name",
        "canonical_manufacturer",
        "new_film_name",
        "reason",
        "confidence",
        "box_count",
        "candidate_count",
        "candidate_examples",
      ]),
      "utf8",
    );

    fs.writeFileSync(
      sampleAppliedCsvPath,
      toSimpleCsv(sampleAppliedRows, [
        "old_manufacturer",
        "old_film_name",
        "new_film_name",
        "reason",
        "confidence",
        "box_count",
        "mapping_key",
      ]),
      "utf8",
    );

    fs.writeFileSync(preflightJsonPath, `${JSON.stringify(preflight, null, 2)}\n`, "utf8");
    fs.writeFileSync(mergeAuditJsonPath, `${JSON.stringify(mergeAudit, null, 2)}\n`, "utf8");

    const policyMappings = renameMappings.filter((row) => row.reason === REASON_PREFIX_POLICY);
    const averyNaturaShadeMappings = renameMappings.filter((row) => row.reason === REASON_AVERY_NATURA_SHADE_FORMAT);
    const averyNaturaInferredMappings = renameMappings.filter((row) => row.reason === REASON_AVERY_NATURA_INFERRED_SHADE);

    const summary = {
      generated_at_utc: new Date().toISOString(),
      apply,
      org_id: orgId,
      actor,
      source_catalog_csv: toPosixPath(path.relative(repoRoot, catalogCsvPath)),
      assumptions: {
        confidence_policy: includeTokenOnlyUnique ? "exact + unique fingerprint + unique token only" : "exact + unique fingerprint only",
        token_only_policy: includeTokenOnlyUnique ? "unique token matches auto-approved" : "excluded",
        manufacturer_prefix_policy: includeManufacturerPrefixPolicy
          ? "enabled for 3M Solar/Fasara, Madico, Avery Dennison, Llumar, Solar Gard, SOLYX; Security/Vinyl untouched"
          : "disabled",
        avery_natura_shade_policy: includeAveryNaturaShadePolicy
          ? "enabled: Natura 0X/00X -> Natura X; bare Natura inferred from notes when uniquely available; unresolved bare Natura skipped"
          : "disabled",
        manufacturer_must_match_canonical: true,
        preserve_3m_fasara_manufacturer: true,
      },
      options: {
        include_token_only_unique: includeTokenOnlyUnique,
        include_manufacturer_prefix_policy: includeManufacturerPrefixPolicy,
        include_avery_natura_shade_policy: includeAveryNaturaShadePolicy,
      },
      harvested_catalog: {
        distinct_labels: harvestedCatalog.entries.length,
        distinct_manufacturers: [...new Set(harvestedCatalog.entries.map((entry) => entry.manufacturer))].length,
      },
      baseline: coverageBefore,
      classification_summary: classificationSummary,
      approved_mapping_count: approvedMappings.length,
      approved_box_rows_total: approvedMappings.reduce((sum, row) => sum + Number(row.box_count || 0), 0),
      policy_mapping_count: policyMappings.length,
      policy_box_rows_total: policyMappings.reduce((sum, row) => sum + Number(row.box_count || 0), 0),
      avery_natura_shade_format_mapping_count: averyNaturaShadeMappings.length,
      avery_natura_shade_format_box_rows_total: averyNaturaShadeMappings.reduce((sum, row) => sum + Number(row.box_count || 0), 0),
      avery_natura_inferred_shade_mapping_count: averyNaturaInferredMappings.length,
      avery_natura_inferred_shade_box_rows_total: averyNaturaInferredMappings.reduce((sum, row) => sum + Number(row.box_count || 0), 0),
      blockers,
      candidate_updates_from_approved: preflight.candidate_updates,
      updates_applied: updatesApplied,
      coverage_after: coverageAfter,
      sample_applied_count: sampleAppliedRows.length,
      film_catalog_collision_merge: mergeAudit,
      artifacts: {
        report_dir: toPosixPath(path.relative(repoRoot, reportDir)),
        summary_json: toPosixPath(path.relative(repoRoot, summaryJsonPath)),
        preflight_json: toPosixPath(path.relative(repoRoot, preflightJsonPath)),
        film_catalog_collision_merge_json: toPosixPath(path.relative(repoRoot, mergeAuditJsonPath)),
        proposed_mappings_csv: toPosixPath(path.relative(repoRoot, proposedCsvPath)),
        skipped_or_ambiguous_csv: toPosixPath(path.relative(repoRoot, skippedCsvPath)),
        classification_full_csv: toPosixPath(path.relative(repoRoot, fullClassificationCsvPath)),
        sample_applied_csv: toPosixPath(path.relative(repoRoot, sampleAppliedCsvPath)),
      },
    };

    fs.writeFileSync(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    console.log(
      JSON.stringify(
        {
          apply,
          include_token_only_unique: includeTokenOnlyUnique,
          include_manufacturer_prefix_policy: includeManufacturerPrefixPolicy,
          include_avery_natura_shade_policy: includeAveryNaturaShadePolicy,
          org_id: orgId,
          baseline: coverageBefore,
          approved_mapping_count: approvedMappings.length,
          approved_box_rows_total: approvedMappings.reduce((sum, row) => sum + Number(row.box_count || 0), 0),
          blockers,
          updates_applied: updatesApplied,
          coverage_after: coverageAfter,
          summary_json: toPosixPath(path.relative(repoRoot, summaryJsonPath)),
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
