import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const migrationPath = path.join(backendDir, "migrations", "0020_warehouse_prefix_v2.sql");
const reportDir = path.join(backendDir, "migration-dry-runs", "warehouse-prefix-v2");
const resultPath = path.join(reportDir, "migration_result.json");
const aliasMapPath = path.join(reportDir, "alias_mapping.csv");

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

function csvCell(value) {
  const text = String(value ?? "");
  const escaped = text.replace(/"/g, "\"\"");
  return `"${escaped}"`;
}

async function main() {
  const envPath = path.join(backendDir, ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing env file: ${envPath}`);
  }
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Missing migration file: ${migrationPath}`);
  }

  const env = parseEnv(envPath);
  const databaseUrl = env.DATABASE_URL;
  const orgId = env.DEFAULT_ORG_ID;
  if (!databaseUrl) throw new Error("DATABASE_URL missing in backend/.env");
  if (!orgId) throw new Error("DEFAULT_ORG_ID missing in backend/.env");

  const sql = fs.readFileSync(migrationPath, "utf8");
  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    await client.query("begin");
    await client.query(sql);

    const preflightRes = await client.query(
      "select import.warehouse_prefix_v2_preflight($1::uuid) as report",
      [orgId],
    );
    const preflight = preflightRes.rows[0]?.report ?? {};
    const duplicateTargets = Number(preflight.duplicate_target_box_ids ?? 0);
    const existingCollisions = Number(preflight.existing_target_collisions ?? 0);
    if (duplicateTargets > 0 || existingCollisions > 0) {
      throw new Error(
        `Preflight blocked migration: duplicate_target_box_ids=${duplicateTargets}, existing_target_collisions=${existingCollisions}`,
      );
    }

    const migrateRes = await client.query(
      "select import.migrate_org_warehouse_prefix_v2($1::uuid, $2::text, $3::integer) as result",
      [orgId, "migration", 90],
    );
    const migrationResult = migrateRes.rows[0]?.result ?? {};
    await client.query("commit");

    const aliasRes = await client.query(
      `
        select old_box_id, canonical_box_id, expires_at
        from app.box_id_aliases
        where org_id = $1::uuid
        order by old_box_id
      `,
      [orgId],
    );

    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      resultPath,
      JSON.stringify(
        {
          org_id: orgId,
          preflight,
          migration_result: migrationResult,
          generated_at_utc: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    const aliasLines = [
      "old_box_id,canonical_box_id,expires_at",
      ...aliasRes.rows.map((row) =>
        [row.old_box_id, row.canonical_box_id, row.expires_at].map(csvCell).join(","),
      ),
    ];
    fs.writeFileSync(aliasMapPath, `${aliasLines.join("\n")}\n`);

    console.log(
      JSON.stringify(
        {
          org_id: orgId,
          result_path: resultPath,
          alias_mapping_path: aliasMapPath,
          alias_rows: aliasRes.rows.length,
          migration_result: migrationResult,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // noop
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
