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

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function toPosixPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function manufacturerNormalizedSql(columnSql) {
  return `regexp_replace(btrim(coalesce(${columnSql}, '')), '\\s+', ' ', 'g')`;
}

function manufacturerCanonicalSql(columnSql) {
  const normalized = manufacturerNormalizedSql(columnSql);
  return `
    case lower(${normalized})
      when '3m' then '3M Solar'
      when 'avery' then 'Avery Dennison'
      when 'solar guard' then 'Solar Gard'
      else ${normalized}
    end
  `;
}

function manufacturerNeedsUpdatePredicate(columnSql) {
  const normalized = manufacturerNormalizedSql(columnSql);
  const canonical = manufacturerCanonicalSql(columnSql);
  return `${canonical} is distinct from ${normalized}`;
}

async function queryInt(client, sql, params = []) {
  const result = await client.query(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

async function buildPreflight(client, orgId) {
  const tableCandidates = {};

  tableCandidates.boxes = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.boxes b
      where b.org_id = $1::uuid
        and ${manufacturerNeedsUpdatePredicate("b.manufacturer")}
    `,
    [orgId],
  );

  tableCandidates.film_catalog = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.film_catalog f
      where f.org_id = $1::uuid
        and ${manufacturerNeedsUpdatePredicate("f.manufacturer")}
    `,
    [orgId],
  );

  tableCandidates.job_requirements = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.job_requirements r
      where r.org_id = $1::uuid
        and ${manufacturerNeedsUpdatePredicate("r.manufacturer")}
    `,
    [orgId],
  );

  tableCandidates.film_orders = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.film_orders f
      where f.org_id = $1::uuid
        and ${manufacturerNeedsUpdatePredicate("f.manufacturer")}
    `,
    [orgId],
  );

  tableCandidates.roll_weight_log = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.roll_weight_log r
      where r.org_id = $1::uuid
        and ${manufacturerNeedsUpdatePredicate("r.manufacturer")}
    `,
    [orgId],
  );

  const fasaraCounts = {};
  fasaraCounts.boxes = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.boxes b
      where b.org_id = $1::uuid
        and lower(${manufacturerNormalizedSql("b.manufacturer")}) = '3m fasara'
    `,
    [orgId],
  );
  fasaraCounts.film_catalog = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.film_catalog f
      where f.org_id = $1::uuid
        and lower(${manufacturerNormalizedSql("f.manufacturer")}) = '3m fasara'
    `,
    [orgId],
  );
  fasaraCounts.job_requirements = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.job_requirements r
      where r.org_id = $1::uuid
        and lower(${manufacturerNormalizedSql("r.manufacturer")}) = '3m fasara'
    `,
    [orgId],
  );
  fasaraCounts.film_orders = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.film_orders f
      where f.org_id = $1::uuid
        and lower(${manufacturerNormalizedSql("f.manufacturer")}) = '3m fasara'
    `,
    [orgId],
  );
  fasaraCounts.roll_weight_log = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.roll_weight_log r
      where r.org_id = $1::uuid
        and lower(${manufacturerNormalizedSql("r.manufacturer")}) = '3m fasara'
    `,
    [orgId],
  );

  const legacyRemainingCounts = {};
  legacyRemainingCounts.boxes = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.boxes b
      where b.org_id = $1::uuid
        and lower(${manufacturerNormalizedSql("b.manufacturer")}) in ('3m', 'avery', 'solar guard')
    `,
    [orgId],
  );
  legacyRemainingCounts.film_catalog = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.film_catalog f
      where f.org_id = $1::uuid
        and lower(${manufacturerNormalizedSql("f.manufacturer")}) in ('3m', 'avery', 'solar guard')
    `,
    [orgId],
  );
  legacyRemainingCounts.job_requirements = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.job_requirements r
      where r.org_id = $1::uuid
        and lower(${manufacturerNormalizedSql("r.manufacturer")}) in ('3m', 'avery', 'solar guard')
    `,
    [orgId],
  );
  legacyRemainingCounts.film_orders = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.film_orders f
      where f.org_id = $1::uuid
        and lower(${manufacturerNormalizedSql("f.manufacturer")}) in ('3m', 'avery', 'solar guard')
    `,
    [orgId],
  );
  legacyRemainingCounts.roll_weight_log = await queryInt(
    client,
    `
      select count(*)::int as count
      from app.roll_weight_log r
      where r.org_id = $1::uuid
        and lower(${manufacturerNormalizedSql("r.manufacturer")}) in ('3m', 'avery', 'solar guard')
    `,
    [orgId],
  );

  const filmCatalogCollisions = await client.query(
    `
      with mapped as (
        select
          f.id,
          f.film_key as old_film_key,
          ${manufacturerCanonicalSql("f.manufacturer")} as canonical_manufacturer,
          upper(${manufacturerCanonicalSql("f.manufacturer")}) || '|' || upper(${manufacturerNormalizedSql("f.film_name")}) as canonical_film_key
        from app.film_catalog f
        where f.org_id = $1::uuid
      )
      select
        m.canonical_film_key,
        count(*)::int as row_count,
        array_agg(m.old_film_key order by m.old_film_key) as source_film_keys
      from mapped m
      group by m.canonical_film_key
      having count(*) > 1
      order by row_count desc, canonical_film_key asc
    `,
    [orgId],
  );

  const requirementCollisions = await client.query(
    `
      with mapped as (
        select
          r.id,
          r.job_id,
          j.job_number,
          ${manufacturerCanonicalSql("r.manufacturer")} as canonical_manufacturer,
          ${manufacturerNormalizedSql("r.film_name")} as normalized_film_name,
          round(coalesce(r.width_in, 0)::numeric, 4)::text as width_key
        from app.job_requirements r
        join app.jobs j
          on j.id = r.job_id
        where r.org_id = $1::uuid
      ),
      grouped as (
        select
          m.job_id,
          m.job_number,
          lower(${manufacturerNormalizedSql("m.canonical_manufacturer")})
            || '|' || lower(${manufacturerNormalizedSql("m.normalized_film_name")})
            || '|' || m.width_key as canonical_lookup_key,
          count(*)::int as row_count,
          array_agg(m.id order by m.id) as source_requirement_ids
        from mapped m
        group by m.job_id, m.job_number, canonical_lookup_key
      )
      select
        g.job_id,
        g.job_number,
        g.canonical_lookup_key,
        g.row_count,
        g.source_requirement_ids
      from grouped g
      where g.row_count > 1
      order by g.row_count desc, g.job_number asc, g.canonical_lookup_key asc
    `,
    [orgId],
  );

  return {
    table_candidate_updates: tableCandidates,
    legacy_label_rows_remaining: legacyRemainingCounts,
    fasara_counts: fasaraCounts,
    preflight_blockers: {
      film_catalog_key_collisions: filmCatalogCollisions.rows,
      job_requirement_key_collisions: requirementCollisions.rows,
    },
  };
}

async function runApply(client, orgId) {
  const updates = {};

  const updateBoxes = await client.query(
    `
      with candidates as (
        select
          b.id,
          ${manufacturerCanonicalSql("b.manufacturer")} as canonical_manufacturer,
          upper(${manufacturerCanonicalSql("b.manufacturer")}) || '|' || upper(${manufacturerNormalizedSql("b.film_name")}) as canonical_film_key
        from app.boxes b
        where b.org_id = $1::uuid
          and ${manufacturerNeedsUpdatePredicate("b.manufacturer")}
      )
      update app.boxes b
      set
        manufacturer = c.canonical_manufacturer,
        film_key = c.canonical_film_key,
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
          ${manufacturerCanonicalSql("f.manufacturer")} as canonical_manufacturer,
          upper(${manufacturerCanonicalSql("f.manufacturer")}) || '|' || upper(${manufacturerNormalizedSql("f.film_name")}) as canonical_film_key
        from app.film_catalog f
        where f.org_id = $1::uuid
          and ${manufacturerNeedsUpdatePredicate("f.manufacturer")}
      )
      update app.film_catalog f
      set
        manufacturer = c.canonical_manufacturer,
        film_key = c.canonical_film_key,
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
          ${manufacturerCanonicalSql("r.manufacturer")} as canonical_manufacturer
        from app.job_requirements r
        where r.org_id = $1::uuid
          and ${manufacturerNeedsUpdatePredicate("r.manufacturer")}
      )
      update app.job_requirements r
      set
        manufacturer = c.canonical_manufacturer,
        updated_at = now()
      from candidates c
      where r.id = c.id
    `,
    [orgId],
  );
  updates.job_requirements = updateRequirements.rowCount ?? 0;

  const updateFilmOrders = await client.query(
    `
      with candidates as (
        select
          f.id,
          ${manufacturerCanonicalSql("f.manufacturer")} as canonical_manufacturer
        from app.film_orders f
        where f.org_id = $1::uuid
          and ${manufacturerNeedsUpdatePredicate("f.manufacturer")}
      )
      update app.film_orders f
      set manufacturer = c.canonical_manufacturer
      from candidates c
      where f.id = c.id
    `,
    [orgId],
  );
  updates.film_orders = updateFilmOrders.rowCount ?? 0;

  const updateRollLog = await client.query(
    `
      with candidates as (
        select
          r.id,
          ${manufacturerCanonicalSql("r.manufacturer")} as canonical_manufacturer
        from app.roll_weight_log r
        where r.org_id = $1::uuid
          and ${manufacturerNeedsUpdatePredicate("r.manufacturer")}
      )
      update app.roll_weight_log r
      set manufacturer = c.canonical_manufacturer
      from candidates c
      where r.id = c.id
    `,
    [orgId],
  );
  updates.roll_weight_log = updateRollLog.rowCount ?? 0;

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
  if (!databaseUrl) throw new Error("DATABASE_URL missing in backend/.env");
  if (!orgId) throw new Error("DEFAULT_ORG_ID missing in backend/.env");

  const reportDir = args["report-dir"]
    ? path.resolve(repoRoot, String(args["report-dir"]))
    : path.join(backendDir, "migration-dry-runs", "manufacturer-canonicalization");
  const reportJsonPath = args["report-json"]
    ? path.resolve(repoRoot, String(args["report-json"]))
    : path.join(reportDir, "manufacturer_reconcile_report.json");
  const filmCatalogCollisionCsvPath = path.join(reportDir, "film_catalog_collision_candidates.csv");
  const requirementCollisionCsvPath = path.join(reportDir, "job_requirement_collision_candidates.csv");

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query("begin");

    const preflight = await buildPreflight(client, orgId);
    const filmCatalogCollisions = preflight.preflight_blockers.film_catalog_key_collisions || [];
    const requirementCollisions = preflight.preflight_blockers.job_requirement_key_collisions || [];
    const blockers = {
      film_catalog_key_collisions: filmCatalogCollisions.length,
      job_requirement_key_collisions: requirementCollisions.length,
    };

    let updatesApplied = {
      boxes: 0,
      film_catalog: 0,
      job_requirements: 0,
      film_orders: 0,
      roll_weight_log: 0,
    };
    let postApply = null;

    if (apply) {
      if (blockers.film_catalog_key_collisions > 0 || blockers.job_requirement_key_collisions > 0) {
        throw new Error(
          `Preflight blocked apply: film_catalog_key_collisions=${blockers.film_catalog_key_collisions}, job_requirement_key_collisions=${blockers.job_requirement_key_collisions}`,
        );
      }

      updatesApplied = await runApply(client, orgId);
      postApply = await buildPreflight(client, orgId);
    }

    await client.query(apply ? "commit" : "rollback");

    fs.mkdirSync(reportDir, { recursive: true });
    const report = {
      generated_at_utc: new Date().toISOString(),
      org_id: orgId,
      apply,
      report_dir: toPosixPath(path.relative(repoRoot, reportDir)),
      preflight,
      blockers,
      updates_applied: updatesApplied,
      post_apply: postApply,
    };

    fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const filmCatalogCollisionLines = [
      "canonical_film_key,row_count,source_film_keys",
      ...filmCatalogCollisions.map((row) =>
        [
          row.canonical_film_key,
          row.row_count,
          Array.isArray(row.source_film_keys) ? row.source_film_keys.join(";") : "",
        ]
          .map(csvCell)
          .join(","),
      ),
    ];
    fs.writeFileSync(filmCatalogCollisionCsvPath, `${filmCatalogCollisionLines.join("\n")}\n`, "utf8");

    const requirementCollisionLines = [
      "job_id,job_number,canonical_lookup_key,row_count,source_requirement_ids",
      ...requirementCollisions.map((row) =>
        [
          row.job_id,
          row.job_number,
          row.canonical_lookup_key,
          row.row_count,
          Array.isArray(row.source_requirement_ids) ? row.source_requirement_ids.join(";") : "",
        ]
          .map(csvCell)
          .join(","),
      ),
    ];
    fs.writeFileSync(requirementCollisionCsvPath, `${requirementCollisionLines.join("\n")}\n`, "utf8");

    console.log(
      JSON.stringify(
        {
          org_id: orgId,
          apply,
          report_json: toPosixPath(path.relative(repoRoot, reportJsonPath)),
          film_catalog_collision_csv: toPosixPath(path.relative(repoRoot, filmCatalogCollisionCsvPath)),
          job_requirement_collision_csv: toPosixPath(path.relative(repoRoot, requirementCollisionCsvPath)),
          blockers,
          updates_applied: updatesApplied,
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
