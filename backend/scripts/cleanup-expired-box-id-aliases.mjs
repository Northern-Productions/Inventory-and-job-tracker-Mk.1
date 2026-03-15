import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");

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

  const client = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const res = await client.query(
      "select app_api.cleanup_expired_box_id_aliases($1::uuid) as deleted_count",
      [orgId || null],
    );
    console.log(
      JSON.stringify(
        {
          org_id: orgId || null,
          deleted_count: res.rows[0]?.deleted_count ?? 0,
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
