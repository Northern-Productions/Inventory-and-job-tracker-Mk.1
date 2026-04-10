import "../load-env.mjs";
import { Client } from "pg";

function assertOk(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const databaseUrl = String(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || "").trim();
const orgId = String(process.env.DEFAULT_ORG_ID || "").trim();

assertOk(databaseUrl, "DATABASE_URL or SUPABASE_DB_URL is required.");

const client = new Client({
  connectionString: databaseUrl,
  ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
});

await client.connect();

try {
  const listDefRes = await client.query(
    `select pg_get_functiondef('public.api_acl_list_caulk_transactions(uuid, text, uuid, integer)'::regprocedure) as definition`,
  );
  const mutateDefRes = await client.query(
    `select pg_get_functiondef('public.api_acl_caulk_mutate_stock(uuid, text, jsonb)'::regprocedure) as definition`,
  );
  const listDef = String(listDefRes.rows[0]?.definition || "").toLowerCase();
  const mutateDef = String(mutateDefRes.rows[0]?.definition || "").toLowerCase();

  assertOk(
    listDef.includes("checked in unused caulk from job %s."),
    "Transaction list function is missing caulk check-in job-number reason mapping.",
  );
  assertOk(
    listDef.includes("t.action = 'adjust'") &&
      listDef.includes("inventory edit") &&
      listDef.includes("then btrim(t.notes)"),
    "Transaction list function is missing adjustment-notes reason mapping.",
  );
  assertOk(
    mutateDef.includes("v_action = 'adjust'") &&
      mutateDef.includes("v_notes <> ''") &&
      mutateDef.includes("lower(v_reason) = 'inventory edit'") &&
      mutateDef.includes("v_reason := v_notes"),
    "Caulk mutate function is missing adjustment-notes reason hardening.",
  );

  if (!orgId) {
    console.log("[caulk-reasons] Function definition checks passed. DEFAULT_ORG_ID not set; skipped live row spot check.");
    process.exit(0);
  }

  const memberRes = await client.query(
    `
      select user_id::text as user_id, role
      from app.organization_members
      where org_id = $1::uuid
      order by case role when 'owner' then 0 when 'admin' then 1 else 2 end, created_at asc
      limit 1
    `,
    [orgId],
  );
  const userId = String(memberRes.rows[0]?.user_id || "").trim();
  const role = String(memberRes.rows[0]?.role || "").trim();

  if (!userId) {
    console.log("[caulk-reasons] Function definition checks passed. No org member found; skipped live row spot check.");
    process.exit(0);
  }

  const sampleRes = await client.query(
    `
      select
        transaction_id,
        product_id,
        warehouse,
        btrim(notes) as expected_reason
      from app.caulk_transactions
      where org_id = $1::uuid
        and action = 'ADJUST'
        and lower(btrim(coalesce(reason, ''))) = 'inventory edit'
        and btrim(coalesce(notes, '')) <> ''
      order by created_at desc
      limit 1
    `,
    [orgId],
  );

  if (!sampleRes.rows.length) {
    console.log(`[caulk-reasons] Function definition checks passed as ${role}. No historical adjustment-with-notes row found; skipped live row spot check.`);
    process.exit(0);
  }

  const sample = sampleRes.rows[0];
  await client.query("begin");
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, email: "verification@example.invalid", role: "authenticated" }),
  ]);

  const transactionsRes = await client.query(
    `
      select transaction_id, reason
      from public.api_acl_list_caulk_transactions($1::uuid, $2::text, $3::uuid, $4::integer)
      where transaction_id = $5::text
      limit 1
    `,
    [orgId, sample.warehouse, sample.product_id, 1000, sample.transaction_id],
  );
  await client.query("commit");

  const displayedReason = String(transactionsRes.rows[0]?.reason || "").trim();
  assertOk(
    displayedReason === sample.expected_reason,
    `Expected adjustment reason "${sample.expected_reason}", received "${displayedReason}".`,
  );

  console.log(`[caulk-reasons] Function definition checks passed as ${role}; live adjustment row displays notes as reason.`);
} catch (error) {
  try {
    await client.query("rollback");
  } catch (_rollbackError) {
    // Ignore rollback failure and surface the original error.
  }
  throw error;
} finally {
  await client.end();
}
