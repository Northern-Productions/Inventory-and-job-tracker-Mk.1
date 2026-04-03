import "../load-env.mjs";
import { Client } from "pg";

const MANUFACTURER = "Security";
const ACTOR = "security-madico-catalog-curation-script";
const MUTATION_TABLES = ["job_requirements", "film_orders", "roll_weight_log"];

const RENAME_OPERATIONS = [
  {
    from: "Madico Clear 8 MIL Safetyshield 800",
    to: "Madico Safetyshield 800"
  },
  {
    from: "Madico Optivision Refl 15",
    to: "Madico Refl Optivision 15"
  },
  {
    from: "Madico SS Optivision 25 8 ml",
    to: "Madico Safetyshield 800 Optivision 25"
  }
];

const DELETE_FILM_NAMES = [
  'Madico Clear Plex 400 48" w/s film',
  "Madico Deco. Optivision 15",
  "Madico Deco. Optivision 25",
  "Madico Designer Gray 45 8 MIL",
  "Madico Deco 2 MIL Frost Matte",
  "Madico Frost Matte 2 Mil 200PS",
  "Madico Graffiti Free 6 MIL 600 PS",
  "Madico Safety Clear 4 mil",
  "Madico Safety S",
  "Madico SF 25 DA SR",
  "Madico SG 35",
  "Madico SL 38 DA SR"
];

function normalizeCollapsedLabel(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeLookup(value) {
  return normalizeCollapsedLabel(value).toLowerCase();
}

function buildFilmKey(manufacturer, filmName) {
  return `${normalizeCollapsedLabel(manufacturer).toUpperCase()}|${normalizeCollapsedLabel(filmName).toUpperCase()}`;
}

function distinct(values) {
  const seen = new Set();
  const output = [];

  for (const value of values) {
    const normalized = normalizeCollapsedLabel(value);
    const key = normalizeLookup(normalized);
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }

  return output;
}

function mergeNotes(rows) {
  const seen = new Set();
  const ordered = [];

  for (const row of rows) {
    const raw = normalizeCollapsedLabel(row.notes);
    if (!raw) {
      continue;
    }

    for (const part of raw.split("|")) {
      const note = normalizeCollapsedLabel(part);
      const key = normalizeLookup(note);
      if (!note || seen.has(key)) {
        continue;
      }

      seen.add(key);
      ordered.push(note);
    }
  }

  return ordered.join(" | ");
}

function firstNonBlank(values) {
  for (const value of values) {
    const normalized = normalizeCollapsedLabel(value);
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

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

function createSummary() {
  return {
    catalogUpdated: 0,
    catalogDeleted: 0,
    aliasUpdated: 0,
    aliasUpserted: 0,
    aliasDeleted: 0,
    boxesUpdated: 0,
    tableUpdates: {
      job_requirements: 0,
      film_orders: 0,
      roll_weight_log: 0
    },
    missingRenames: [],
    missingDeletes: []
  };
}

function buildClient() {
  const databaseUrl = String(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or SUPABASE_DB_URL) missing in backend/.env");
  }

  return new Client({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? undefined : { rejectUnauthorized: false }
  });
}

function getOrgId() {
  return String(process.env.DEFAULT_ORG_ID || "00000000-0000-0000-0000-000000000001").trim();
}

async function queryCatalogRowsForNames(client, orgId, names) {
  const requestedNames = distinct(names);
  if (requestedNames.length === 0) {
    return [];
  }

  const result = await client.query(
    `
      select
        id,
        manufacturer,
        film_name,
        film_key,
        coalesce(notes, '') as notes,
        coalesce(source_box_id, '') as source_box_id
      from app.film_catalog
      where org_id = $1
        and manufacturer = $2
        and exists (
          select 1
          from unnest($3::text[]) as requested(name)
          where app_api.normalize_catalog_lookup_key(app.film_catalog.film_name)
            = app_api.normalize_catalog_lookup_key(requested.name)
        )
      order by film_name, film_key
    `,
    [orgId, MANUFACTURER, requestedNames]
  );

  return result.rows;
}

async function updateCatalogRow(client, id, filmName, filmKey, notes, sourceBoxId, summary) {
  const result = await client.query(
    `
      update app.film_catalog
      set film_name = $2,
          film_key = $3,
          notes = $4,
          source_box_id = nullif($5, ''),
          updated_at = now()
      where id = $1
    `,
    [id, filmName, filmKey, notes, sourceBoxId]
  );
  summary.catalogUpdated += result.rowCount ?? 0;
}

async function deleteCatalogRowsByIds(client, orgId, ids, summary) {
  if (!ids.length) {
    return;
  }

  const result = await client.query(
    `
      delete from app.film_catalog
      where org_id = $1
        and id = any($2::uuid[])
    `,
    [orgId, ids]
  );
  summary.catalogDeleted += result.rowCount ?? 0;
}

async function updateBoxesForRename(client, orgId, oldFilmName, newFilmName, summary) {
  const newFilmKey = buildFilmKey(MANUFACTURER, newFilmName);
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
    [orgId, MANUFACTURER, oldFilmName, newFilmName, newFilmKey]
  );

  summary.boxesUpdated += result.rowCount ?? 0;
}

async function updateMutationTablesForRename(client, orgId, oldFilmName, newFilmName, summary) {
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
      [orgId, MANUFACTURER, oldFilmName, newFilmName]
    );

    summary.tableUpdates[tableName] += result.rowCount ?? 0;
  }
}

async function retargetExistingAliases(client, orgId, oldCanonicalNames, newCanonicalName, summary) {
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
    [orgId, MANUFACTURER, distinct(oldCanonicalNames), newCanonicalName, ACTOR]
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

async function deleteAliasesByNames(client, orgId, names, summary) {
  const requestedNames = distinct(names);
  if (!requestedNames.length) {
    return;
  }

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
    [orgId, MANUFACTURER, requestedNames]
  );

  summary.aliasDeleted += result.rowCount ?? 0;
}

async function applyRename(client, orgId, rename, summary) {
  const rows = await queryCatalogRowsForNames(client, orgId, [rename.from, rename.to]);
  const sourceRows = rows.filter(
    (row) => normalizeLookup(row.film_name) === normalizeLookup(rename.from)
  );

  if (!sourceRows.length) {
    summary.missingRenames.push(rename.from);
    await retargetExistingAliases(client, orgId, [rename.from], rename.to, summary);
    await upsertAlias(client, orgId, rename.from, rename.to, summary);
    await updateBoxesForRename(client, orgId, rename.from, rename.to, summary);
    await updateMutationTablesForRename(client, orgId, rename.from, rename.to, summary);
    return;
  }

  const targetRow =
    rows.find((row) => normalizeLookup(row.film_name) === normalizeLookup(rename.to)) ?? null;
  const mergedNotes = mergeNotes(targetRow ? [targetRow, ...sourceRows] : sourceRows);
  const mergedSourceBoxId = firstNonBlank(
    targetRow
      ? [targetRow.source_box_id, ...sourceRows.map((row) => row.source_box_id)]
      : sourceRows.map((row) => row.source_box_id)
  );
  const targetFilmKey = buildFilmKey(MANUFACTURER, rename.to);

  if (targetRow) {
    const targetNeedsUpdate =
      normalizeLookup(targetRow.film_key) !== normalizeLookup(targetFilmKey) ||
      normalizeCollapsedLabel(targetRow.notes) !== mergedNotes ||
      normalizeCollapsedLabel(targetRow.source_box_id) !== mergedSourceBoxId;

    if (targetNeedsUpdate) {
      await updateCatalogRow(
        client,
        targetRow.id,
        rename.to,
        targetFilmKey,
        mergedNotes,
        mergedSourceBoxId,
        summary
      );
    }

    await deleteCatalogRowsByIds(
      client,
      orgId,
      sourceRows.map((row) => row.id),
      summary
    );
  } else {
    const keeper = sourceRows[0];
    await updateCatalogRow(
      client,
      keeper.id,
      rename.to,
      targetFilmKey,
      mergedNotes,
      mergedSourceBoxId,
      summary
    );

    await deleteCatalogRowsByIds(
      client,
      orgId,
      sourceRows.slice(1).map((row) => row.id),
      summary
    );
  }

  await retargetExistingAliases(client, orgId, [rename.from], rename.to, summary);
  await upsertAlias(client, orgId, rename.from, rename.to, summary);
  await updateBoxesForRename(client, orgId, rename.from, rename.to, summary);
  await updateMutationTablesForRename(client, orgId, rename.from, rename.to, summary);
}

async function applyDeletes(client, orgId, names, summary) {
  const rows = await queryCatalogRowsForNames(client, orgId, names);
  const matchedLookup = new Set(rows.map((row) => normalizeLookup(row.film_name)));

  for (const name of names) {
    if (!matchedLookup.has(normalizeLookup(name))) {
      summary.missingDeletes.push(name);
    }
  }

  await deleteCatalogRowsByIds(
    client,
    orgId,
    rows.map((row) => row.id),
    summary
  );
  await deleteAliasesByNames(client, orgId, names, summary);
}

async function listSecurityMadicoRows(client, orgId) {
  const result = await client.query(
    `
      select film_name, film_key
      from app.film_catalog
      where org_id = $1
        and manufacturer = $2
        and lower(film_name) like '%madico%'
      order by film_name asc, film_key asc
    `,
    [orgId, MANUFACTURER]
  );

  return result.rows;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dryRun = Boolean(options["dry-run"]);
  const listOnly = Boolean(options["list-only"]);
  const client = buildClient();
  const orgId = getOrgId();

  await client.connect();

  try {
    if (listOnly) {
      const finalRows = await listSecurityMadicoRows(client, orgId);
      console.log(
        JSON.stringify(
          {
            mode: "list-only",
            finalRows
          },
          null,
          2
        )
      );
      return;
    }

    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '30s'`);

    const summary = createSummary();

    for (const rename of RENAME_OPERATIONS) {
      await applyRename(client, orgId, rename, summary);
    }

    await applyDeletes(client, orgId, DELETE_FILM_NAMES, summary);

    const finalRows = await listSecurityMadicoRows(client, orgId);

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }

    console.log(
      JSON.stringify(
        {
          mode: dryRun ? "dry-run" : "apply",
          summary,
          finalRows
        },
        null,
        2
      )
    );
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_rollbackError) {
      // Surface the original failure.
    }

    throw error;
  } finally {
    await client.end();
  }
}

await main();
