import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const envPath = path.join(backendDir, ".env");

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

function parseEnv(content) {
  const out = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    out[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return out;
}

function normalize(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function lower(value) {
  return normalize(value).toLowerCase();
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}

function writeCsv(filePath, rows, headers) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(","));
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const key = lower(value);
  if (["1", "true", "yes", "y", "on"].includes(key)) return true;
  if (["0", "false", "no", "n", "off"].includes(key)) return false;
  return fallback;
}

function parseInteger(value, fallback) {
  const next = Number(value);
  return Number.isInteger(next) ? next : fallback;
}

function canonicalizeManufacturer(rawManufacturer) {
  const key = lower(rawManufacturer);
  if (!key) return "";

  if (key === "3m" || key === "3m solar") return "3M Solar";
  if (key === "3m fasara" || key === "fasara") return "3M Fasara";
  if (key === "solar gard" || key === "solar guard" || key === "solargard" || key === "sg") return "Solar Gard";
  if (key === "avery" || key === "avery dennison") return "Avery Dennison";
  if (key === "di-noc" || key === "dinoc") return "Di-Noc";
  if (key === "llumar" || key === "llumar vista") return "Llumar";
  if (key === "security") return "Security";
  if (key === "solyx" || key === "sol") return "SOLYX";
  if (key === "vinyl") return "Vinyl";
  if (key === "aswfvkool" || key === "v-kool" || key === "vkool") return "ASWFVKOOL";
  return normalize(rawManufacturer);
}

function manufacturerPrefixPatterns(manufacturer) {
  if (manufacturer === "3M Solar") {
    return [/^3m\s+/i];
  }
  if (manufacturer === "3M Fasara") {
    return [/^3m\s+fasara\s+/i, /^fasara\s+/i, /^3m\s+/i];
  }
  if (manufacturer === "Solar Gard") {
    return [/^sg\s+/i, /^solar\s*guard\s+/i, /^solar\s+gard\s+/i, /^solarguard\s+/i];
  }
  if (manufacturer === "Llumar") {
    return [/^llumar\s+vista\s+/i, /^llumarvista\s+/i, /^llumar\s+/i];
  }
  if (manufacturer === "Avery Dennison") {
    return [/^avery\s+dennison\s+/i, /^avery\s+/i, /^ad\s+/i];
  }
  if (manufacturer === "SOLYX") {
    return [/^solyx\s+/i, /^sol\s+/i];
  }
  if (manufacturer === "Security") {
    return [/^security\s+/i];
  }
  return [];
}

function stripManufacturerPrefixes(manufacturer, filmName) {
  let value = normalize(filmName);
  let changed = true;
  const patterns = manufacturerPrefixPatterns(manufacturer);
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const next = normalize(value.replace(pattern, ""));
      if (next && next !== value) {
        value = next;
        changed = true;
      }
    }
  }
  return value;
}

function cleanVariantText(rawText) {
  return normalize(
    String(rawText ?? "")
      .replace(/\bexterior\b/gi, "ext")
      .replace(/[\"'`]/g, " ")
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\((.*?)\)/g, " ")
      .replace(/\[(.*?)\]/g, " ")
  );
}

function toFingerprint(rawText) {
  return cleanVariantText(rawText).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function hasNonFilmTerms(rawText) {
  return /(caulk|silicone|sealant|ipa\b|dow\s*995|dow\s*795|adhesive)/i.test(lower(rawText));
}

function extractModelTokens(rawText) {
  const source = normalize(rawText).toUpperCase();
  const tokens = new Set();
  const add = (value) => {
    const compact = String(value ?? "").replace(/[^A-Z0-9]/g, "");
    if (!compact || compact.length < 3 || !/\d/.test(compact)) return;
    tokens.add(compact);
  };

  for (const match of source.matchAll(/\b(?:SH|SX|SXC|SXR|SXP|SXJ|SXWF|SXD|SXF|SXSC|SXL|SXMD|SXWV|SXO|SXSG|SXGF)[A-Z0-9-]*\b/g)) {
    add(match[0]);
  }
  for (const match of source.matchAll(/\bPR\s*-?\s*(\d{1,3})(\s*EXT)?\b/g)) {
    add(`PR${match[1]}${match[2] ? "EXT" : ""}`);
  }
  for (const match of source.matchAll(/\bNV\s*-?\s*(\d{1,3})\b/g)) {
    add(`NV${match[1]}`);
  }
  for (const match of source.matchAll(/\bAG\s*-?\s*(\d{1,3})\b/g)) {
    add(`AG${match[1]}`);
  }
  for (const match of source.matchAll(/\bV\s*-?\s*(\d{2,3})\b/g)) {
    add(`V${match[1]}`);
  }
  for (const match of source.matchAll(/\bN\d{3,4}[A-Z]?\b/g)) {
    add(match[0]);
  }
  return tokens;
}

function makeFilmKey(manufacturer, filmName) {
  return `${normalize(manufacturer).toUpperCase()}|${normalize(filmName).toUpperCase()}`;
}

async function loadCatalog(client, orgId) {
  const rows = (
    await client.query(
      `
      select manufacturer, film_name, film_key
      from app.film_catalog
      where org_id = $1
      `,
      [orgId]
    )
  ).rows;

  const byManufacturer = new Map();
  for (const row of rows) {
    const canonicalManufacturer = canonicalizeManufacturer(row.manufacturer);
    const base = stripManufacturerPrefixes(canonicalManufacturer, row.film_name);
    const entry = {
      manufacturer: row.manufacturer,
      film_name: row.film_name,
      film_key: row.film_key,
      canonical_manufacturer: canonicalManufacturer,
      fingerprint: toFingerprint(base),
      model_tokens: extractModelTokens(row.film_name)
    };
    if (!byManufacturer.has(canonicalManufacturer)) {
      byManufacturer.set(canonicalManufacturer, []);
    }
    byManufacturer.get(canonicalManufacturer).push(entry);
  }

  return byManufacturer;
}

async function loadUnmatchedCombos(client, orgId) {
  return (
    await client.query(
      `
      with catalog as (
        select
          lower(trim(regexp_replace(manufacturer, '\\s+', ' ', 'g'))) as manufacturer_key,
          lower(trim(regexp_replace(film_name, '\\s+', ' ', 'g'))) as film_key
        from app.film_catalog
        where org_id = $1
      ),
      combos as (
        select
          manufacturer,
          film_name,
          count(*)::int as box_count,
          string_agg(distinct warehouse, '|' order by warehouse) as warehouses,
          lower(trim(regexp_replace(manufacturer, '\\s+', ' ', 'g'))) as manufacturer_key,
          lower(trim(regexp_replace(film_name, '\\s+', ' ', 'g'))) as film_key
        from app.boxes
        where org_id = $1
        group by manufacturer, film_name
      )
      select manufacturer, film_name, box_count, warehouses
      from combos b
      left join catalog c
        on c.manufacturer_key = b.manufacturer_key
       and c.film_key = b.film_key
      where c.manufacturer_key is null
      order by box_count desc, manufacturer, film_name
      `,
      [orgId]
    )
  ).rows;
}

function buildRecommendations(unmatchedRows, catalogByManufacturer) {
  const recommendations = [];

  for (const row of unmatchedRows) {
    const canonicalManufacturer = canonicalizeManufacturer(row.manufacturer);
    const catalogEntries = catalogByManufacturer.get(canonicalManufacturer) || [];
    const strippedSource = stripManufacturerPrefixes(canonicalManufacturer, row.film_name);
    const sourceFingerprint = toFingerprint(strippedSource);

    if (hasNonFilmTerms(row.film_name)) {
      recommendations.push({
        manufacturer: row.manufacturer,
        film_name: row.film_name,
        box_count: Number(row.box_count || 0),
        warehouses: row.warehouses || "",
        recommendation: "IGNORE_NON_FILM",
        target_manufacturer: "",
        target_film_name: "",
        reason: "contains caulk/sealant/consumable terms",
        confidence: "high"
      });
      continue;
    }

    const fingerprintMatches = catalogEntries.filter((entry) => entry.fingerprint && entry.fingerprint === sourceFingerprint);
    if (fingerprintMatches.length === 1) {
      recommendations.push({
        manufacturer: row.manufacturer,
        film_name: row.film_name,
        box_count: Number(row.box_count || 0),
        warehouses: row.warehouses || "",
        recommendation: "MAP_EXISTING",
        target_manufacturer: fingerprintMatches[0].manufacturer,
        target_film_name: fingerprintMatches[0].film_name,
        reason: "normalized fingerprint exact match",
        confidence: "high"
      });
      continue;
    }

    if (fingerprintMatches.length > 1) {
      const pick = fingerprintMatches
        .slice()
        .sort((left, right) => left.film_name.length - right.film_name.length || left.film_name.localeCompare(right.film_name))[0];
      recommendations.push({
        manufacturer: row.manufacturer,
        film_name: row.film_name,
        box_count: Number(row.box_count || 0),
        warehouses: row.warehouses || "",
        recommendation: "REVIEW_MAP_CANDIDATE",
        target_manufacturer: pick.manufacturer,
        target_film_name: pick.film_name,
        reason: `multiple normalized matches (${fingerprintMatches.length})`,
        confidence: "medium"
      });
      continue;
    }

    const sourceTokens = extractModelTokens(row.film_name);
    const tokenMatches = catalogEntries.filter((entry) => {
      for (const token of sourceTokens) {
        if (entry.model_tokens.has(token)) return true;
      }
      return false;
    });

    if (tokenMatches.length === 1) {
      recommendations.push({
        manufacturer: row.manufacturer,
        film_name: row.film_name,
        box_count: Number(row.box_count || 0),
        warehouses: row.warehouses || "",
        recommendation: "REVIEW_MAP_CANDIDATE",
        target_manufacturer: tokenMatches[0].manufacturer,
        target_film_name: tokenMatches[0].film_name,
        reason: "single shared model token",
        confidence: "medium"
      });
      continue;
    }

    recommendations.push({
      manufacturer: row.manufacturer,
      film_name: row.film_name,
      box_count: Number(row.box_count || 0),
      warehouses: row.warehouses || "",
      recommendation: "ADD_TO_CATALOG",
      target_manufacturer: canonicalManufacturer,
      target_film_name: strippedSource || normalize(row.film_name),
      reason: tokenMatches.length > 1 ? `multiple token candidates (${tokenMatches.length})` : "no catalog candidate",
      confidence: tokenMatches.length > 1 ? "low" : "medium"
    });
  }

  return recommendations.map((row, index) => ({ row_num: index + 1, ...row }));
}

function buildDecisions(selectedRows, options = {}) {
  const onlySafe = Boolean(options.onlySafe);
  const decisions = [];
  for (const row of selectedRows) {
    if (row.recommendation === "IGNORE_NON_FILM") {
      decisions.push({
        row_num: row.row_num,
        source_manufacturer: row.manufacturer,
        source_film_name: row.film_name,
        box_count: row.box_count,
        action: "SKIP",
        reason: "ignore_non_film",
        target_manufacturer: "",
        target_film_name: ""
      });
      continue;
    }

    if (row.recommendation === "REVIEW_MAP_CANDIDATE" && onlySafe) {
      decisions.push({
        row_num: row.row_num,
        source_manufacturer: row.manufacturer,
        source_film_name: row.film_name,
        box_count: row.box_count,
        action: "SKIP",
        reason: "review_required",
        target_manufacturer: "",
        target_film_name: ""
      });
      continue;
    }

    if (row.recommendation === "MAP_EXISTING" || row.recommendation === "REVIEW_MAP_CANDIDATE") {
      decisions.push({
        row_num: row.row_num,
        source_manufacturer: row.manufacturer,
        source_film_name: row.film_name,
        box_count: row.box_count,
        action: "MAP_EXISTING",
        reason: row.recommendation.toLowerCase(),
        target_manufacturer: row.target_manufacturer,
        target_film_name: row.target_film_name
      });
      continue;
    }

    decisions.push({
      row_num: row.row_num,
      source_manufacturer: row.manufacturer,
      source_film_name: row.film_name,
      box_count: row.box_count,
      action: "ADD_AND_MAP",
      reason: "add_to_catalog",
      target_manufacturer: row.target_manufacturer,
      target_film_name: row.target_film_name
    });
  }

  return decisions;
}

async function loadCoverage(client, orgId) {
  const aggregate = (
    await client.query(
      `
      with catalog as (
        select
          lower(trim(regexp_replace(manufacturer, '\\s+', ' ', 'g'))) as m_key,
          lower(trim(regexp_replace(film_name, '\\s+', ' ', 'g'))) as f_key
        from app.film_catalog
        where org_id = $1
      ),
      boxes_norm as (
        select
          lower(trim(regexp_replace(manufacturer, '\\s+', ' ', 'g'))) as m_key,
          lower(trim(regexp_replace(film_name, '\\s+', ' ', 'g'))) as f_key
        from app.boxes
        where org_id = $1
      )
      select
        count(*)::int as total_boxes,
        count(*) filter (where c.m_key is not null)::int as matched_boxes,
        count(*) filter (where c.m_key is null)::int as unmatched_boxes
      from boxes_norm b
      left join catalog c on c.m_key = b.m_key and c.f_key = b.f_key
      `,
      [orgId]
    )
  ).rows[0];

  const unmatchedDistinct = (
    await client.query(
      `
      with catalog as (
        select
          lower(trim(regexp_replace(manufacturer, '\\s+', ' ', 'g'))) as m_key,
          lower(trim(regexp_replace(film_name, '\\s+', ' ', 'g'))) as f_key
        from app.film_catalog
        where org_id = $1
      ),
      combos as (
        select
          manufacturer,
          film_name,
          lower(trim(regexp_replace(manufacturer, '\\s+', ' ', 'g'))) as m_key,
          lower(trim(regexp_replace(film_name, '\\s+', ' ', 'g'))) as f_key
        from app.boxes
        where org_id = $1
        group by manufacturer, film_name
      )
      select count(*)::int as unmatched_distinct
      from combos b
      left join catalog c on c.m_key = b.m_key and c.f_key = b.f_key
      where c.m_key is null
      `,
      [orgId]
    )
  ).rows[0];

  return {
    total_boxes: Number(aggregate.total_boxes || 0),
    matched_boxes: Number(aggregate.matched_boxes || 0),
    unmatched_boxes: Number(aggregate.unmatched_boxes || 0),
    unmatched_distinct: Number(unmatchedDistinct.unmatched_distinct || 0)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const start = Math.max(1, parseInteger(args.start, 1));
  const end = Math.max(start, parseInteger(args.end, start));
  const limit = Math.max(end, parseInteger(args.limit, 200));
  const apply = parseBoolean(args.apply, false);
  const onlySafe = parseBoolean(args["only-safe"], false);

  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing env file: ${envPath}`);
  }
  const env = parseEnv(fs.readFileSync(envPath, "utf8"));
  const databaseUrl = env.DATABASE_URL || env.SUPABASE_DB_URL;
  const orgId = env.DEFAULT_ORG_ID;
  if (!databaseUrl) throw new Error("DATABASE_URL (or SUPABASE_DB_URL) missing in backend/.env");
  if (!orgId) throw new Error("DEFAULT_ORG_ID missing in backend/.env");

  const reviewCsvPath = args["review-csv"]
    ? path.resolve(backendDir, String(args["review-csv"]))
    : path.join(backendDir, "docs", "inventory_catalog_manual_review_batch_top200.csv");
  const applyJsonPath = args["apply-json"]
    ? path.resolve(backendDir, String(args["apply-json"]))
    : path.join(backendDir, "docs", `inventory_catalog_manual_review_applied_${start}_${end}.json`);

  const client = new Client({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? undefined : { rejectUnauthorized: false }
  });

  await client.connect();
  try {
    await client.query("begin");

    const catalogByManufacturer = await loadCatalog(client, orgId);
    const unmatchedRows = await loadUnmatchedCombos(client, orgId);
    const recommendations = buildRecommendations(unmatchedRows, catalogByManufacturer);
    const limited = recommendations.slice(0, limit);

    writeCsv(
      reviewCsvPath,
      limited,
      [
        "row_num",
        "manufacturer",
        "film_name",
        "box_count",
        "warehouses",
        "recommendation",
        "target_manufacturer",
        "target_film_name",
        "reason",
        "confidence"
      ]
    );

    const selected = limited.filter((row) => row.row_num >= start && row.row_num <= end);
    const decisions = buildDecisions(selected, { onlySafe });
    const actionable = decisions.filter((decision) => decision.action !== "SKIP");

    const coverageBefore = await loadCoverage(client, orgId);

    let catalogInserted = 0;
    let totalUpdatedRows = 0;
    const appliedRows = [];
    for (const decision of actionable) {
      const targetManufacturer = normalize(decision.target_manufacturer);
      const targetFilmName = normalize(decision.target_film_name);
      if (!targetManufacturer || !targetFilmName) {
        appliedRows.push({
          ...decision,
          status: "skipped_missing_target",
          affected_rows: 0
        });
        continue;
      }

      const filmKey = makeFilmKey(targetManufacturer, targetFilmName);
      const upsertResult = await client.query(
        `
        insert into app.film_catalog (
          org_id,
          film_key,
          manufacturer,
          film_name,
          notes,
          updated_at
        )
        values ($1, $2, $3, $4, '', now())
        on conflict (org_id, film_key)
        do update set
          manufacturer = excluded.manufacturer,
          film_name = excluded.film_name,
          updated_at = now()
        returning xmax = 0 as inserted
        `,
        [orgId, filmKey, targetManufacturer, targetFilmName]
      );
      if (upsertResult.rows[0]?.inserted) {
        catalogInserted += 1;
      }

      const updateResult = await client.query(
        `
        update app.boxes
        set
          manufacturer = $1,
          film_name = $2,
          film_key = $3,
          updated_at = now()
        where org_id = $4
          and manufacturer = $5
          and film_name = $6
        `,
        [
          targetManufacturer,
          targetFilmName,
          filmKey,
          orgId,
          decision.source_manufacturer,
          decision.source_film_name
        ]
      );
      const affectedRows = Number(updateResult.rowCount || 0);
      totalUpdatedRows += affectedRows;
      appliedRows.push({
        ...decision,
        target_manufacturer: targetManufacturer,
        target_film_name: targetFilmName,
        film_key: filmKey,
        status: "applied",
        affected_rows: affectedRows
      });
    }

    if (apply) {
      await client.query("commit");
    } else {
      await client.query("rollback");
    }

    const coverageAfter = apply ? await loadCoverage(client, orgId) : coverageBefore;

    const output = {
      generated_at_utc: new Date().toISOString(),
      apply,
      only_safe: onlySafe,
      org_id: orgId,
      review_csv: reviewCsvPath.replace(/\\/g, "/"),
      range: { start, end },
      recommendation_limit: limit,
      selected_row_count: selected.length,
      decision_count: decisions.length,
      actionable_count: actionable.length,
      skipped_count: decisions.length - actionable.length,
      catalog_inserted: catalogInserted,
      total_rows_updated: totalUpdatedRows,
      coverage_before: coverageBefore,
      coverage_after: coverageAfter,
      selected_rows: selected,
      decisions,
      applied_rows: appliedRows
    };

    fs.mkdirSync(path.dirname(applyJsonPath), { recursive: true });
    fs.writeFileSync(applyJsonPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

    console.log(
      JSON.stringify(
        {
          apply,
          only_safe: onlySafe,
          org_id: orgId,
          range: { start, end },
          selected_row_count: selected.length,
          actionable_count: actionable.length,
          skipped_count: decisions.length - actionable.length,
          catalog_inserted: catalogInserted,
          total_rows_updated: totalUpdatedRows,
          coverage_before: coverageBefore,
          coverage_after: coverageAfter,
          review_csv: reviewCsvPath.replace(/\\/g, "/"),
          output_json: applyJsonPath.replace(/\\/g, "/")
        },
        null,
        2
      )
    );
  } finally {
    try {
      await client.end();
    } catch {
      // no-op
    }
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
