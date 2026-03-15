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
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function toPosixPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function toLookup(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeCollapsedLabel(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function canonicalizeManufacturerLabel(value) {
  const normalized = normalizeCollapsedLabel(value);
  const key = normalized.toLowerCase();

  if (key === "3m") return "3M Solar";
  if (key === "fasara" || key === "3m fasara") return "3M Fasara";
  if (key === "avery") return "Avery Dennison";
  if (key === "solar guard") return "Solar Gard";
  return normalized;
}

function normalizeManufacturerLookupKey(value) {
  return toLookup(canonicalizeManufacturerLabel(value));
}

function normalizeFilmLookupKey(value) {
  return toLookup(normalizeCollapsedLabel(value));
}

const SECURITY_MANUFACTURER = "Security";
const SECURITY_REASON_FUZZY_REVIEW = "fuzzy_review";
const SECURITY_FAMILY_WITH_EVIDENCE_FALLBACK = new Set(["s800", "s70", "s140", "ag"]);

function normalizeMilTokenSpacing(value) {
  return normalizeCollapsedLabel(value).replace(/\b(\d+)\s*mil\b/gi, (_match, digits) => `${digits} MIL`);
}

function stripLeadingSecurityToken(value) {
  return normalizeCollapsedLabel(value).replace(/^security\b[:\-\s]*/i, "").trim();
}

function normalizeMakerPrefix(prefix) {
  const normalized = normalizeCollapsedLabel(prefix);
  const key = normalized.toLowerCase();
  if (!normalized) return "";
  if (key === "3m solar" || key === "3m fasara" || key === "3m") return "3M";
  if (key === "solar guard" || key === "solargard" || key === "solar gard") return "Solar Gard";
  if (key === "avery") return "Avery Dennison";
  if (key === "avery dennison") return "Avery Dennison";
  if (key === "llumarvista" || key === "llumar vista" || key === "llumar") return "Llumar";
  if (key === "solyx") return "Solyx";
  if (key === "aswfvkool") return "ASWFVKOOL";
  if (key === "madico") return "Madico";
  if (key === "sol") return "SOL";
  return normalized;
}

function startsWithMakerPrefix(value, makerPrefix) {
  const normalizedValue = normalizeCollapsedLabel(value).toLowerCase();
  const normalizedPrefix = normalizeMakerPrefix(makerPrefix).toLowerCase();
  if (!normalizedPrefix) {
    return false;
  }
  if (normalizedValue === normalizedPrefix) {
    return true;
  }
  if (normalizedValue.startsWith(`${normalizedPrefix} `)) {
    return true;
  }

  if (normalizedPrefix === "3m" && normalizedValue.startsWith("3m solar ")) {
    return true;
  }

  if (normalizedPrefix === "solar gard" && normalizedValue.startsWith("solargard ")) {
    return true;
  }

  if (normalizedPrefix === "avery dennison" && normalizedValue.startsWith("avery ")) {
    return true;
  }

  return false;
}

function normalizeLeadingMakerPrefix(baseName, makerPrefix) {
  const normalizedBase = normalizeCollapsedLabel(baseName);
  const normalizedPrefix = normalizeMakerPrefix(makerPrefix);
  if (!normalizedPrefix) {
    return normalizedBase;
  }

  if (normalizedPrefix === "3M") {
    return normalizedBase.replace(/^3m(?:\s+solar)?\b/i, "3M");
  }
  if (normalizedPrefix === "Solar Gard") {
    return normalizedBase.replace(/^(?:solar\s*guard|solargard|solar\s+gard)\b/i, "Solar Gard");
  }
  if (normalizedPrefix === "Avery Dennison") {
    return normalizedBase.replace(/^avery(?:\s+dennison)?\b/i, "Avery Dennison");
  }
  if (normalizedPrefix === "Llumar") {
    return normalizedBase.replace(/^llumar(?:\s+vista)?\b/i, "Llumar");
  }
  if (normalizedPrefix === "Solyx") {
    return normalizedBase.replace(/^solyx\b/i, "Solyx");
  }
  if (normalizedPrefix === "ASWFVKOOL") {
    return normalizedBase.replace(/^aswfvkool\b/i, "ASWFVKOOL");
  }
  if (normalizedPrefix === "Madico") {
    return normalizedBase.replace(/^madico\b/i, "Madico");
  }
  if (normalizedPrefix === "SOL") {
    return normalizedBase.replace(/^sol\b/i, "SOL");
  }

  return normalizedBase;
}

function inferMakerPrefixFromFilmName(filmName) {
  const cleaned = stripLeadingSecurityToken(filmName);
  if (!cleaned) return "";
  if (/^3m\b/i.test(cleaned)) return "3M";
  if (/^madico\b/i.test(cleaned)) return "Madico";
  if (/^solar\s*guard\b/i.test(cleaned) || /^solargard\b/i.test(cleaned)) return "Solar Gard";
  if (/^avery(?:\s+dennison)?\b/i.test(cleaned)) return "Avery Dennison";
  if (/^llumar(?:\s+vista)?\b/i.test(cleaned)) return "Llumar";
  if (/^solyx\b/i.test(cleaned)) return "Solyx";
  if (/^aswfvkool\b/i.test(cleaned)) return "ASWFVKOOL";
  if (/^sol\b/i.test(cleaned)) return "SOL";
  return "";
}

function inferMakerPrefixFromManufacturer(manufacturer) {
  const canonical = canonicalizeManufacturerLabel(manufacturer);
  if (!canonical || normalizeManufacturerLookupKey(canonical) === normalizeManufacturerLookupKey(SECURITY_MANUFACTURER)) {
    return "";
  }
  return normalizeMakerPrefix(canonical);
}

function detectSecurityFilmFamily(filmName) {
  const normalized = normalizeCollapsedLabel(filmName);
  const squashedUpper = normalized.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const agMatch = normalized.match(/\bAG[-\s]*([0-9]+)\b/i);

  if (agMatch || /\banti\s*graffiti\b/i.test(normalized)) {
    return {
      is_security: true,
      family: "ag",
      reason_source: "ag_rule",
      ag_code: agMatch ? agMatch[1] : "",
    };
  }

  if (/\bS[-\s]*140\b/i.test(normalized)) {
    return {
      is_security: true,
      family: "s140",
      reason_source: "s140_rule",
      ag_code: "",
    };
  }

  if (/\bS[-\s]*70\b/i.test(normalized)) {
    return {
      is_security: true,
      family: "s70",
      reason_source: "s70_rule",
      ag_code: "",
    };
  }

  if (
    /\bULTRA\s*S?800\b/i.test(normalized) ||
    /\bS[-\s]*800\b/i.test(normalized) ||
    squashedUpper.includes("ULTRAS800")
  ) {
    return {
      is_security: true,
      family: "s800",
      reason_source: "s800_rule",
      ag_code: "",
    };
  }

  if (/\b\d+\s*mil\b/i.test(normalized)) {
    return {
      is_security: true,
      family: "mil",
      reason_source: "mil_rule",
      ag_code: "",
    };
  }

  return {
    is_security: false,
    family: "",
    reason_source: "",
    ag_code: "",
  };
}

function chooseMakerPrefixFromEvidence(evidenceByFamily, family) {
  if (!SECURITY_FAMILY_WITH_EVIDENCE_FALLBACK.has(family)) {
    return "";
  }
  const familyEvidence = evidenceByFamily.get(family);
  if (!familyEvidence) {
    return "";
  }

  let bestPrefix = "";
  let bestCount = -1;
  for (const [prefix, count] of familyEvidence.entries()) {
    if (count > bestCount) {
      bestPrefix = prefix;
      bestCount = count;
      continue;
    }
    if (count === bestCount && prefix.localeCompare(bestPrefix, undefined, { sensitivity: "base" }) < 0) {
      bestPrefix = prefix;
    }
  }
  return bestPrefix;
}

function buildSecurityMakerEvidence(sourceRows) {
  const evidenceByFamily = new Map();
  for (const row of sourceRows) {
    const detection = detectSecurityFilmFamily(row.old_film_name);
    if (!detection.is_security || !SECURITY_FAMILY_WITH_EVIDENCE_FALLBACK.has(detection.family)) {
      continue;
    }

    const fromFilm = normalizeMakerPrefix(inferMakerPrefixFromFilmName(row.old_film_name));
    const fromManufacturer = normalizeMakerPrefix(inferMakerPrefixFromManufacturer(row.old_manufacturer));
    const makerPrefix = fromFilm || fromManufacturer;
    if (!makerPrefix) {
      continue;
    }

    if (!evidenceByFamily.has(detection.family)) {
      evidenceByFamily.set(detection.family, new Map());
    }

    const familyEvidence = evidenceByFamily.get(detection.family);
    familyEvidence.set(
      makerPrefix,
      Number(familyEvidence.get(makerPrefix) || 0) + Number(row.box_count || 0),
    );
  }

  return evidenceByFamily;
}

function buildCanonicalSecurityFilmName(sourceFilmName, detection, makerPrefix) {
  const cleanedSource = normalizeMilTokenSpacing(stripLeadingSecurityToken(sourceFilmName));
  const normalizedPrefix = normalizeMakerPrefix(makerPrefix);
  const prefixFilmName = (baseName) => {
    const normalizedBase = normalizeCollapsedLabel(baseName);
    if (!normalizedPrefix) {
      return normalizedBase;
    }
    if (startsWithMakerPrefix(normalizedBase, normalizedPrefix)) {
      return normalizeLeadingMakerPrefix(normalizedBase, normalizedPrefix);
    }
    return `${normalizedPrefix} ${normalizedBase}`;
  };

  if (detection.family === "s800") {
    return prefixFilmName("Ultra S800");
  }
  if (detection.family === "s70") {
    return prefixFilmName("S70");
  }
  if (detection.family === "s140") {
    return prefixFilmName("S140");
  }
  if (detection.family === "ag") {
    const agSuffix = detection.ag_code ? `AG-${detection.ag_code}` : "AG";
    return prefixFilmName(agSuffix);
  }

  return prefixFilmName(cleanedSource);
}

function normalizeSecurityFilmEntry(oldManufacturer, oldFilmName, evidenceByFamily) {
  const normalizedManufacturer = canonicalizeManufacturerLabel(oldManufacturer);
  const normalizedFilmName = normalizeCollapsedLabel(oldFilmName);
  const detection = detectSecurityFilmFamily(normalizedFilmName);
  if (!detection.is_security) {
    return {
      manufacturer: normalizedManufacturer,
      film_name: normalizedFilmName,
      reason_source: "",
      security_family: "",
      maker_prefix: "",
    };
  }

  const makerPrefixFromFilm = normalizeMakerPrefix(inferMakerPrefixFromFilmName(normalizedFilmName));
  const makerPrefixFromManufacturer = normalizeMakerPrefix(inferMakerPrefixFromManufacturer(normalizedManufacturer));
  const makerPrefixFromEvidence = normalizeMakerPrefix(chooseMakerPrefixFromEvidence(evidenceByFamily, detection.family));
  const makerPrefix = makerPrefixFromFilm || makerPrefixFromManufacturer || makerPrefixFromEvidence;

  return {
    manufacturer: SECURITY_MANUFACTURER,
    film_name: buildCanonicalSecurityFilmName(normalizedFilmName, detection, makerPrefix),
    reason_source: detection.reason_source,
    security_family: detection.family,
    maker_prefix: makerPrefix,
  };
}

function tokenizeValue(value) {
  return normalizeFilmLookupKey(value)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function tokenizeFilmName(value, ignoredTokens = new Set()) {
  const tokens = tokenizeValue(value);
  return tokens.filter((token) => !ignoredTokens.has(token));
}

function isCodeToken(token) {
  return (/[a-z]/i.test(token) && /\d/.test(token)) || /^\d{3,}$/.test(token);
}

function extractModelCodes(tokens) {
  const codes = new Set();
  for (const rawToken of tokens) {
    const token = String(rawToken || "").trim();
    if (!token) continue;

    if (/[a-z]/i.test(token) && /\d/.test(token)) {
      const upper = token.toUpperCase();
      codes.add(upper);
      const digits = token.replace(/\D/g, "");
      if (digits.length >= 3) {
        codes.add(digits);
      }
      continue;
    }

    if (/^\d{3,}$/.test(token)) {
      codes.add(token);
    }
  }
  return codes;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function setIntersection(left, right) {
  const output = new Set();
  for (const value of left) {
    if (right.has(value)) {
      output.add(value);
    }
  }
  return output;
}

function isSubset(left, right) {
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function buildFilmProfile(filmName, ignoredTokens = new Set()) {
  const normalized = normalizeCollapsedLabel(filmName);
  const tokens = sortedUnique(tokenizeFilmName(normalized, ignoredTokens));
  const tokenSet = new Set(tokens);
  const codes = extractModelCodes(tokens);
  const nonCodeTokens = new Set(tokens.filter((token) => !isCodeToken(token)));

  return {
    normalized,
    tokenSignature: tokens.join(" "),
    tokenSet,
    codes,
    nonCodeTokens,
    tokenCount: tokenSet.size,
  };
}

function profilesAreSimilar(left, right) {
  if (left.tokenSignature && left.tokenSignature === right.tokenSignature) {
    return true;
  }

  if (!left.codes.size || !right.codes.size) {
    return false;
  }

  const codeIntersection = setIntersection(left.codes, right.codes);
  if (!codeIntersection.size) {
    return false;
  }

  if (isSubset(left.tokenSet, right.tokenSet) || isSubset(right.tokenSet, left.tokenSet)) {
    return true;
  }

  const sharedNonCode = setIntersection(left.nonCodeTokens, right.nonCodeTokens);
  if (sharedNonCode.size > 0) {
    return true;
  }

  for (const code of codeIntersection) {
    if (/[A-Z]/.test(code)) {
      return true;
    }
  }

  return false;
}

function findConnectedComponents(nodes, shouldLink) {
  const parent = nodes.map((_, index) => index);

  function find(index) {
    if (parent[index] !== index) {
      parent[index] = find(parent[index]);
    }
    return parent[index];
  }

  function union(leftIndex, rightIndex) {
    const leftRoot = find(leftIndex);
    const rightRoot = find(rightIndex);
    if (leftRoot === rightRoot) return;
    parent[rightRoot] = leftRoot;
  }

  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      if (shouldLink(nodes[left], nodes[right])) {
        union(left, right);
      }
    }
  }

  const byRoot = new Map();
  for (let index = 0; index < nodes.length; index += 1) {
    const root = find(index);
    if (!byRoot.has(root)) {
      byRoot.set(root, []);
    }
    byRoot.get(root).push(nodes[index]);
  }

  return [...byRoot.values()];
}

function parseExistingDecisionMap(decisionCsvPath) {
  const decisionMap = new Map();
  if (!fs.existsSync(decisionCsvPath)) {
    return decisionMap;
  }

  const rows = parseCsv(fs.readFileSync(decisionCsvPath, "utf8"));
  if (!rows.length) return decisionMap;
  const header = rows[0].map((entry, index) => (index === 0 ? entry.replace(/^\uFEFF/, "") : entry));
  const indexByColumn = {};
  for (let i = 0; i < header.length; i += 1) {
    indexByColumn[header[i]] = i;
  }

  if (!Object.prototype.hasOwnProperty.call(indexByColumn, "mapping_key")) {
    return decisionMap;
  }

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const mappingKey = normalizeCollapsedLabel(row[indexByColumn.mapping_key]);
    if (!mappingKey) continue;
    const decisionRaw = normalizeCollapsedLabel(row[indexByColumn.decision] || "").toLowerCase();
    const decision = decisionRaw === "approve" || decisionRaw === "reject" ? decisionRaw : "";
    const notes = normalizeCollapsedLabel(row[indexByColumn.notes] || "");
    decisionMap.set(mappingKey, { decision, notes });
  }

  return decisionMap;
}

function buildDecisionRows(mappingRows, existingDecisionMap) {
  return mappingRows.map((row) => {
    const existing = existingDecisionMap.get(row.mapping_key) || { decision: "", notes: "" };
    return {
      ...row,
      decision: existing.decision || "",
      notes: existing.notes || "",
    };
  });
}

function summarizeDecisions(decisionRows) {
  let approve = 0;
  let reject = 0;
  let pending = 0;

  for (const row of decisionRows) {
    const decision = normalizeCollapsedLabel(row.decision).toLowerCase();
    if (decision === "approve") {
      approve += 1;
      continue;
    }
    if (decision === "reject") {
      reject += 1;
      continue;
    }
    pending += 1;
  }

  return { approve, reject, pending };
}

function toDecisionCsv(decisionRows) {
  const lines = [
    [
      "mapping_key",
      "group_id",
      "reason_source",
      "old_manufacturer",
      "old_film_name",
      "canonical_manufacturer",
      "canonical_film_name",
      "canonical_box_count",
      "alias_box_count",
      "decision",
      "notes",
    ].map(csvCell).join(","),
  ];

  for (const row of decisionRows) {
    lines.push(
      [
        row.mapping_key,
        row.group_id,
        row.reason_source || SECURITY_REASON_FUZZY_REVIEW,
        row.old_manufacturer,
        row.alias_film_name,
        row.manufacturer,
        row.canonical_film_name,
        row.canonical_box_count,
        row.alias_box_count,
        row.decision || "",
        row.notes || "",
      ].map(csvCell).join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

function toSimpleCsv(rows, headers) {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header] ?? "")).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function dedupeMappingRows(rows) {
  const deduped = new Map();
  for (const row of rows) {
    const mappingKey = normalizeCollapsedLabel(row.mapping_key);
    if (!mappingKey || deduped.has(mappingKey)) {
      continue;
    }
    deduped.set(mappingKey, {
      ...row,
      mapping_key: mappingKey,
    });
  }
  return [...deduped.values()];
}

function toMappingPayload(rows) {
  return rows.map((row) => ({
    mapping_key: row.mapping_key,
    old_manufacturer_lookup_key: row.old_manufacturer_lookup_key,
    old_film_name_lookup_key: row.old_film_name_lookup_key,
    canonical_manufacturer: row.manufacturer,
    canonical_manufacturer_lookup_key: row.manufacturer_lookup_key,
    canonical_film_name: row.canonical_film_name,
  }));
}

async function queryInt(client, sql, params = []) {
  const result = await client.query(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function createTempApprovedMappings(client, approvedMappings) {
  await client.query("drop table if exists tmp_film_name_alias_mapping");
  await client.query(`
    create temporary table tmp_film_name_alias_mapping (
      old_manufacturer_lookup_key text not null,
      old_film_name_lookup_key text not null,
      canonical_manufacturer text not null,
      canonical_manufacturer_lookup_key text not null,
      canonical_film_name text not null,
      primary key (old_manufacturer_lookup_key, old_film_name_lookup_key)
    ) on commit drop
  `);

  if (!approvedMappings.length) {
    return;
  }

  for (let index = 0; index < approvedMappings.length; index += 250) {
    const chunk = approvedMappings.slice(index, index + 250);
    const values = [];
    const placeholders = [];
    let cursor = 1;

    for (const row of chunk) {
      placeholders.push(`($${cursor},$${cursor + 1},$${cursor + 2},$${cursor + 3},$${cursor + 4})`);
      values.push(
        row.old_manufacturer_lookup_key,
        row.old_film_name_lookup_key,
        row.canonical_manufacturer,
        row.canonical_manufacturer_lookup_key,
        row.canonical_film_name,
      );
      cursor += 5;
    }

    await client.query(
      `
        insert into tmp_film_name_alias_mapping (
          old_manufacturer_lookup_key,
          old_film_name_lookup_key,
          canonical_manufacturer,
          canonical_manufacturer_lookup_key,
          canonical_film_name
        )
        values ${placeholders.join(",")}
      `,
      values,
    );
  }
}

async function buildPreflight(client, orgId, approvedMappings) {
  await createTempApprovedMappings(client, approvedMappings);

  const candidateUpdates = {
    boxes: 0,
    film_catalog: 0,
    job_requirements: 0,
    film_orders: 0,
    roll_weight_log: 0,
  };

  if (approvedMappings.length) {
    candidateUpdates.boxes = await queryInt(
      client,
      `
        select count(*)::int as count
        from app.boxes b
        join tmp_film_name_alias_mapping m
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
        join tmp_film_name_alias_mapping m
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

    candidateUpdates.job_requirements = await queryInt(
      client,
      `
        select count(*)::int as count
        from app.job_requirements r
        join tmp_film_name_alias_mapping m
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
        join tmp_film_name_alias_mapping m
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
        join tmp_film_name_alias_mapping m
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
  }

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
        left join tmp_film_name_alias_mapping m
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
          j.job_number,
          app_api.normalize_catalog_lookup_key(
            coalesce(m.canonical_manufacturer, app_api.canonical_manufacturer_label(r.manufacturer))
          ) as manufacturer_lookup_key,
          app_api.normalize_catalog_lookup_key(
            coalesce(m.canonical_film_name, app_api.normalize_collapsed_catalog_label(r.film_name))
          ) as canonical_film_lookup_key,
          round(coalesce(r.width_in, 0)::numeric, 4)::text as width_key
        from app.job_requirements r
        join app.jobs j
          on j.id = r.job_id
        left join tmp_film_name_alias_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(r.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(r.film_name)
        where r.org_id = $1::uuid
      ),
      grouped as (
        select
          m.job_id,
          m.job_number,
          m.manufacturer_lookup_key || '|' || m.canonical_film_lookup_key || '|' || m.width_key as canonical_lookup_key,
          count(*)::int as row_count,
          array_agg(m.id order by m.id) as source_requirement_ids
        from mapped m
        group by m.job_id, m.job_number, canonical_lookup_key
      )
      select
        job_id,
        job_number,
        canonical_lookup_key,
        row_count,
        source_requirement_ids
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
    job_requirements: 0,
    film_orders: 0,
    roll_weight_log: 0,
  };

  if (!approvedMappings.length) {
    return updates;
  }

  const aliasUpsert = await client.query(
    `
      insert into app.film_name_aliases (
        org_id,
        manufacturer_lookup_key,
        old_film_name_lookup_key,
        canonical_film_name,
        created_by,
        updated_by
      )
      select
        $1::uuid,
        m.canonical_manufacturer_lookup_key,
        m.old_film_name_lookup_key,
        m.canonical_film_name,
        $2,
        $2
      from tmp_film_name_alias_mapping m
      where app_api.normalize_catalog_lookup_key(m.canonical_film_name) <> m.old_film_name_lookup_key
      on conflict (org_id, manufacturer_lookup_key, old_film_name_lookup_key) do update set
        canonical_film_name = excluded.canonical_film_name,
        updated_at = now(),
        updated_by = excluded.updated_by
    `,
    [orgId, actor],
  );
  updates.aliases_upserted = aliasUpsert.rowCount ?? 0;

  const updateBoxes = await client.query(
    `
      with candidates as (
        select
          b.id,
          m.canonical_manufacturer,
          m.canonical_film_name
        from app.boxes b
        join tmp_film_name_alias_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(b.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(b.film_name)
        where b.org_id = $1::uuid
          and (
            app_api.normalize_catalog_manufacturer_lookup_key(b.manufacturer)
              is distinct from m.canonical_manufacturer_lookup_key
            or app_api.normalize_catalog_lookup_key(b.film_name)
              is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
          )
      )
      update app.boxes b
      set
        manufacturer = c.canonical_manufacturer,
        film_name = c.canonical_film_name,
        film_key = upper(app_api.canonical_manufacturer_label(c.canonical_manufacturer))
          || '|'
          || upper(c.canonical_film_name),
        updated_at = now()
      from candidates c
      where b.id = c.id
    `,
    [orgId],
  );
  updates.boxes = updateBoxes.rowCount ?? 0;

  const updateCatalog = await client.query(
    `
      with candidates as (
        select
          f.id,
          m.canonical_manufacturer,
          m.canonical_film_name
        from app.film_catalog f
        join tmp_film_name_alias_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(f.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(f.film_name)
        where f.org_id = $1::uuid
          and (
            app_api.normalize_catalog_manufacturer_lookup_key(f.manufacturer)
              is distinct from m.canonical_manufacturer_lookup_key
            or app_api.normalize_catalog_lookup_key(f.film_name)
              is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
          )
      )
      update app.film_catalog f
      set
        manufacturer = c.canonical_manufacturer,
        film_name = c.canonical_film_name,
        film_key = upper(app_api.canonical_manufacturer_label(c.canonical_manufacturer))
          || '|'
          || upper(c.canonical_film_name),
        updated_at = now()
      from candidates c
      where f.id = c.id
    `,
    [orgId],
  );
  updates.film_catalog = updateCatalog.rowCount ?? 0;

  const updateRequirements = await client.query(
    `
      with candidates as (
        select
          r.id,
          m.canonical_manufacturer,
          m.canonical_film_name
        from app.job_requirements r
        join tmp_film_name_alias_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(r.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(r.film_name)
        where r.org_id = $1::uuid
          and (
            app_api.normalize_catalog_manufacturer_lookup_key(r.manufacturer)
              is distinct from m.canonical_manufacturer_lookup_key
            or app_api.normalize_catalog_lookup_key(r.film_name)
              is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
          )
      )
      update app.job_requirements r
      set
        manufacturer = c.canonical_manufacturer,
        film_name = c.canonical_film_name,
        updated_at = now(),
        updated_by = $2
      from candidates c
      where r.id = c.id
    `,
    [orgId, actor],
  );
  updates.job_requirements = updateRequirements.rowCount ?? 0;

  const updateFilmOrders = await client.query(
    `
      with candidates as (
        select
          o.id,
          m.canonical_manufacturer,
          m.canonical_film_name
        from app.film_orders o
        join tmp_film_name_alias_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(o.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(o.film_name)
        where o.org_id = $1::uuid
          and (
            app_api.normalize_catalog_manufacturer_lookup_key(o.manufacturer)
              is distinct from m.canonical_manufacturer_lookup_key
            or app_api.normalize_catalog_lookup_key(o.film_name)
              is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
          )
      )
      update app.film_orders o
      set
        manufacturer = c.canonical_manufacturer,
        film_name = c.canonical_film_name
      from candidates c
      where o.id = c.id
    `,
    [orgId],
  );
  updates.film_orders = updateFilmOrders.rowCount ?? 0;

  const updateRollLog = await client.query(
    `
      with candidates as (
        select
          l.id,
          m.canonical_manufacturer,
          m.canonical_film_name
        from app.roll_weight_log l
        join tmp_film_name_alias_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(l.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(l.film_name)
        where l.org_id = $1::uuid
          and (
            app_api.normalize_catalog_manufacturer_lookup_key(l.manufacturer)
              is distinct from m.canonical_manufacturer_lookup_key
            or app_api.normalize_catalog_lookup_key(l.film_name)
              is distinct from app_api.normalize_catalog_lookup_key(m.canonical_film_name)
          )
      )
      update app.roll_weight_log l
      set
        manufacturer = c.canonical_manufacturer,
        film_name = c.canonical_film_name
      from candidates c
      where l.id = c.id
    `,
    [orgId],
  );
  updates.roll_weight_log = updateRollLog.rowCount ?? 0;

  return updates;
}

async function loadSourceRows(client, orgId) {
  const boxesRes = await client.query(
    `
      select
        canonicalize.manufacturer as manufacturer,
        canonicalize.film_name as film_name,
        count(*)::int as box_count
      from (
        select
          app_api.canonical_manufacturer_label(b.manufacturer) as manufacturer,
          app_api.normalize_collapsed_catalog_label(b.film_name) as film_name
        from app.boxes b
        where b.org_id = $1::uuid
      ) canonicalize
      group by canonicalize.manufacturer, canonicalize.film_name
      order by canonicalize.manufacturer asc, canonicalize.film_name asc
    `,
    [orgId],
  );

  const catalogRes = await client.query(
    `
      select distinct
        app_api.canonical_manufacturer_label(f.manufacturer) as manufacturer,
        app_api.normalize_collapsed_catalog_label(f.film_name) as film_name
      from app.film_catalog f
      where f.org_id = $1::uuid
    `,
    [orgId],
  );

  return {
    boxes: boxesRes.rows.map((row) => ({
      manufacturer: canonicalizeManufacturerLabel(row.manufacturer),
      film_name: normalizeCollapsedLabel(row.film_name),
      box_count: Number(row.box_count ?? 0),
    })),
    catalog: catalogRes.rows.map((row) => ({
      manufacturer: canonicalizeManufacturerLabel(row.manufacturer),
      film_name: normalizeCollapsedLabel(row.film_name),
    })),
  };
}

function buildSimilarityCandidates(source) {
  const sourceRows = source.boxes.map((row) => {
    const oldManufacturer = canonicalizeManufacturerLabel(row.manufacturer);
    const oldFilmName = normalizeCollapsedLabel(row.film_name);
    return {
      old_manufacturer: oldManufacturer,
      old_manufacturer_lookup_key: normalizeManufacturerLookupKey(oldManufacturer),
      old_film_name: oldFilmName,
      old_film_name_lookup_key: normalizeFilmLookupKey(oldFilmName),
      box_count: Number(row.box_count ?? 0),
    };
  });

  const securityEvidenceByFamily = buildSecurityMakerEvidence(sourceRows);
  const normalizeRow = (manufacturer, filmName) =>
    normalizeSecurityFilmEntry(manufacturer, filmName, securityEvidenceByFamily);

  const normalizedRows = sourceRows.map((row) => {
    const normalized = normalizeRow(row.old_manufacturer, row.old_film_name);
    const canonicalManufacturer = normalizeCollapsedLabel(normalized.manufacturer);
    const canonicalFilmName = normalizeCollapsedLabel(normalized.film_name);
    return {
      ...row,
      manufacturer: canonicalManufacturer,
      manufacturer_lookup_key: normalizeManufacturerLookupKey(canonicalManufacturer),
      film_name: canonicalFilmName,
      film_lookup_key: normalizeFilmLookupKey(canonicalFilmName),
      reason_source: normalized.reason_source || "",
      security_family: normalized.security_family || "",
    };
  });

  const catalogKeySet = new Set(
    source.catalog.map((row) => {
      const normalized = normalizeRow(row.manufacturer, row.film_name);
      return `${normalizeManufacturerLookupKey(normalized.manufacturer)}|${normalizeFilmLookupKey(normalized.film_name)}`;
    }),
  );

  const canonicalTotals = new Map();
  for (const row of normalizedRows) {
    const key = `${row.manufacturer_lookup_key}|${row.film_lookup_key}`;
    canonicalTotals.set(key, Number(canonicalTotals.get(key) || 0) + row.box_count);
  }

  const directMappings = [];
  let securityGroupCounter = 0;
  for (const row of normalizedRows) {
    const oldKey = `${row.old_manufacturer_lookup_key}|${row.old_film_name_lookup_key}`;
    const canonicalKey = `${row.manufacturer_lookup_key}|${row.film_lookup_key}`;
    if (oldKey === canonicalKey) {
      continue;
    }

    securityGroupCounter += 1;
    directMappings.push({
      mapping_key: oldKey,
      group_id: `SR-${String(securityGroupCounter).padStart(4, "0")}`,
      reason_source: row.reason_source || "rule_review",
      old_manufacturer: row.old_manufacturer,
      old_manufacturer_lookup_key: row.old_manufacturer_lookup_key,
      alias_film_name: row.old_film_name,
      old_film_name_lookup_key: row.old_film_name_lookup_key,
      manufacturer: row.manufacturer,
      manufacturer_lookup_key: row.manufacturer_lookup_key,
      canonical_film_name: row.film_name,
      canonical_film_lookup_key: row.film_lookup_key,
      canonical_box_count: Number(canonicalTotals.get(canonicalKey) || row.box_count),
      alias_box_count: row.box_count,
    });
  }

  const groupedByManufacturer = new Map();
  for (const row of normalizedRows) {
    const manufacturerTokens = new Set(tokenizeValue(row.manufacturer));
    if (!groupedByManufacturer.has(row.manufacturer_lookup_key)) {
      groupedByManufacturer.set(row.manufacturer_lookup_key, {
        manufacturer: row.manufacturer,
        manufacturer_tokens: manufacturerTokens,
        entries: [],
      });
    }

    groupedByManufacturer.get(row.manufacturer_lookup_key).entries.push({
      ...row,
      in_catalog: catalogKeySet.has(`${row.manufacturer_lookup_key}|${row.film_lookup_key}`),
      profile: buildFilmProfile(row.film_name, manufacturerTokens),
    });
  }

  const groups = [];
  const fuzzyMappings = [];
  let fuzzyGroupCounter = 0;

  for (const manufacturerGroup of groupedByManufacturer.values()) {
    const components = findConnectedComponents(
      manufacturerGroup.entries,
      (left, right) => {
        if (left.security_family || right.security_family) {
          if (left.security_family !== right.security_family) {
            return false;
          }
        }
        return profilesAreSimilar(left.profile, right.profile);
      },
    );

    for (const component of components) {
      if (component.length < 2) {
        continue;
      }

      const sorted = component.slice().sort((left, right) => {
        if (right.box_count !== left.box_count) {
          return right.box_count - left.box_count;
        }
        if (right.in_catalog !== left.in_catalog) {
          return right.in_catalog ? 1 : -1;
        }
        return left.film_name.localeCompare(right.film_name, undefined, { sensitivity: "base" });
      });

      const canonical = sorted[0];
      const canonicalKey = `${canonical.manufacturer_lookup_key}|${canonical.film_lookup_key}`;
      const aliases = sorted
        .slice(1)
        .filter((entry) => `${entry.old_manufacturer_lookup_key}|${entry.old_film_name_lookup_key}` !== canonicalKey);
      if (!aliases.length) {
        continue;
      }

      fuzzyGroupCounter += 1;
      const groupId = `FG-${String(fuzzyGroupCounter).padStart(4, "0")}`;
      const totalBoxes = sorted.reduce((sum, entry) => sum + entry.box_count, 0);

      groups.push({
        group_id: groupId,
        manufacturer: canonical.manufacturer,
        manufacturer_lookup_key: canonical.manufacturer_lookup_key,
        total_boxes: totalBoxes,
        canonical_film_name: canonical.film_name,
        canonical_box_count: canonical.box_count,
        canonical_in_catalog: canonical.in_catalog,
        variants: sorted.map((entry) => ({
          old_manufacturer: entry.old_manufacturer,
          old_film_name: entry.old_film_name,
          film_name: entry.film_name,
          film_lookup_key: entry.film_lookup_key,
          box_count: entry.box_count,
          in_catalog: entry.in_catalog,
          reason_source: entry.reason_source || "",
        })),
      });

      for (const alias of aliases) {
        fuzzyMappings.push({
          mapping_key: `${alias.old_manufacturer_lookup_key}|${alias.old_film_name_lookup_key}`,
          group_id: groupId,
          reason_source: SECURITY_REASON_FUZZY_REVIEW,
          old_manufacturer: alias.old_manufacturer,
          old_manufacturer_lookup_key: alias.old_manufacturer_lookup_key,
          alias_film_name: alias.old_film_name,
          old_film_name_lookup_key: alias.old_film_name_lookup_key,
          manufacturer: canonical.manufacturer,
          manufacturer_lookup_key: canonical.manufacturer_lookup_key,
          canonical_film_name: canonical.film_name,
          canonical_film_lookup_key: canonical.film_lookup_key,
          canonical_box_count: Number(canonicalTotals.get(canonicalKey) || canonical.box_count),
          alias_box_count: alias.box_count,
        });
      }
    }
  }

  const mappingsByKey = new Map();
  for (const mapping of directMappings) {
    mappingsByKey.set(mapping.mapping_key, mapping);
  }
  for (const mapping of fuzzyMappings) {
    if (!mappingsByKey.has(mapping.mapping_key)) {
      mappingsByKey.set(mapping.mapping_key, mapping);
    }
  }

  const mappingRows = [...mappingsByKey.values()];

  groups.sort((left, right) => {
    if (right.total_boxes !== left.total_boxes) {
      return right.total_boxes - left.total_boxes;
    }
    const manufacturerCompare = left.manufacturer.localeCompare(right.manufacturer, undefined, { sensitivity: "base" });
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }
    return left.group_id.localeCompare(right.group_id);
  });

  const reasonPriority = (reasonSource) => {
    if (reasonSource === SECURITY_REASON_FUZZY_REVIEW) return 99;
    if (reasonSource === "mil_rule") return 1;
    if (reasonSource === "s800_rule") return 2;
    if (reasonSource === "s70_rule") return 3;
    if (reasonSource === "s140_rule") return 4;
    if (reasonSource === "ag_rule") return 5;
    return 10;
  };

  mappingRows.sort((left, right) => {
    const reasonOrder = reasonPriority(left.reason_source) - reasonPriority(right.reason_source);
    if (reasonOrder !== 0) {
      return reasonOrder;
    }
    if (right.alias_box_count !== left.alias_box_count) {
      return right.alias_box_count - left.alias_box_count;
    }
    const manufacturerCompare = left.manufacturer.localeCompare(right.manufacturer, undefined, { sensitivity: "base" });
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }
    const canonicalCompare = left.canonical_film_name.localeCompare(right.canonical_film_name, undefined, { sensitivity: "base" });
    if (canonicalCompare !== 0) {
      return canonicalCompare;
    }
    return left.alias_film_name.localeCompare(right.alias_film_name, undefined, { sensitivity: "base" });
  });

  return { groups, mappingRows };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = Boolean(args.apply);

  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing env file: ${envPath}`);
  }

  const env = parseEnv(envPath);
  const databaseUrl = args["database-url"] ? String(args["database-url"]) : env.DATABASE_URL;
  const orgId = args["org-id"] ? String(args["org-id"]) : env.DEFAULT_ORG_ID;
  const actor = args.actor ? normalizeCollapsedLabel(args.actor) : "film-name-canonicalization-script";
  if (!databaseUrl) throw new Error("DATABASE_URL missing in backend/.env");
  if (!orgId) throw new Error("DEFAULT_ORG_ID missing in backend/.env");

  const reportDir = args["report-dir"]
    ? path.resolve(repoRoot, String(args["report-dir"]))
    : path.join(backendDir, "migration-dry-runs", "film-name-canonicalization");
  const groupsJsonPath = path.join(reportDir, "film_name_similarity_groups.json");
  const decisionCsvPath = args["decision-csv"]
    ? path.resolve(repoRoot, String(args["decision-csv"]))
    : path.join(reportDir, "film_name_decisions.csv");
  const preflightJsonPath = path.join(reportDir, "film_name_preflight.json");
  const summaryJsonPath = path.join(reportDir, "film_name_summary.json");
  const approvedMappingCsvPath = path.join(reportDir, "film_name_approved_mappings.csv");
  const filmCatalogCollisionCsvPath = path.join(reportDir, "film_name_film_catalog_collisions.csv");
  const requirementCollisionCsvPath = path.join(reportDir, "film_name_job_requirement_collisions.csv");

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query("begin");

    const source = await loadSourceRows(client, orgId);
    const { groups, mappingRows } = buildSimilarityCandidates(source);
    const dedupedMappingRows = dedupeMappingRows(mappingRows);

    const existingDecisionMap = parseExistingDecisionMap(decisionCsvPath);
    const decisionRows = buildDecisionRows(dedupedMappingRows, existingDecisionMap);
    const decisionSummary = summarizeDecisions(decisionRows);
    const suggestedMappings = toMappingPayload(dedupedMappingRows);

    const approvedMappings = decisionRows
      .filter((row) => normalizeCollapsedLabel(row.decision).toLowerCase() === "approve")
      .map((row) => ({
        mapping_key: row.mapping_key,
        old_manufacturer_lookup_key: row.old_manufacturer_lookup_key,
        old_film_name_lookup_key: row.old_film_name_lookup_key,
        canonical_manufacturer: row.manufacturer,
        canonical_manufacturer_lookup_key: row.manufacturer_lookup_key,
        canonical_film_name: row.canonical_film_name,
      }));

    const preflightAllSuggested = await buildPreflight(client, orgId, suggestedMappings);

    const preflight = await buildPreflight(client, orgId, approvedMappings);
    const blockers = {
      film_catalog_key_collisions: preflight.preflight_blockers.film_catalog_key_collisions.length,
      job_requirement_lookup_collisions: preflight.preflight_blockers.job_requirement_lookup_collisions.length,
    };

    let updatesApplied = {
      aliases_upserted: 0,
      boxes: 0,
      film_catalog: 0,
      job_requirements: 0,
      film_orders: 0,
      roll_weight_log: 0,
    };
    let postApply = null;

    if (apply) {
      if (decisionSummary.pending > 0) {
        throw new Error(
          `Cannot apply while decisions are pending (${decisionSummary.pending}). Fill decision column with approve/reject for every mapping row.`,
        );
      }

      if (blockers.film_catalog_key_collisions > 0 || blockers.job_requirement_lookup_collisions > 0) {
        throw new Error(
          `Preflight blocked apply: film_catalog_key_collisions=${blockers.film_catalog_key_collisions}, job_requirement_lookup_collisions=${blockers.job_requirement_lookup_collisions}`,
        );
      }

      updatesApplied = await runApply(client, orgId, actor, approvedMappings);
      postApply = await buildPreflight(client, orgId, approvedMappings);
    }

    await client.query(apply ? "commit" : "rollback");

    fs.mkdirSync(reportDir, { recursive: true });

    fs.writeFileSync(groupsJsonPath, `${JSON.stringify(groups, null, 2)}\n`, "utf8");
    fs.writeFileSync(decisionCsvPath, toDecisionCsv(decisionRows), "utf8");
    fs.writeFileSync(
      approvedMappingCsvPath,
      toSimpleCsv(
        approvedMappings.map((row) => ({
          mapping_key: row.mapping_key,
          old_manufacturer_lookup_key: row.old_manufacturer_lookup_key,
          old_film_name_lookup_key: row.old_film_name_lookup_key,
          canonical_manufacturer: row.canonical_manufacturer,
          canonical_manufacturer_lookup_key: row.canonical_manufacturer_lookup_key,
          canonical_film_name: row.canonical_film_name,
        })),
        [
          "mapping_key",
          "old_manufacturer_lookup_key",
          "old_film_name_lookup_key",
          "canonical_manufacturer",
          "canonical_manufacturer_lookup_key",
          "canonical_film_name",
        ],
      ),
      "utf8",
    );

    const preflightForArtifacts = apply ? preflight : preflightAllSuggested;

    fs.writeFileSync(
      filmCatalogCollisionCsvPath,
      toSimpleCsv(
        preflightForArtifacts.preflight_blockers.film_catalog_key_collisions.map((row) => ({
          canonical_film_key: row.canonical_film_key,
          row_count: row.row_count,
          source_film_keys: Array.isArray(row.source_film_keys) ? row.source_film_keys.join(";") : "",
        })),
        ["canonical_film_key", "row_count", "source_film_keys"],
      ),
      "utf8",
    );
    fs.writeFileSync(
      requirementCollisionCsvPath,
      toSimpleCsv(
        preflightForArtifacts.preflight_blockers.job_requirement_lookup_collisions.map((row) => ({
          job_id: row.job_id,
          job_number: row.job_number,
          canonical_lookup_key: row.canonical_lookup_key,
          row_count: row.row_count,
          source_requirement_ids: Array.isArray(row.source_requirement_ids)
            ? row.source_requirement_ids.join(";")
            : "",
        })),
        ["job_id", "job_number", "canonical_lookup_key", "row_count", "source_requirement_ids"],
      ),
      "utf8",
    );

    fs.writeFileSync(
      preflightJsonPath,
      `${JSON.stringify(
        {
          from_all_suggested: preflightAllSuggested,
          from_approved: preflight,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const summary = {
      generated_at_utc: new Date().toISOString(),
      org_id: orgId,
      apply,
      report_dir: toPosixPath(path.relative(repoRoot, reportDir)),
      source_baseline: {
        distinct_box_labels: source.boxes.length,
        distinct_catalog_labels: source.catalog.length,
      },
      grouping: {
        similarity_group_count: groups.length,
        mapping_row_count: dedupedMappingRows.length,
      },
      decisions: decisionSummary,
      approved_mapping_count: approvedMappings.length,
      blockers,
      projected_updates_from_all_suggested: preflightAllSuggested.candidate_updates,
      projected_blockers_from_all_suggested: {
        film_catalog_key_collisions: preflightAllSuggested.preflight_blockers.film_catalog_key_collisions.length,
        job_requirement_lookup_collisions:
          preflightAllSuggested.preflight_blockers.job_requirement_lookup_collisions.length,
      },
      candidate_updates_from_approved: preflight.candidate_updates,
      updates_applied: updatesApplied,
      post_apply: postApply,
      artifacts: {
        groups_json: toPosixPath(path.relative(repoRoot, groupsJsonPath)),
        decisions_csv: toPosixPath(path.relative(repoRoot, decisionCsvPath)),
        preflight_json: toPosixPath(path.relative(repoRoot, preflightJsonPath)),
        summary_json: toPosixPath(path.relative(repoRoot, summaryJsonPath)),
        approved_mapping_csv: toPosixPath(path.relative(repoRoot, approvedMappingCsvPath)),
        film_catalog_collision_csv: toPosixPath(path.relative(repoRoot, filmCatalogCollisionCsvPath)),
        job_requirement_collision_csv: toPosixPath(path.relative(repoRoot, requirementCollisionCsvPath)),
      },
    };

    fs.writeFileSync(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    console.log(
      JSON.stringify(
        {
          org_id: orgId,
          apply,
          similarity_group_count: groups.length,
          mapping_row_count: dedupedMappingRows.length,
          decision_summary: decisionSummary,
          blockers,
          updates_applied: updatesApplied,
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
