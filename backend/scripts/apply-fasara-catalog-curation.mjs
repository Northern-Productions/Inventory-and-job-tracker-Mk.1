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
    if (character === "\r") {
      continue;
    }
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
  if (key === "fasara" || key === "3m fasara" || key === "3m") {
    return "3M Fasara";
  }
  return normalized;
}

function normalizeManufacturerLookupKey(value) {
  return toLookup(canonicalizeManufacturerLabel(value));
}

function normalizeFilmLookupKey(value) {
  return toLookup(value);
}

function buildFilmKey(manufacturer, filmName) {
  return `${canonicalizeManufacturerLabel(manufacturer).toUpperCase()}|${normalizeCollapsedLabel(filmName).toUpperCase()}`;
}

function parseCsvObjects(filePath, requiredHeaders) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing CSV file: ${filePath}`);
  }

  const rows = parseCsv(fs.readFileSync(filePath, "utf8"));
  if (!rows.length) {
    throw new Error(`CSV file is empty: ${filePath}`);
  }

  const headers = rows[0].map((header) => normalizeCollapsedLabel(header));
  for (const header of requiredHeaders) {
    if (!headers.includes(header)) {
      throw new Error(`CSV ${filePath} is missing required header "${header}"`);
    }
  }

  const objects = [];
  for (let index = 1; index < rows.length; index += 1) {
    const values = rows[index];
    if (values.every((value) => normalizeCollapsedLabel(value) === "")) {
      continue;
    }

    const record = {};
    for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
      record[headers[headerIndex]] = values[headerIndex] ?? "";
    }
    objects.push(record);
  }

  return objects;
}

function loadCuratedCatalog(csvPath) {
  const rows = parseCsvObjects(csvPath, [
    "manufacturer",
    "film_name",
    "film_key",
    "product_code",
    "source_kind",
    "source_doc",
    "source_product_name",
    "notes",
  ]);

  const byFilmKey = new Map();
  const byLookupKey = new Map();
  const catalogRows = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const manufacturer = canonicalizeManufacturerLabel(row.manufacturer);
    const manufacturerLookupKey = normalizeManufacturerLookupKey(manufacturer);
    const filmName = normalizeCollapsedLabel(row.film_name);
    const filmLookupKey = normalizeFilmLookupKey(filmName);
    const filmKey = normalizeCollapsedLabel(row.film_key).toUpperCase();
    const expectedFilmKey = buildFilmKey(manufacturer, filmName);

    if (!manufacturer || !filmName || !filmKey) {
      throw new Error(`Curated catalog row ${index + 2} is missing manufacturer, film_name, or film_key.`);
    }
    if (manufacturerLookupKey !== "3m fasara") {
      throw new Error(`Curated catalog row ${index + 2} must use manufacturer "3M Fasara". Received "${row.manufacturer}".`);
    }
    if (filmKey !== expectedFilmKey) {
      throw new Error(
        `Curated catalog row ${index + 2} has film_key "${row.film_key}" but expected "${expectedFilmKey}".`,
      );
    }

    const entry = {
      manufacturer,
      manufacturer_lookup_key: manufacturerLookupKey,
      film_name: filmName,
      film_lookup_key: filmLookupKey,
      film_key: filmKey,
      product_code: normalizeCollapsedLabel(row.product_code),
      source_kind: normalizeCollapsedLabel(row.source_kind),
      source_doc: normalizeCollapsedLabel(row.source_doc),
      source_product_name: normalizeCollapsedLabel(row.source_product_name),
      notes: normalizeCollapsedLabel(row.notes),
    };

    if (byFilmKey.has(entry.film_key)) {
      throw new Error(`Duplicate curated film_key "${entry.film_key}" in ${csvPath}.`);
    }

    const lookupKey = `${entry.manufacturer_lookup_key}|${entry.film_lookup_key}`;
    if (byLookupKey.has(lookupKey)) {
      throw new Error(
        `Duplicate curated lookup key "${lookupKey}" in ${csvPath}. This would create duplicate canonical Fasara rows.`,
      );
    }

    byFilmKey.set(entry.film_key, entry);
    byLookupKey.set(lookupKey, entry);
    catalogRows.push(entry);
  }

  return {
    rows: catalogRows,
    by_film_key: byFilmKey,
    by_lookup_key: byLookupKey,
  };
}

function loadCuratedAliases(csvPath, curatedCatalog) {
  const rows = parseCsvObjects(csvPath, [
    "manufacturer",
    "alias_film_name",
    "canonical_film_name",
    "reason",
    "notes",
  ]);

  const byMappingKey = new Map();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const oldManufacturer = canonicalizeManufacturerLabel(row.manufacturer);
    const oldManufacturerLookupKey = normalizeManufacturerLookupKey(oldManufacturer);
    const aliasFilmName = normalizeCollapsedLabel(row.alias_film_name);
    const oldFilmLookupKey = normalizeFilmLookupKey(aliasFilmName);
    const requestedCanonicalFilmName = normalizeCollapsedLabel(row.canonical_film_name);
    const canonicalLookupKey = normalizeFilmLookupKey(requestedCanonicalFilmName);

    if (!oldManufacturer || !aliasFilmName || !requestedCanonicalFilmName) {
      throw new Error(`Curated alias row ${index + 2} is missing manufacturer, alias_film_name, or canonical_film_name.`);
    }

    const targetLookupKey = `${oldManufacturerLookupKey}|${canonicalLookupKey}`;
    const curatedTarget = curatedCatalog.by_lookup_key.get(targetLookupKey);
    if (!curatedTarget) {
      throw new Error(
        `Curated alias row ${index + 2} points to "${requestedCanonicalFilmName}", which does not exist in the curated catalog.`,
      );
    }

    const mappingKey = `${oldManufacturerLookupKey}|${oldFilmLookupKey}`;
    const entry = {
      old_manufacturer: oldManufacturer,
      old_manufacturer_lookup_key: oldManufacturerLookupKey,
      alias_film_name: aliasFilmName,
      old_film_name_lookup_key: oldFilmLookupKey,
      canonical_manufacturer: curatedTarget.manufacturer,
      canonical_manufacturer_lookup_key: curatedTarget.manufacturer_lookup_key,
      canonical_film_name: curatedTarget.film_name,
      canonical_film_lookup_key: curatedTarget.film_lookup_key,
      canonical_film_key: curatedTarget.film_key,
      reason: normalizeCollapsedLabel(row.reason),
      notes: normalizeCollapsedLabel(row.notes),
    };

    const existing = byMappingKey.get(mappingKey);
    if (existing && existing.canonical_film_key !== entry.canonical_film_key) {
      throw new Error(
        `Curated alias CSV contains conflicting canonical targets for lookup "${mappingKey}": `
        + `"${existing.canonical_film_name}" vs "${entry.canonical_film_name}".`,
      );
    }

    byMappingKey.set(mappingKey, entry);
  }

  return {
    rows: [...byMappingKey.values()],
    by_mapping_key: byMappingKey,
  };
}

function buildEffectiveMappings(curatedCatalog, curatedAliases) {
  const effective = new Map();

  for (const row of curatedCatalog.rows) {
    const mappingKey = `${row.manufacturer_lookup_key}|${row.film_lookup_key}`;
    effective.set(mappingKey, {
      old_manufacturer_lookup_key: row.manufacturer_lookup_key,
      old_film_name_lookup_key: row.film_lookup_key,
      canonical_manufacturer: row.manufacturer,
      canonical_manufacturer_lookup_key: row.manufacturer_lookup_key,
      canonical_film_name: row.film_name,
      canonical_film_lookup_key: row.film_lookup_key,
      canonical_film_key: row.film_key,
      source_type: "catalog",
    });
  }

  for (const row of curatedAliases.rows) {
    const mappingKey = `${row.old_manufacturer_lookup_key}|${row.old_film_name_lookup_key}`;
    const existing = effective.get(mappingKey);
    if (existing && existing.canonical_film_key !== row.canonical_film_key) {
      throw new Error(
        `Effective mapping collision for "${mappingKey}": `
        + `"${existing.canonical_film_name}" vs "${row.canonical_film_name}".`,
      );
    }

    effective.set(mappingKey, {
      old_manufacturer_lookup_key: row.old_manufacturer_lookup_key,
      old_film_name_lookup_key: row.old_film_name_lookup_key,
      canonical_manufacturer: row.canonical_manufacturer,
      canonical_manufacturer_lookup_key: row.canonical_manufacturer_lookup_key,
      canonical_film_name: row.canonical_film_name,
      canonical_film_lookup_key: row.canonical_film_lookup_key,
      canonical_film_key: row.canonical_film_key,
      source_type: existing ? "catalog+alias" : "alias",
    });
  }

  return [...effective.values()].sort((left, right) => {
    const manufacturerCompare = left.old_manufacturer_lookup_key.localeCompare(right.old_manufacturer_lookup_key);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }
    return left.old_film_name_lookup_key.localeCompare(right.old_film_name_lookup_key);
  });
}

async function queryInt(client, sql, params = []) {
  const result = await client.query(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function createTempTables(client, curatedCatalog, curatedAliases, effectiveMappings) {
  await client.query("drop table if exists tmp_fasara_catalog_curated");
  await client.query("drop table if exists tmp_fasara_alias_mapping");
  await client.query("drop table if exists tmp_fasara_effective_mapping");

  await client.query(`
    create temporary table tmp_fasara_catalog_curated (
      manufacturer text not null,
      manufacturer_lookup_key text not null,
      film_name text not null,
      film_lookup_key text not null,
      film_key text not null,
      product_code text not null,
      source_kind text not null,
      source_doc text not null,
      source_product_name text not null,
      notes text not null,
      primary key (film_key)
    ) on commit drop
  `);

  await client.query(`
    create temporary table tmp_fasara_alias_mapping (
      old_manufacturer_lookup_key text not null,
      old_film_name_lookup_key text not null,
      canonical_manufacturer text not null,
      canonical_manufacturer_lookup_key text not null,
      canonical_film_name text not null,
      canonical_film_lookup_key text not null,
      canonical_film_key text not null,
      reason text not null,
      notes text not null,
      primary key (old_manufacturer_lookup_key, old_film_name_lookup_key)
    ) on commit drop
  `);

  await client.query(`
    create temporary table tmp_fasara_effective_mapping (
      old_manufacturer_lookup_key text not null,
      old_film_name_lookup_key text not null,
      canonical_manufacturer text not null,
      canonical_manufacturer_lookup_key text not null,
      canonical_film_name text not null,
      canonical_film_lookup_key text not null,
      canonical_film_key text not null,
      source_type text not null,
      primary key (old_manufacturer_lookup_key, old_film_name_lookup_key)
    ) on commit drop
  `);

  for (let index = 0; index < curatedCatalog.rows.length; index += 200) {
    const chunk = curatedCatalog.rows.slice(index, index + 200);
    const values = [];
    const placeholders = [];
    let cursor = 1;

    for (const row of chunk) {
      placeholders.push(
        `($${cursor},$${cursor + 1},$${cursor + 2},$${cursor + 3},$${cursor + 4},$${cursor + 5},$${cursor + 6},$${cursor + 7},$${cursor + 8},$${cursor + 9})`,
      );
      values.push(
        row.manufacturer,
        row.manufacturer_lookup_key,
        row.film_name,
        row.film_lookup_key,
        row.film_key,
        row.product_code,
        row.source_kind,
        row.source_doc,
        row.source_product_name,
        row.notes,
      );
      cursor += 10;
    }

    await client.query(
      `
        insert into tmp_fasara_catalog_curated (
          manufacturer,
          manufacturer_lookup_key,
          film_name,
          film_lookup_key,
          film_key,
          product_code,
          source_kind,
          source_doc,
          source_product_name,
          notes
        )
        values ${placeholders.join(",")}
      `,
      values,
    );
  }

  for (let index = 0; index < curatedAliases.rows.length; index += 200) {
    const chunk = curatedAliases.rows.slice(index, index + 200);
    const values = [];
    const placeholders = [];
    let cursor = 1;

    for (const row of chunk) {
      placeholders.push(
        `($${cursor},$${cursor + 1},$${cursor + 2},$${cursor + 3},$${cursor + 4},$${cursor + 5},$${cursor + 6},$${cursor + 7},$${cursor + 8})`,
      );
      values.push(
        row.old_manufacturer_lookup_key,
        row.old_film_name_lookup_key,
        row.canonical_manufacturer,
        row.canonical_manufacturer_lookup_key,
        row.canonical_film_name,
        row.canonical_film_lookup_key,
        row.canonical_film_key,
        row.reason,
        row.notes,
      );
      cursor += 9;
    }

    await client.query(
      `
        insert into tmp_fasara_alias_mapping (
          old_manufacturer_lookup_key,
          old_film_name_lookup_key,
          canonical_manufacturer,
          canonical_manufacturer_lookup_key,
          canonical_film_name,
          canonical_film_lookup_key,
          canonical_film_key,
          reason,
          notes
        )
        values ${placeholders.join(",")}
      `,
      values,
    );
  }

  for (let index = 0; index < effectiveMappings.length; index += 200) {
    const chunk = effectiveMappings.slice(index, index + 200);
    const values = [];
    const placeholders = [];
    let cursor = 1;

    for (const row of chunk) {
      placeholders.push(
        `($${cursor},$${cursor + 1},$${cursor + 2},$${cursor + 3},$${cursor + 4},$${cursor + 5},$${cursor + 6},$${cursor + 7})`,
      );
      values.push(
        row.old_manufacturer_lookup_key,
        row.old_film_name_lookup_key,
        row.canonical_manufacturer,
        row.canonical_manufacturer_lookup_key,
        row.canonical_film_name,
        row.canonical_film_lookup_key,
        row.canonical_film_key,
        row.source_type,
      );
      cursor += 8;
    }

    await client.query(
      `
        insert into tmp_fasara_effective_mapping (
          old_manufacturer_lookup_key,
          old_film_name_lookup_key,
          canonical_manufacturer,
          canonical_manufacturer_lookup_key,
          canonical_film_name,
          canonical_film_lookup_key,
          canonical_film_key,
          source_type
        )
        values ${placeholders.join(",")}
      `,
      values,
    );
  }
}

async function buildPreflight(client, orgId) {
  const candidateUpdates = {
    aliases_upserts: 0,
    boxes: 0,
    film_catalog_upserts: 0,
    film_catalog_deletes: 0,
    job_requirements: 0,
    film_orders: 0,
    roll_weight_log: 0,
    film_catalog_metadata_backfills: 0,
  };

  candidateUpdates.aliases_upserts = await queryInt(
    client,
    `
      select count(*)::int as count
      from tmp_fasara_alias_mapping
      where old_manufacturer_lookup_key is distinct from canonical_manufacturer_lookup_key
         or old_film_name_lookup_key is distinct from canonical_film_lookup_key
    `,
  );

  candidateUpdates.boxes = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.boxes b
      join tmp_fasara_effective_mapping m
        on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(b.manufacturer)
       and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(b.film_name)
      where b.org_id = $1::uuid
        and (
          app_api.normalize_collapsed_catalog_label(b.manufacturer) is distinct from m.canonical_manufacturer
          or app_api.normalize_collapsed_catalog_label(b.film_name) is distinct from m.canonical_film_name
          or upper(coalesce(b.film_key, '')) is distinct from m.canonical_film_key
        )
    `,
    [orgId],
  );

  candidateUpdates.job_requirements = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.job_requirements r
      join tmp_fasara_effective_mapping m
        on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(r.manufacturer)
       and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(r.film_name)
      where r.org_id = $1::uuid
        and (
          app_api.normalize_collapsed_catalog_label(r.manufacturer) is distinct from m.canonical_manufacturer
          or app_api.normalize_collapsed_catalog_label(r.film_name) is distinct from m.canonical_film_name
        )
    `,
    [orgId],
  );

  candidateUpdates.film_orders = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.film_orders o
      join tmp_fasara_effective_mapping m
        on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(o.manufacturer)
       and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(o.film_name)
      where o.org_id = $1::uuid
        and (
          app_api.normalize_collapsed_catalog_label(o.manufacturer) is distinct from m.canonical_manufacturer
          or app_api.normalize_collapsed_catalog_label(o.film_name) is distinct from m.canonical_film_name
        )
    `,
    [orgId],
  );

  candidateUpdates.roll_weight_log = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.roll_weight_log l
      join tmp_fasara_effective_mapping m
        on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(l.manufacturer)
       and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(l.film_name)
      where l.org_id = $1::uuid
        and (
          app_api.normalize_collapsed_catalog_label(l.manufacturer) is distinct from m.canonical_manufacturer
          or app_api.normalize_collapsed_catalog_label(l.film_name) is distinct from m.canonical_film_name
        )
    `,
    [orgId],
  );

  candidateUpdates.film_catalog_upserts = await queryInt(
    client,
    `
      select count(*)::int as count
      from tmp_fasara_catalog_curated c
      left join app.film_catalog f
        on f.org_id = $1::uuid
       and f.film_key = c.film_key
      where f.id is null
         or app_api.normalize_collapsed_catalog_label(f.manufacturer) is distinct from c.manufacturer
         or app_api.normalize_collapsed_catalog_label(f.film_name) is distinct from c.film_name
         or (
           coalesce(btrim(f.notes), '') = ''
           and coalesce(btrim(c.notes), '') <> ''
         )
    `,
    [orgId],
  );

  candidateUpdates.film_catalog_deletes = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.film_catalog f
      join tmp_fasara_effective_mapping m
        on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(f.manufacturer)
       and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(f.film_name)
      where f.org_id = $1::uuid
        and upper(coalesce(f.film_key, '')) is distinct from m.canonical_film_key
    `,
    [orgId],
  );

  candidateUpdates.film_catalog_metadata_backfills = await queryInt(
    client,
    `
      with delete_rows as (
        select
          m.canonical_film_key,
          f.sq_ft_weight_lbs_per_sq_ft,
          nullif(btrim(f.default_core_type), '') as default_core_type,
          f.source_width_in,
          f.source_initial_feet,
          f.source_initial_weight_lbs,
          nullif(btrim(f.source_box_id), '') as source_box_id
        from app.film_catalog f
        join tmp_fasara_effective_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(f.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(f.film_name)
        where f.org_id = $1::uuid
          and upper(coalesce(f.film_key, '')) is distinct from m.canonical_film_key
      ),
      resolved as (
        select
          canonical_film_key,
          case
            when count(distinct sq_ft_weight_lbs_per_sq_ft) filter (where sq_ft_weight_lbs_per_sq_ft is not null) = 1
            then min(sq_ft_weight_lbs_per_sq_ft) filter (where sq_ft_weight_lbs_per_sq_ft is not null)
          end as sq_ft_weight_lbs_per_sq_ft,
          case
            when count(distinct default_core_type) filter (where default_core_type is not null) = 1
            then min(default_core_type) filter (where default_core_type is not null)
          end as default_core_type,
          case
            when count(distinct source_width_in) filter (where source_width_in is not null) = 1
            then min(source_width_in) filter (where source_width_in is not null)
          end as source_width_in,
          case
            when count(distinct source_initial_feet) filter (where source_initial_feet is not null) = 1
            then min(source_initial_feet) filter (where source_initial_feet is not null)
          end as source_initial_feet,
          case
            when count(distinct source_initial_weight_lbs) filter (where source_initial_weight_lbs is not null) = 1
            then min(source_initial_weight_lbs) filter (where source_initial_weight_lbs is not null)
          end as source_initial_weight_lbs,
          case
            when count(distinct source_box_id) filter (where source_box_id is not null) = 1
            then min(source_box_id) filter (where source_box_id is not null)
          end as source_box_id
        from delete_rows
        group by canonical_film_key
      )
      select count(*)::int as count
      from app.film_catalog f
      join resolved r
        on r.canonical_film_key = f.film_key
      where f.org_id = $1::uuid
        and (
          (f.sq_ft_weight_lbs_per_sq_ft is null and r.sq_ft_weight_lbs_per_sq_ft is not null)
          or (coalesce(btrim(f.default_core_type), '') = '' and r.default_core_type is not null)
          or (f.source_width_in is null and r.source_width_in is not null)
          or (f.source_initial_feet is null and r.source_initial_feet is not null)
          or (f.source_initial_weight_lbs is null and r.source_initial_weight_lbs is not null)
          or (coalesce(btrim(f.source_box_id), '') = '' and r.source_box_id is not null)
        )
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
          coalesce(m.canonical_manufacturer, app_api.normalize_collapsed_catalog_label(r.manufacturer)) as manufacturer,
          coalesce(m.canonical_film_name, app_api.normalize_collapsed_catalog_label(r.film_name)) as film_name,
          round(coalesce(r.width_in, 0)::numeric, 4)::text as width_key
        from app.job_requirements r
        join app.jobs j
          on j.id = r.job_id
        left join tmp_fasara_effective_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(r.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(r.film_name)
        where r.org_id = $1::uuid
      ),
      grouped as (
        select
          job_id,
          job_number,
          app_api.normalize_catalog_lookup_key(manufacturer)
            || '|'
            || app_api.normalize_catalog_lookup_key(film_name)
            || '|'
            || width_key as canonical_lookup_key,
          count(*)::int as row_count,
          array_agg(id order by id) as source_requirement_ids
        from mapped
        group by job_id, job_number, canonical_lookup_key
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

  const metadataConflictRes = await client.query(
    `
      with delete_rows as (
        select
          m.canonical_film_key,
          f.sq_ft_weight_lbs_per_sq_ft,
          nullif(btrim(f.default_core_type), '') as default_core_type,
          f.source_width_in,
          f.source_initial_feet,
          f.source_initial_weight_lbs,
          nullif(btrim(f.source_box_id), '') as source_box_id
        from app.film_catalog f
        join tmp_fasara_effective_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(f.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(f.film_name)
        where f.org_id = $1::uuid
          and upper(coalesce(f.film_key, '')) is distinct from m.canonical_film_key
      ),
      targets as (
        select
          c.film_key as canonical_film_key,
          f.sq_ft_weight_lbs_per_sq_ft,
          nullif(btrim(f.default_core_type), '') as default_core_type,
          f.source_width_in,
          f.source_initial_feet,
          f.source_initial_weight_lbs,
          nullif(btrim(f.source_box_id), '') as source_box_id
        from tmp_fasara_catalog_curated c
        left join app.film_catalog f
          on f.org_id = $1::uuid
         and f.film_key = c.film_key
      ),
      aggregated as (
        select
          d.canonical_film_key,
          count(distinct d.sq_ft_weight_lbs_per_sq_ft) filter (where d.sq_ft_weight_lbs_per_sq_ft is not null) as sq_ft_distinct_count,
          array_agg(distinct d.sq_ft_weight_lbs_per_sq_ft::text order by d.sq_ft_weight_lbs_per_sq_ft::text)
            filter (where d.sq_ft_weight_lbs_per_sq_ft is not null) as sq_ft_values,
          count(distinct d.default_core_type) filter (where d.default_core_type is not null) as default_core_distinct_count,
          array_agg(distinct d.default_core_type order by d.default_core_type)
            filter (where d.default_core_type is not null) as default_core_values,
          count(distinct d.source_width_in) filter (where d.source_width_in is not null) as source_width_distinct_count,
          array_agg(distinct d.source_width_in::text order by d.source_width_in::text)
            filter (where d.source_width_in is not null) as source_width_values,
          count(distinct d.source_initial_feet) filter (where d.source_initial_feet is not null) as source_initial_feet_distinct_count,
          array_agg(distinct d.source_initial_feet::text order by d.source_initial_feet::text)
            filter (where d.source_initial_feet is not null) as source_initial_feet_values,
          count(distinct d.source_initial_weight_lbs) filter (where d.source_initial_weight_lbs is not null) as source_initial_weight_distinct_count,
          array_agg(distinct d.source_initial_weight_lbs::text order by d.source_initial_weight_lbs::text)
            filter (where d.source_initial_weight_lbs is not null) as source_initial_weight_values,
          count(distinct d.source_box_id) filter (where d.source_box_id is not null) as source_box_distinct_count,
          array_agg(distinct d.source_box_id order by d.source_box_id)
            filter (where d.source_box_id is not null) as source_box_values
        from delete_rows d
        group by d.canonical_film_key
      ),
      conflicts as (
        select
          a.canonical_film_key,
          'sq_ft_weight_lbs_per_sq_ft'::text as field_name,
          a.sq_ft_distinct_count as distinct_value_count,
          a.sq_ft_values as distinct_values
        from aggregated a
        join targets t
          on t.canonical_film_key = a.canonical_film_key
        where coalesce(a.sq_ft_distinct_count, 0) > 1
          and t.sq_ft_weight_lbs_per_sq_ft is null

        union all

        select
          a.canonical_film_key,
          'default_core_type'::text as field_name,
          a.default_core_distinct_count as distinct_value_count,
          a.default_core_values as distinct_values
        from aggregated a
        join targets t
          on t.canonical_film_key = a.canonical_film_key
        where coalesce(a.default_core_distinct_count, 0) > 1
          and t.default_core_type is null

        union all

        select
          a.canonical_film_key,
          'source_width_in'::text as field_name,
          a.source_width_distinct_count as distinct_value_count,
          a.source_width_values as distinct_values
        from aggregated a
        join targets t
          on t.canonical_film_key = a.canonical_film_key
        where coalesce(a.source_width_distinct_count, 0) > 1
          and t.source_width_in is null

        union all

        select
          a.canonical_film_key,
          'source_initial_feet'::text as field_name,
          a.source_initial_feet_distinct_count as distinct_value_count,
          a.source_initial_feet_values as distinct_values
        from aggregated a
        join targets t
          on t.canonical_film_key = a.canonical_film_key
        where coalesce(a.source_initial_feet_distinct_count, 0) > 1
          and t.source_initial_feet is null

        union all

        select
          a.canonical_film_key,
          'source_initial_weight_lbs'::text as field_name,
          a.source_initial_weight_distinct_count as distinct_value_count,
          a.source_initial_weight_values as distinct_values
        from aggregated a
        join targets t
          on t.canonical_film_key = a.canonical_film_key
        where coalesce(a.source_initial_weight_distinct_count, 0) > 1
          and t.source_initial_weight_lbs is null

        union all

        select
          a.canonical_film_key,
          'source_box_id'::text as field_name,
          a.source_box_distinct_count as distinct_value_count,
          a.source_box_values as distinct_values
        from aggregated a
        join targets t
          on t.canonical_film_key = a.canonical_film_key
        where coalesce(a.source_box_distinct_count, 0) > 1
          and t.source_box_id is null
      )
      select
        canonical_film_key,
        field_name,
        distinct_value_count,
        distinct_values
      from conflicts
      order by canonical_film_key asc, field_name asc
    `,
    [orgId],
  );

  return {
    curated_catalog_rows: await queryInt(client, "select count(*)::int as count from tmp_fasara_catalog_curated"),
    curated_alias_rows: await queryInt(client, "select count(*)::int as count from tmp_fasara_alias_mapping"),
    effective_mapping_rows: await queryInt(client, "select count(*)::int as count from tmp_fasara_effective_mapping"),
    candidate_updates: candidateUpdates,
    preflight_blockers: {
      film_catalog_metadata_conflicts: metadataConflictRes.rows,
      job_requirement_lookup_collisions: requirementCollisionRes.rows,
    },
  };
}

async function runApply(client, orgId, actor) {
  const updates = {
    aliases_upserted: 0,
    boxes: 0,
    film_catalog_upserts: 0,
    film_catalog_metadata_backfills: 0,
    film_catalog_deletes: 0,
    job_requirements: 0,
    film_orders: 0,
    roll_weight_log: 0,
  };

  await client.query(`set local lock_timeout = '5s'`);
  await client.query(`set local statement_timeout = '60s'`);
  await client.query(`
    lock table
      app.boxes,
      app.job_requirements,
      app.film_orders,
      app.roll_weight_log,
      app.film_catalog,
      app.film_name_aliases
    in share row exclusive mode
  `);

  const upsertCatalog = await client.query(
    `
      insert into app.film_catalog (
        id,
        org_id,
        film_key,
        manufacturer,
        film_name,
        notes,
        updated_at
      )
      select
        gen_random_uuid(),
        $1::uuid,
        c.film_key,
        c.manufacturer,
        c.film_name,
        c.notes,
        now()
      from tmp_fasara_catalog_curated c
      on conflict (org_id, film_key) do update set
        manufacturer = excluded.manufacturer,
        film_name = excluded.film_name,
        notes = case
          when coalesce(btrim(app.film_catalog.notes), '') = '' and coalesce(btrim(excluded.notes), '') <> ''
            then excluded.notes
          else app.film_catalog.notes
        end,
        updated_at = excluded.updated_at
    `,
    [orgId],
  );
  updates.film_catalog_upserts = upsertCatalog.rowCount ?? 0;

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
        a.canonical_manufacturer_lookup_key,
        a.old_film_name_lookup_key,
        a.canonical_film_name,
        $2,
        $2
      from tmp_fasara_alias_mapping a
      where a.old_manufacturer_lookup_key is distinct from a.canonical_manufacturer_lookup_key
         or a.old_film_name_lookup_key is distinct from a.canonical_film_lookup_key
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
          m.canonical_film_name,
          m.canonical_film_key
        from app.boxes b
        join tmp_fasara_effective_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(b.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(b.film_name)
        where b.org_id = $1::uuid
          and (
            app_api.normalize_collapsed_catalog_label(b.manufacturer) is distinct from m.canonical_manufacturer
            or app_api.normalize_collapsed_catalog_label(b.film_name) is distinct from m.canonical_film_name
            or upper(coalesce(b.film_key, '')) is distinct from m.canonical_film_key
          )
      )
      update app.boxes b
      set
        manufacturer = c.canonical_manufacturer,
        film_name = c.canonical_film_name,
        film_key = c.canonical_film_key,
        updated_at = now()
      from candidates c
      where b.id = c.id
    `,
    [orgId],
  );
  updates.boxes = updateBoxes.rowCount ?? 0;

  const updateRequirements = await client.query(
    `
      with candidates as (
        select
          r.id,
          m.canonical_manufacturer,
          m.canonical_film_name
        from app.job_requirements r
        join tmp_fasara_effective_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(r.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(r.film_name)
        where r.org_id = $1::uuid
          and (
            app_api.normalize_collapsed_catalog_label(r.manufacturer) is distinct from m.canonical_manufacturer
            or app_api.normalize_collapsed_catalog_label(r.film_name) is distinct from m.canonical_film_name
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
        join tmp_fasara_effective_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(o.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(o.film_name)
        where o.org_id = $1::uuid
          and (
            app_api.normalize_collapsed_catalog_label(o.manufacturer) is distinct from m.canonical_manufacturer
            or app_api.normalize_collapsed_catalog_label(o.film_name) is distinct from m.canonical_film_name
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
        join tmp_fasara_effective_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(l.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(l.film_name)
        where l.org_id = $1::uuid
          and (
            app_api.normalize_collapsed_catalog_label(l.manufacturer) is distinct from m.canonical_manufacturer
            or app_api.normalize_collapsed_catalog_label(l.film_name) is distinct from m.canonical_film_name
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

  const backfillCatalogMetadata = await client.query(
    `
      with delete_rows as (
        select
          m.canonical_film_key,
          f.sq_ft_weight_lbs_per_sq_ft,
          nullif(btrim(f.default_core_type), '') as default_core_type,
          f.source_width_in,
          f.source_initial_feet,
          f.source_initial_weight_lbs,
          nullif(btrim(f.source_box_id), '') as source_box_id
        from app.film_catalog f
        join tmp_fasara_effective_mapping m
          on m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(f.manufacturer)
         and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(f.film_name)
        where f.org_id = $1::uuid
          and upper(coalesce(f.film_key, '')) is distinct from m.canonical_film_key
      ),
      resolved as (
        select
          canonical_film_key,
          case
            when count(distinct sq_ft_weight_lbs_per_sq_ft) filter (where sq_ft_weight_lbs_per_sq_ft is not null) = 1
            then min(sq_ft_weight_lbs_per_sq_ft) filter (where sq_ft_weight_lbs_per_sq_ft is not null)
          end as sq_ft_weight_lbs_per_sq_ft,
          case
            when count(distinct default_core_type) filter (where default_core_type is not null) = 1
            then min(default_core_type) filter (where default_core_type is not null)
          end as default_core_type,
          case
            when count(distinct source_width_in) filter (where source_width_in is not null) = 1
            then min(source_width_in) filter (where source_width_in is not null)
          end as source_width_in,
          case
            when count(distinct source_initial_feet) filter (where source_initial_feet is not null) = 1
            then min(source_initial_feet) filter (where source_initial_feet is not null)
          end as source_initial_feet,
          case
            when count(distinct source_initial_weight_lbs) filter (where source_initial_weight_lbs is not null) = 1
            then min(source_initial_weight_lbs) filter (where source_initial_weight_lbs is not null)
          end as source_initial_weight_lbs,
          case
            when count(distinct source_box_id) filter (where source_box_id is not null) = 1
            then min(source_box_id) filter (where source_box_id is not null)
          end as source_box_id
        from delete_rows
        group by canonical_film_key
      ),
      candidates as (
        select
          f.id,
          r.sq_ft_weight_lbs_per_sq_ft,
          r.default_core_type,
          r.source_width_in,
          r.source_initial_feet,
          r.source_initial_weight_lbs,
          r.source_box_id
        from app.film_catalog f
        join resolved r
          on r.canonical_film_key = f.film_key
        where f.org_id = $1::uuid
          and (
            (f.sq_ft_weight_lbs_per_sq_ft is null and r.sq_ft_weight_lbs_per_sq_ft is not null)
            or (coalesce(btrim(f.default_core_type), '') = '' and r.default_core_type is not null)
            or (f.source_width_in is null and r.source_width_in is not null)
            or (f.source_initial_feet is null and r.source_initial_feet is not null)
            or (f.source_initial_weight_lbs is null and r.source_initial_weight_lbs is not null)
            or (coalesce(btrim(f.source_box_id), '') = '' and r.source_box_id is not null)
          )
      )
      update app.film_catalog f
      set
        sq_ft_weight_lbs_per_sq_ft = coalesce(f.sq_ft_weight_lbs_per_sq_ft, c.sq_ft_weight_lbs_per_sq_ft),
        default_core_type = case
          when coalesce(btrim(f.default_core_type), '') = '' and c.default_core_type is not null
            then c.default_core_type
          else f.default_core_type
        end,
        source_width_in = coalesce(f.source_width_in, c.source_width_in),
        source_initial_feet = coalesce(f.source_initial_feet, c.source_initial_feet),
        source_initial_weight_lbs = coalesce(f.source_initial_weight_lbs, c.source_initial_weight_lbs),
        source_box_id = case
          when coalesce(btrim(f.source_box_id), '') = '' and c.source_box_id is not null
            then c.source_box_id
          else f.source_box_id
        end,
        updated_at = now()
      from candidates c
      where f.id = c.id
    `,
    [orgId],
  );
  updates.film_catalog_metadata_backfills = backfillCatalogMetadata.rowCount ?? 0;

  const deleteObsoleteCatalogRows = await client.query(
    `
      delete from app.film_catalog f
      using tmp_fasara_effective_mapping m
      where f.org_id = $1::uuid
        and m.old_manufacturer_lookup_key = app_api.normalize_catalog_manufacturer_lookup_key(f.manufacturer)
        and m.old_film_name_lookup_key = app_api.normalize_catalog_lookup_key(f.film_name)
        and upper(coalesce(f.film_key, '')) is distinct from m.canonical_film_key
    `,
    [orgId],
  );
  updates.film_catalog_deletes = deleteObsoleteCatalogRows.rowCount ?? 0;

  return updates;
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
  const actor = args.actor ? normalizeCollapsedLabel(args.actor) : "fasara-catalog-curation-script";
  if (!databaseUrl) {
    throw new Error("DATABASE_URL missing in backend/.env");
  }
  if (!orgId) {
    throw new Error("DEFAULT_ORG_ID missing in backend/.env");
  }

  const catalogCsvPath = args["catalog-csv"]
    ? path.resolve(repoRoot, String(args["catalog-csv"]))
    : path.join(backendDir, "docs", "fasara_catalog_curated.csv");
  const aliasCsvPath = args["alias-csv"]
    ? path.resolve(repoRoot, String(args["alias-csv"]))
    : path.join(backendDir, "docs", "fasara_aliases_curated.csv");
  const reportDir = args["report-dir"]
    ? path.resolve(repoRoot, String(args["report-dir"]))
    : path.join(backendDir, "migration-dry-runs", "fasara-catalog-curation");

  const curatedCatalog = loadCuratedCatalog(catalogCsvPath);
  const curatedAliases = loadCuratedAliases(aliasCsvPath, curatedCatalog);
  const effectiveMappings = buildEffectiveMappings(curatedCatalog, curatedAliases);

  const preflightJsonPath = path.join(reportDir, "fasara_preflight.json");
  const summaryJsonPath = path.join(reportDir, "fasara_summary.json");
  const mappingCsvPath = path.join(reportDir, "fasara_effective_mappings.csv");
  const metadataConflictCsvPath = path.join(reportDir, "fasara_film_catalog_metadata_conflicts.csv");
  const requirementCollisionCsvPath = path.join(reportDir, "fasara_job_requirement_collisions.csv");

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query("begin");

    await createTempTables(client, curatedCatalog, curatedAliases, effectiveMappings);
    const preflight = await buildPreflight(client, orgId);

    const blockerCounts = {
      film_catalog_metadata_conflicts: preflight.preflight_blockers.film_catalog_metadata_conflicts.length,
      job_requirement_lookup_collisions: preflight.preflight_blockers.job_requirement_lookup_collisions.length,
    };

    let updatesApplied = {
      aliases_upserted: 0,
      boxes: 0,
      film_catalog_upserts: 0,
      film_catalog_metadata_backfills: 0,
      film_catalog_deletes: 0,
      job_requirements: 0,
      film_orders: 0,
      roll_weight_log: 0,
    };
    let postApply = null;

    if (apply) {
      if (blockerCounts.film_catalog_metadata_conflicts > 0 || blockerCounts.job_requirement_lookup_collisions > 0) {
        throw new Error(
          `Preflight blocked apply: film_catalog_metadata_conflicts=${blockerCounts.film_catalog_metadata_conflicts}, `
          + `job_requirement_lookup_collisions=${blockerCounts.job_requirement_lookup_collisions}`,
        );
      }

      updatesApplied = await runApply(client, orgId, actor);
      await createTempTables(client, curatedCatalog, curatedAliases, effectiveMappings);
      postApply = await buildPreflight(client, orgId);
    }

    await client.query(apply ? "commit" : "rollback");

    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      mappingCsvPath,
      toSimpleCsv(
        effectiveMappings.map((row) => ({
          old_manufacturer_lookup_key: row.old_manufacturer_lookup_key,
          old_film_name_lookup_key: row.old_film_name_lookup_key,
          canonical_manufacturer: row.canonical_manufacturer,
          canonical_manufacturer_lookup_key: row.canonical_manufacturer_lookup_key,
          canonical_film_name: row.canonical_film_name,
          canonical_film_lookup_key: row.canonical_film_lookup_key,
          canonical_film_key: row.canonical_film_key,
          source_type: row.source_type,
        })),
        [
          "old_manufacturer_lookup_key",
          "old_film_name_lookup_key",
          "canonical_manufacturer",
          "canonical_manufacturer_lookup_key",
          "canonical_film_name",
          "canonical_film_lookup_key",
          "canonical_film_key",
          "source_type",
        ],
      ),
      "utf8",
    );

    fs.writeFileSync(
      metadataConflictCsvPath,
      toSimpleCsv(
        preflight.preflight_blockers.film_catalog_metadata_conflicts.map((row) => ({
          canonical_film_key: row.canonical_film_key,
          field_name: row.field_name,
          distinct_value_count: row.distinct_value_count,
          distinct_values: Array.isArray(row.distinct_values) ? row.distinct_values.join(";") : "",
        })),
        ["canonical_film_key", "field_name", "distinct_value_count", "distinct_values"],
      ),
      "utf8",
    );

    fs.writeFileSync(
      requirementCollisionCsvPath,
      toSimpleCsv(
        preflight.preflight_blockers.job_requirement_lookup_collisions.map((row) => ({
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
      `${JSON.stringify({ preflight, post_apply: postApply }, null, 2)}\n`,
      "utf8",
    );

    const summary = {
      generated_at_utc: new Date().toISOString(),
      org_id: orgId,
      apply,
      actor,
      curated_catalog_row_count: curatedCatalog.rows.length,
      curated_alias_row_count: curatedAliases.rows.length,
      effective_mapping_row_count: effectiveMappings.length,
      report_dir: toPosixPath(path.relative(repoRoot, reportDir)),
      inputs: {
        catalog_csv: toPosixPath(path.relative(repoRoot, catalogCsvPath)),
        alias_csv: toPosixPath(path.relative(repoRoot, aliasCsvPath)),
      },
      blockers: blockerCounts,
      candidate_updates: preflight.candidate_updates,
      updates_applied: updatesApplied,
      post_apply: postApply,
      artifacts: {
        preflight_json: toPosixPath(path.relative(repoRoot, preflightJsonPath)),
        summary_json: toPosixPath(path.relative(repoRoot, summaryJsonPath)),
        effective_mappings_csv: toPosixPath(path.relative(repoRoot, mappingCsvPath)),
        film_catalog_metadata_conflicts_csv: toPosixPath(path.relative(repoRoot, metadataConflictCsvPath)),
        job_requirement_collisions_csv: toPosixPath(path.relative(repoRoot, requirementCollisionCsvPath)),
      },
    };

    fs.writeFileSync(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    console.log(
      JSON.stringify(
        {
          org_id: orgId,
          apply,
          curated_catalog_row_count: curatedCatalog.rows.length,
          curated_alias_row_count: curatedAliases.rows.length,
          effective_mapping_row_count: effectiveMappings.length,
          blockers: blockerCounts,
          candidate_updates: preflight.candidate_updates,
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
