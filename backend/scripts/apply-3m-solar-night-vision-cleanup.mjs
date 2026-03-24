import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const envPath = path.join(backendDir, ".env");

const MANUFACTURER = "3M Solar";
const DEFAULT_ACTOR = "3m-solar-night-vision-cleanup-script";
const MUTATION_TABLES = ["boxes", "job_requirements", "film_orders", "roll_weight_log"];

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

function parseEnv(content) {
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
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

function normalizeCollapsedLabel(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeLookup(value) {
  return normalizeCollapsedLabel(value).toLowerCase();
}

function canonicalizeNumericDigits(value) {
  const digitsOnly = String(value ?? "").replace(/[^0-9]/g, "");
  const withoutLeadingZeros = digitsOnly.replace(/^0+/, "");
  return withoutLeadingZeros || "0";
}

function inferNightVisionCode(value) {
  const normalized = normalizeCollapsedLabel(value);
  const nightVisionMatch = normalized.match(/\bnight\s*vision\s*(\d{1,3})\b/i);
  if (nightVisionMatch) {
    return canonicalizeNumericDigits(nightVisionMatch[1]);
  }

  const snvMatch = normalized.match(/\bs?nv\s*[-]?\s*(\d{1,3})\b/i);
  if (snvMatch) {
    return canonicalizeNumericDigits(snvMatch[1]);
  }

  const securityNvMatch = normalized.match(/\bs\s*(\d{1,3})\s*nv\b/i);
  if (securityNvMatch) {
    return canonicalizeNumericDigits(securityNvMatch[1]);
  }

  return "";
}

function canonicalizeNightVisionFilmName(value) {
  const code = inferNightVisionCode(value);
  if (!code) {
    return "";
  }
  return `Night Vision ${code}`;
}

function buildFilmKey(manufacturer, filmName) {
  return `${normalizeCollapsedLabel(manufacturer).toUpperCase()}|${normalizeCollapsedLabel(filmName).toUpperCase()}`;
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}

function toSimpleCsv(rows, headers) {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header] ?? "")).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function sortByCanonicalThenVariant(left, right) {
  const leftCanonical = normalizeLookup(left.canonical_film_name);
  const rightCanonical = normalizeLookup(right.canonical_film_name);
  if (leftCanonical !== rightCanonical) {
    return leftCanonical < rightCanonical ? -1 : 1;
  }
  const leftVariant = normalizeLookup(left.old_film_name);
  const rightVariant = normalizeLookup(right.old_film_name);
  return leftVariant < rightVariant ? -1 : leftVariant > rightVariant ? 1 : 0;
}

async function listDistinctFilmNames(client, orgId, tableName) {
  const result = await client.query(
    `
      select film_name, count(*)::int as row_count
      from app.${tableName}
      where org_id = $1
        and manufacturer = $2
      group by film_name
      order by film_name
    `,
    [orgId, MANUFACTURER]
  );
  return result.rows;
}

async function listNightVisionCatalogRows(client, orgId) {
  const result = await client.query(
    `
      select id, film_name, film_key, coalesce(notes, '') as notes
      from app.film_catalog
      where org_id = $1
        and manufacturer = $2
      order by film_name
    `,
    [orgId, MANUFACTURER]
  );
  return result.rows.filter((row) => canonicalizeNightVisionFilmName(row.film_name));
}

function mergeNotes(rows) {
  const ordered = [];
  const seen = new Set();
  for (const row of rows) {
    const raw = normalizeCollapsedLabel(row.notes);
    if (!raw) {
      continue;
    }
    for (const part of raw.split("|")) {
      const next = normalizeCollapsedLabel(part);
      const key = normalizeLookup(next);
      if (!next || seen.has(key)) {
        continue;
      }
      seen.add(key);
      ordered.push(next);
    }
  }
  return ordered.join(" | ");
}

async function ensureCanonicalCatalogRow(client, orgId, canonicalFilmName, groupedCatalogRows, summary) {
  const rows = groupedCatalogRows.filter(
    (row) => normalizeLookup(canonicalizeNightVisionFilmName(row.film_name)) === normalizeLookup(canonicalFilmName)
  );
  const expectedFilmKey = buildFilmKey(MANUFACTURER, canonicalFilmName);
  const mergedNotes = mergeNotes(rows);
  let keeper =
    rows.find((row) => normalizeLookup(row.film_name) === normalizeLookup(canonicalFilmName)) ||
    rows[0] ||
    null;

  if (!keeper) {
    const insertResult = await client.query(
      `
        insert into app.film_catalog (
          id,
          org_id,
          manufacturer,
          film_name,
          film_key,
          notes,
          updated_at
        )
        values (
          gen_random_uuid(),
          $1,
          $2,
          $3,
          $4,
          $5,
          now()
        )
        returning id, film_name, film_key, coalesce(notes, '') as notes
      `,
      [orgId, MANUFACTURER, canonicalFilmName, expectedFilmKey, mergedNotes]
    );
    summary.catalogInserted += insertResult.rowCount ?? 0;
    keeper = insertResult.rows[0];
  } else if (
    normalizeLookup(keeper.film_name) !== normalizeLookup(canonicalFilmName) ||
    normalizeLookup(keeper.film_key) !== normalizeLookup(expectedFilmKey) ||
    normalizeCollapsedLabel(keeper.notes) !== mergedNotes
  ) {
    const updateResult = await client.query(
      `
        update app.film_catalog
        set film_name = $2,
            film_key = $3,
            notes = $4,
            updated_at = now()
        where id = $1
      `,
      [keeper.id, canonicalFilmName, expectedFilmKey, mergedNotes]
    );
    summary.catalogUpdated += updateResult.rowCount ?? 0;
    keeper = {
      ...keeper,
      film_name: canonicalFilmName,
      film_key: expectedFilmKey,
      notes: mergedNotes
    };
  }

  const duplicateIds = rows.filter((row) => row.id !== keeper.id).map((row) => row.id);
  if (duplicateIds.length > 0) {
    const deleteResult = await client.query(
      `
        delete from app.film_catalog
        where org_id = $1
          and id = any($2::uuid[])
      `,
      [orgId, duplicateIds]
    );
    summary.catalogDeleted += deleteResult.rowCount ?? 0;
  }
}

async function updateBoxesToCanonical(client, orgId, oldFilmName, canonicalFilmName, summary) {
  const canonicalFilmKey = buildFilmKey(MANUFACTURER, canonicalFilmName);
  const result = await client.query(
    `
      update app.boxes
      set film_name = $4,
          film_key = $5
      where org_id = $1
        and manufacturer = $2
        and app_api.normalize_catalog_lookup_key(film_name) = app_api.normalize_catalog_lookup_key($3)
        and app_api.normalize_catalog_lookup_key(film_name) <> app_api.normalize_catalog_lookup_key($4)
    `,
    [orgId, MANUFACTURER, oldFilmName, canonicalFilmName, canonicalFilmKey]
  );
  summary.tableUpdates.boxes += result.rowCount ?? 0;
}

async function updateTableFilmName(client, orgId, tableName, oldFilmName, canonicalFilmName, summary) {
  const result = await client.query(
    `
      update app.${tableName}
      set film_name = $4
      where org_id = $1
        and manufacturer = $2
        and app_api.normalize_catalog_lookup_key(film_name) = app_api.normalize_catalog_lookup_key($3)
        and app_api.normalize_catalog_lookup_key(film_name) <> app_api.normalize_catalog_lookup_key($4)
    `,
    [orgId, MANUFACTURER, oldFilmName, canonicalFilmName]
  );
  summary.tableUpdates[tableName] += result.rowCount ?? 0;
}

async function retargetExistingAliases(client, orgId, canonicalFilmName, variants, actor, summary) {
  const result = await client.query(
    `
      update app.film_name_aliases
      set canonical_film_name = $4,
          updated_at = now(),
          updated_by = $5
      where org_id = $1
        and manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key($2)
        and exists (
          select 1
          from unnest($3::text[]) as variant(name)
          where app_api.normalize_catalog_lookup_key(app.film_name_aliases.canonical_film_name)
            = app_api.normalize_catalog_lookup_key(variant.name)
        )
        and old_film_name_lookup_key <> app_api.normalize_catalog_lookup_key($4)
        and app_api.normalize_catalog_lookup_key(canonical_film_name) <> app_api.normalize_catalog_lookup_key($4)
    `,
    [orgId, MANUFACTURER, variants, canonicalFilmName, actor]
  );
  summary.aliasUpdated += result.rowCount ?? 0;
}

async function upsertAlias(client, orgId, oldFilmName, canonicalFilmName, actor, summary) {
  const result = await client.query(
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
        $1,
        app_api.normalize_catalog_manufacturer_lookup_key($2),
        app_api.normalize_catalog_lookup_key($3),
        app_api.normalize_collapsed_catalog_label($4),
        $5,
        $5
      where app_api.normalize_catalog_lookup_key($3) <> app_api.normalize_catalog_lookup_key($4)
      on conflict (org_id, manufacturer_lookup_key, old_film_name_lookup_key)
      do update
      set canonical_film_name = excluded.canonical_film_name,
          updated_at = now(),
          updated_by = excluded.updated_by
    `,
    [orgId, MANUFACTURER, oldFilmName, canonicalFilmName, actor]
  );
  summary.aliasUpserted += result.rowCount ?? 0;
}

function buildGeneratedAliasVariants(code) {
  const canonical = `Night Vision ${code}`;
  return [
    canonical,
    `Night Vision ${code} (NV${code})`,
    `NV${code}`,
    `NV ${code}`,
    `SNV${code}`,
    `Ultra SNV${code}`,
    `S${code}NV`,
    `Security 3M S${code}NV`
  ];
}

function collectCleanupMappings(distinctByTable) {
  const grouped = new Map();
  for (const [tableName, rows] of Object.entries(distinctByTable)) {
    for (const row of rows) {
      const oldFilmName = normalizeCollapsedLabel(row.film_name);
      const canonicalFilmName = canonicalizeNightVisionFilmName(oldFilmName);
      if (!canonicalFilmName || normalizeLookup(oldFilmName) === normalizeLookup(canonicalFilmName)) {
        continue;
      }

      const key = `${normalizeLookup(oldFilmName)}|${normalizeLookup(canonicalFilmName)}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          old_film_name: oldFilmName,
          canonical_film_name: canonicalFilmName,
          codes: new Set([inferNightVisionCode(oldFilmName)]),
          sources: {}
        });
      }

      const entry = grouped.get(key);
      entry.codes.add(inferNightVisionCode(oldFilmName));
      entry.sources[tableName] = (entry.sources[tableName] || 0) + Number(row.row_count || 0);
    }
  }

  return Array.from(grouped.values()).map((entry) => ({
    old_film_name: entry.old_film_name,
    canonical_film_name: entry.canonical_film_name,
    codes: Array.from(entry.codes).filter(Boolean).sort().join("|"),
    source_tables: Object.keys(entry.sources)
      .sort()
      .map((tableName) => `${tableName}:${entry.sources[tableName]}`)
      .join(" | ")
  })).sort(sortByCanonicalThenVariant);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = Boolean(args.apply);
  const actor = normalizeCollapsedLabel(args.actor || DEFAULT_ACTOR);
  const reportDir = args["report-dir"]
    ? path.resolve(String(args["report-dir"]))
    : path.join(backendDir, "migration-dry-runs", "3m-solar-night-vision-cleanup");

  const env = parseEnv(fs.readFileSync(envPath, "utf8"));
  const orgId = normalizeCollapsedLabel(env.DEFAULT_ORG_ID);
  if (!orgId) {
    throw new Error("DEFAULT_ORG_ID is required in backend/.env");
  }
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in backend/.env");
  }

  const client = new Client({
    connectionString: env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  try {
    const distinctByTable = {};
    for (const tableName of ["film_catalog", ...MUTATION_TABLES]) {
      distinctByTable[tableName] = await listDistinctFilmNames(client, orgId, tableName);
    }

    const cleanupMappings = collectCleanupMappings(distinctByTable);
    const catalogRows = await listNightVisionCatalogRows(client, orgId);
    const canonicalNames = new Set();
    for (const row of cleanupMappings) {
      canonicalNames.add(row.canonical_film_name);
    }
    for (const row of catalogRows) {
      canonicalNames.add(canonicalizeNightVisionFilmName(row.film_name));
    }

    const summary = {
      apply,
      orgId,
      actor,
      mappings: cleanupMappings.length,
      canonicalGroups: Array.from(canonicalNames).filter(Boolean).sort(),
      catalogInserted: 0,
      catalogUpdated: 0,
      catalogDeleted: 0,
      aliasUpserted: 0,
      aliasUpdated: 0,
      tableUpdates: Object.fromEntries(MUTATION_TABLES.map((tableName) => [tableName, 0]))
    };

    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, "night_vision_effective_mappings.csv"),
      toSimpleCsv(cleanupMappings, ["old_film_name", "canonical_film_name", "codes", "source_tables"]),
      "utf8"
    );

    await client.query("begin");
    try {
      for (const canonicalFilmName of summary.canonicalGroups) {
        await ensureCanonicalCatalogRow(client, orgId, canonicalFilmName, catalogRows, summary);
      }

      for (const mapping of cleanupMappings) {
        await updateBoxesToCanonical(client, orgId, mapping.old_film_name, mapping.canonical_film_name, summary);
        for (const tableName of MUTATION_TABLES.filter((entry) => entry !== "boxes")) {
          await updateTableFilmName(
            client,
            orgId,
            tableName,
            mapping.old_film_name,
            mapping.canonical_film_name,
            summary
          );
        }
      }

      for (const canonicalFilmName of summary.canonicalGroups) {
        const code = inferNightVisionCode(canonicalFilmName);
        const variants = new Set(buildGeneratedAliasVariants(code));
        for (const mapping of cleanupMappings) {
          if (normalizeLookup(mapping.canonical_film_name) === normalizeLookup(canonicalFilmName)) {
            variants.add(mapping.old_film_name);
          }
        }

        const variantList = Array.from(variants).sort((left, right) =>
          normalizeLookup(left) < normalizeLookup(right) ? -1 : normalizeLookup(left) > normalizeLookup(right) ? 1 : 0
        );
        await retargetExistingAliases(client, orgId, canonicalFilmName, variantList, actor, summary);
        for (const variant of variantList) {
          await upsertAlias(client, orgId, variant, canonicalFilmName, actor, summary);
        }
      }

      if (apply) {
        await client.query("commit");
      } else {
        await client.query("rollback");
      }
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // Surface the original error.
      }
      throw error;
    }

    fs.writeFileSync(
      path.join(reportDir, "night_vision_cleanup_summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8"
    );

    console.log(JSON.stringify(summary, null, 2));
    if (!apply) {
      console.log("Dry run only. Re-run with --apply to persist changes.");
    } else {
      console.log(`Cleanup applied. Reports written to ${reportDir}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
