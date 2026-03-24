import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const envPath = path.join(backendDir, ".env");
const snapshotPath = path.join(backendDir, "docs", "film_catalog_current_snapshot.csv");

const MANUFACTURER = "3M Solar";
const ACTOR = "3m-solar-prestige-cleanup-script";

const CANONICAL_GROUPS = [
  {
    canonical: 'Silver P-18',
    variants: ['P-18 Silver', 'P-18', 'Silver P-18 (P-18)', 'Silver P-18 P18ARL']
  },
  {
    canonical: 'Prestige 20',
    variants: ['Prestige 20 (PR20)', 'PR 20', 'Prestige 20X 60" F254325', 'PRX20']
  },
  {
    canonical: 'Prestige 20 Exterior',
    variants: ['Prestige 20 Exterior (PR20 Ext)', 'PR 20 Exterior', 'PR 20 EXT', 'PRX 20 Ext']
  },
  {
    canonical: 'Prestige 40',
    variants: ['Prestige 40 (PR40)', 'PR 40', 'PR 40X', 'Prestige 40X', 'PRX 40']
  },
  {
    canonical: 'Prestige 40 Exterior',
    variants: ['Prestige 40 Exterior (PR40 Ext)', 'PR 40 EXT', 'PRX 40 Ext', 'PRX 40 EXT']
  },
  {
    canonical: 'Prestige 50',
    variants: ['Prestige 50 (PR50)', 'PR 50', 'PR 50 60" F2963235', 'PR 50 72" Transfered To MS']
  },
  {
    canonical: 'Prestige 50 Exterior',
    variants: ['Prestige 50 Exterior (PR50 Ext)', 'PR 50 EXT']
  },
  {
    canonical: 'Prestige 60',
    variants: ['Prestige 60 (PR60)', 'PR 60']
  },
  {
    canonical: 'Prestige 60 Exterior',
    variants: ['PR 60 EXT']
  },
  {
    canonical: 'Prestige 70',
    variants: ['Prestige 70 (PR70)', 'PR 70', 'PR 70 72" B223557 - 3M PR 70 72" B225324055 05324055 0', 'PR 70X']
  },
  {
    canonical: 'Prestige 70 Exterior',
    variants: ['Prestige 70 Exterior (PR70 Ext)', 'PR 70 EXT', 'PRX 70 Ext']
  },
  {
    canonical: 'Prestige 90 Exterior',
    variants: ['Prestige 90 Exterior (PR90 Ext)', 'PR 90 EXT', 'PRX 90 Ext.']
  }
];

const DELETE_ONLY_FILM_NAMES = ['PR', 'Privacy Mirror', 'PS8', 'NV 35', 'Security 3M S25NV', 'Ultra SNV25'];

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
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

function normalizeCollapsedLabel(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function makeFilmKey(manufacturer, filmName) {
  return `${normalizeCollapsedLabel(manufacturer).toUpperCase()}|${normalizeCollapsedLabel(filmName).toUpperCase()}`;
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}

function distinct(values) {
  return [...new Set(values.map((value) => normalizeCollapsedLabel(value)).filter(Boolean))];
}

function mergeNotes(rows) {
  const seen = new Set();
  const ordered = [];
  for (const row of rows) {
    const raw = normalizeCollapsedLabel(row.notes);
    if (!raw) continue;
    for (const part of raw.split("|")) {
      const next = normalizeCollapsedLabel(part);
      if (!next) continue;
      const key = next.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(next);
    }
  }
  return ordered.join(" | ");
}

function withPrefixedVariants(variants) {
  const output = new Set();
  for (const variant of variants) {
    const normalized = normalizeCollapsedLabel(variant);
    if (!normalized) continue;
    output.add(normalized);
    if (!normalized.toLowerCase().startsWith("3m ")) {
      output.add(`3M ${normalized}`);
    }
  }
  return [...output];
}

async function loadCatalogRowsForNames(client, orgId, names) {
  const result = await client.query(
    `
      select id, film_name, film_key, notes
      from app.film_catalog
      where org_id = $1
        and manufacturer = $2
        and exists (
          select 1
          from unnest($3::text[]) as requested(name)
          where app_api.normalize_catalog_lookup_key(app.film_catalog.film_name)
            = app_api.normalize_catalog_lookup_key(requested.name)
        )
      order by film_name
    `,
    [orgId, MANUFACTURER, names]
  );
  return result.rows;
}

async function ensureCanonicalCatalogRow(client, orgId, canonicalFilmName, variants, summary) {
  const namesToLoad = distinct([canonicalFilmName, ...variants]);
  const rows = await loadCatalogRowsForNames(client, orgId, namesToLoad);
  const keeper =
    rows.find((row) => normalizeCollapsedLabel(row.film_name) === canonicalFilmName) ??
    variants
      .map((variant) => rows.find((row) => normalizeCollapsedLabel(row.film_name) === normalizeCollapsedLabel(variant)))
      .find(Boolean) ??
    null;

  const mergedNotes = mergeNotes(rows);
  const canonicalFilmKey = makeFilmKey(MANUFACTURER, canonicalFilmName);

  let keeperRow = keeper;
  if (!keeperRow) {
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
        returning id, film_name, film_key, notes
      `,
      [orgId, MANUFACTURER, canonicalFilmName, canonicalFilmKey, mergedNotes]
    );
    summary.catalogInserted += insertResult.rowCount ?? 0;
    keeperRow = insertResult.rows[0];
  } else if (
    normalizeCollapsedLabel(keeperRow.film_name) !== canonicalFilmName ||
    normalizeCollapsedLabel(keeperRow.film_key) !== canonicalFilmKey ||
    normalizeCollapsedLabel(keeperRow.notes) !== mergedNotes
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
      [keeperRow.id, canonicalFilmName, canonicalFilmKey, mergedNotes]
    );
    summary.catalogUpdated += updateResult.rowCount ?? 0;
    keeperRow = {
      ...keeperRow,
      film_name: canonicalFilmName,
      film_key: canonicalFilmKey,
      notes: mergedNotes
    };
  }

  const duplicateIds = rows
    .filter((row) => row.id !== keeperRow.id)
    .map((row) => row.id);

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

  return keeperRow;
}

async function updateMutationTables(client, orgId, oldFilmName, canonicalFilmName, summary) {
  for (const tableName of MUTATION_TABLES) {
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
}

async function retargetExistingAliases(client, orgId, canonicalFilmName, namesToRetarget, summary) {
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
          from unnest($3::text[]) as candidate(name)
          where app_api.normalize_catalog_lookup_key(app.film_name_aliases.canonical_film_name)
            = app_api.normalize_catalog_lookup_key(candidate.name)
        )
        and old_film_name_lookup_key <> app_api.normalize_catalog_lookup_key($4)
        and app_api.normalize_catalog_lookup_key(canonical_film_name) <> app_api.normalize_catalog_lookup_key($4)
    `,
    [orgId, MANUFACTURER, namesToRetarget, canonicalFilmName, ACTOR]
  );
  summary.aliasUpdated += result.rowCount ?? 0;
}

async function upsertAlias(client, orgId, oldFilmName, canonicalFilmName, summary) {
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
    [orgId, MANUFACTURER, oldFilmName, canonicalFilmName, ACTOR]
  );
  summary.aliasUpserted += result.rowCount ?? 0;
}

async function deleteCatalogRowsByNames(client, orgId, names, summary) {
  const result = await client.query(
    `
      delete from app.film_catalog
      where org_id = $1
        and manufacturer = $2
        and exists (
          select 1
          from unnest($3::text[]) as doomed(name)
          where app_api.normalize_catalog_lookup_key(app.film_catalog.film_name)
            = app_api.normalize_catalog_lookup_key(doomed.name)
        )
    `,
    [orgId, MANUFACTURER, names]
  );
  summary.catalogDeleted += result.rowCount ?? 0;
}

async function deleteAliasesByNames(client, orgId, names, summary) {
  const result = await client.query(
    `
      delete from app.film_name_aliases
      where org_id = $1
        and manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key($2)
        and (
          exists (
            select 1
            from unnest($3::text[]) as doomed(name)
            where old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(doomed.name)
          )
          or exists (
            select 1
            from unnest($3::text[]) as doomed(name)
            where app_api.normalize_catalog_lookup_key(canonical_film_name)
              = app_api.normalize_catalog_lookup_key(doomed.name)
          )
        )
    `,
    [orgId, MANUFACTURER, names]
  );
  summary.aliasDeleted += result.rowCount ?? 0;
}

async function exportSnapshot(client, orgId) {
  const result = await client.query(
    `
      select manufacturer, film_name, film_key, coalesce(notes, '') as notes
      from app.film_catalog
      where org_id = $1
      order by manufacturer, film_name
    `,
    [orgId]
  );

  const lines = ['manufacturer,film_name,film_key,notes'];
  for (const row of result.rows) {
    lines.push(
      [row.manufacturer, row.film_name, row.film_key, row.notes]
        .map((value) => csvCell(value))
        .join(",")
    );
  }

  fs.writeFileSync(snapshotPath, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = Boolean(args.apply);
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

  const summary = {
    apply,
    orgId,
    catalogInserted: 0,
    catalogUpdated: 0,
    catalogDeleted: 0,
    aliasUpserted: 0,
    aliasUpdated: 0,
    aliasDeleted: 0,
    tableUpdates: Object.fromEntries(MUTATION_TABLES.map((tableName) => [tableName, 0]))
  };

  await client.connect();
  try {
    await client.query("begin");

    for (const group of CANONICAL_GROUPS) {
      await ensureCanonicalCatalogRow(client, orgId, group.canonical, group.variants, summary);

      for (const variant of group.variants) {
        await updateMutationTables(client, orgId, variant, group.canonical, summary);
      }

      const retargetNames = withPrefixedVariants(group.variants);
      await retargetExistingAliases(client, orgId, group.canonical, retargetNames, summary);

      for (const aliasName of withPrefixedVariants(group.variants)) {
        await upsertAlias(client, orgId, aliasName, group.canonical, summary);
      }
    }

    await deleteCatalogRowsByNames(client, orgId, DELETE_ONLY_FILM_NAMES, summary);
    await deleteAliasesByNames(client, orgId, DELETE_ONLY_FILM_NAMES, summary);

    if (apply) {
      await client.query("commit");
      await exportSnapshot(client, orgId);
    } else {
      await client.query("rollback");
    }
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // Ignore rollback errors and surface the original failure.
    }
    throw error;
  } finally {
    await client.end();
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!apply) {
    console.log("Dry run only. Re-run with --apply to persist changes and refresh the snapshot.");
  } else {
    console.log(`Snapshot refreshed: ${snapshotPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
