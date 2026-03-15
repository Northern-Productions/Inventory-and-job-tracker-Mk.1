import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const reportDir = path.join(backendDir, "migration-dry-runs", "warehouse-prefix-v2");
const jsonPath = path.join(reportDir, "verify_report.json");
const mdPath = path.join(reportDir, "verify_report.md");

function parseEnv(filePath) {
  const out = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

async function main() {
  const envPath = path.join(backendDir, ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing env file: ${envPath}`);
  }

  const env = parseEnv(envPath);
  const databaseUrl = env.DATABASE_URL;
  const orgId = env.DEFAULT_ORG_ID;
  if (!databaseUrl) throw new Error("DATABASE_URL missing in backend/.env");
  if (!orgId) throw new Error("DEFAULT_ORG_ID missing in backend/.env");

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const [
      totalBoxesRes,
      duplicateRes,
      invalidFormatRes,
      fkMismatchRes,
      legacyIdRes,
      warehouseRes,
      aliasRes,
      aliasResolutionRes,
      aliasSampleRes,
    ] = await Promise.all([
      client.query("select count(*)::int as c from app.boxes where org_id = $1::uuid", [orgId]),
      client.query(
        `
          select count(*)::int as c
          from (
            select box_id
            from app.boxes
            where org_id = $1::uuid
            group by box_id
            having count(*) > 1
          ) d
        `,
        [orgId],
      ),
      client.query(
        `
          select count(*)::int as c
          from app.boxes
          where org_id = $1::uuid
            and box_id !~ '^[A-Z]{2}[1-9][0-9]*-.+'
        `,
        [orgId],
      ),
      client.query(
        `
          select count(*)::int as c
          from app.boxes b
          left join app.warehouses w
            on w.org_id = b.org_id
           and w.code = b.warehouse
          where b.org_id = $1::uuid
            and w.code is null
        `,
        [orgId],
      ),
      client.query(
        `
          select count(*)::int as c
          from app.boxes
          where org_id = $1::uuid
            and (box_id like 'IL-%' or box_id ~ '^M[0-9A-Z]+$')
        `,
        [orgId],
      ),
      client.query(
        `
          select code, box_id_prefix
          from app.warehouses
          where org_id = $1::uuid
          order by code
        `,
        [orgId],
      ),
      client.query(
        `
          select count(*)::int as c
          from app.box_id_aliases
          where org_id = $1::uuid
            and expires_at >= now()
        `,
        [orgId],
      ),
      client.query(
        `
          select count(*)::int as c
          from app.box_id_aliases a
          where a.org_id = $1::uuid
            and a.expires_at >= now()
            and app_api.resolve_box_id_alias($1::uuid, a.old_box_id, now()) <> a.canonical_box_id
        `,
        [orgId],
      ),
      client.query(
        `
          select old_box_id, canonical_box_id, expires_at
          from app.box_id_aliases
          where org_id = $1::uuid
            and expires_at >= now()
          order by old_box_id
          limit 25
        `,
        [orgId],
      ),
    ]);

    const report = {
      org_id: orgId,
      generated_at_utc: new Date().toISOString(),
      totals: {
        boxes: totalBoxesRes.rows[0]?.c ?? 0,
        active_alias_rows: aliasRes.rows[0]?.c ?? 0,
      },
      integrity: {
        duplicate_box_ids: duplicateRes.rows[0]?.c ?? 0,
        invalid_box_id_format: invalidFormatRes.rows[0]?.c ?? 0,
        warehouse_fk_mismatches: fkMismatchRes.rows[0]?.c ?? 0,
        legacy_box_ids_remaining: legacyIdRes.rows[0]?.c ?? 0,
        alias_resolution_failures: aliasResolutionRes.rows[0]?.c ?? 0,
      },
      warehouses: warehouseRes.rows,
      alias_sample: aliasSampleRes.rows,
    };

    const passed =
      report.integrity.duplicate_box_ids === 0 &&
      report.integrity.invalid_box_id_format === 0 &&
      report.integrity.warehouse_fk_mismatches === 0 &&
      report.integrity.legacy_box_ids_remaining === 0 &&
      report.integrity.alias_resolution_failures === 0;

    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify({ ...report, passed }, null, 2));

    const md = [
      "# Warehouse Prefix V2 Verify Report",
      "",
      `- Org: \`${orgId}\``,
      `- Generated (UTC): ${report.generated_at_utc}`,
      "",
      "## Totals",
      `- Boxes: ${report.totals.boxes}`,
      `- Active alias rows: ${report.totals.active_alias_rows}`,
      "",
      "## Integrity",
      `- Duplicate box_id: ${report.integrity.duplicate_box_ids}`,
      `- Invalid BoxID format: ${report.integrity.invalid_box_id_format}`,
      `- Warehouse FK mismatches: ${report.integrity.warehouse_fk_mismatches}`,
      `- Legacy IDs remaining: ${report.integrity.legacy_box_ids_remaining}`,
      `- Alias resolution failures: ${report.integrity.alias_resolution_failures}`,
      "",
      "## Status",
      `- Passed: ${passed ? "YES" : "NO"}`,
    ].join("\n");
    fs.writeFileSync(mdPath, `${md}\n`);

    console.log(
      JSON.stringify(
        {
          org_id: orgId,
          passed,
          report_json: jsonPath,
          report_md: mdPath,
          integrity: report.integrity,
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
