import "../load-env.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, "..");
const migrationPath = path.join(backendDir, "migrations", "0030_caulk_job_allocation_workflow.sql");

function assertOk(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectFailure(client, run, label, pattern) {
  await client.query("savepoint sp_expect_failure");
  try {
    await run();
  } catch (error) {
    await client.query("rollback to savepoint sp_expect_failure");
    await client.query("release savepoint sp_expect_failure");
    const message = error instanceof Error ? error.message : String(error);
    if (pattern && !pattern.test(message)) {
      throw new Error(`${label} failed with unexpected message: ${message}`);
    }
    return;
  }
  await client.query("release savepoint sp_expect_failure");
  throw new Error(`${label} was expected to fail but succeeded`);
}

async function getStockTubes(client, orgId, productId, warehouse) {
  const res = await client.query(
    `
      select tubes_on_hand
      from app.caulk_stock
      where org_id = $1::uuid
        and product_id = $2::uuid
        and warehouse = $3::text
    `,
    [orgId, productId, warehouse],
  );
  return Number(res.rows[0]?.tubes_on_hand ?? 0);
}

async function ensureMigrationObjects(client) {
  const tables = [
    "app.job_caulk_requirements",
    "app.caulk_job_allocations",
    "app.caulk_job_checkouts",
  ];
  const functions = [
    "public.api_acl_jobs_cancel_caulk_allocations(uuid, text, jsonb)",
    "public.api_acl_list_job_caulk_requirements_by_job(uuid, text)",
    "public.api_acl_list_caulk_job_allocations_by_job(uuid, text)",
    "public.api_acl_list_caulk_job_checkouts_by_job(uuid, text)",
    "public.api_acl_allocations_caulk_add(uuid, text, jsonb)",
    "public.api_acl_allocations_caulk_update(uuid, text, jsonb)",
    "public.api_acl_allocations_caulk_checkout(uuid, text, jsonb)",
    "public.api_acl_allocations_caulk_checkin(uuid, text, jsonb)",
    "public.api_acl_allocations_caulk_remove(uuid, text, jsonb)",
  ];

  for (const signature of tables) {
    const res = await client.query("select to_regclass($1) is not null as exists", [signature]);
    assertOk(Boolean(res.rows[0]?.exists), `Missing required table: ${signature}`);
  }
  for (const signature of functions) {
    const res = await client.query("select to_regprocedure($1) is not null as exists", [signature]);
    assertOk(Boolean(res.rows[0]?.exists), `Missing required function: ${signature}`);
  }

  const actionConstraintRes = await client.query(
    `
      select pg_get_constraintdef(c.oid) as constraint_def
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'app'
        and t.relname = 'caulk_transactions'
        and c.contype = 'c'
        and c.conname ilike '%action%'
      limit 1
    `,
  );
  const actionConstraint = String(actionConstraintRes.rows[0]?.constraint_def || "");
  const requiredActions = [
    "JOB_ALLOCATE",
    "JOB_ALLOCATE_EDIT_INC",
    "JOB_ALLOCATE_EDIT_DEC",
    "JOB_CHECKOUT_OVERAGE",
    "JOB_CHECKIN_UNUSED",
    "JOB_ALLOCATION_CANCEL_RETURN",
  ];
  for (const action of requiredActions) {
    assertOk(
      actionConstraint.includes(action),
      `caulk_transactions action constraint is missing ${action}`,
    );
  }
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || "").trim();
  const orgId = String(process.env.DEFAULT_ORG_ID || "").trim();
  assertOk(databaseUrl, "DATABASE_URL or SUPABASE_DB_URL is required.");
  assertOk(orgId, "DEFAULT_ORG_ID is required.");
  assertOk(fs.existsSync(migrationPath), `Missing migration file: ${migrationPath}`);

  const migrationSql = fs.readFileSync(migrationPath, "utf8");
  const client = new Client({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    console.log("[0030] Applying migration...");
    await client.query(migrationSql);
    console.log("[0030] Migration applied.");

    await ensureMigrationObjects(client);
    console.log("[0030] Required tables/functions/constraint checks passed.");

    const actorMemberRes = await client.query(
      `
        select user_id::text as user_id, role
        from app.organization_members
        where org_id = $1::uuid
        order by
          case role when 'owner' then 0 when 'admin' then 1 else 2 end,
          created_at asc
        limit 1
      `,
      [orgId],
    );
    const actorUserId = String(actorMemberRes.rows[0]?.user_id || "").trim();
    const actorRole = String(actorMemberRes.rows[0]?.role || "").trim();
    assertOk(actorUserId, `No org member found for org ${orgId}`);
    assertOk(Boolean(actorRole), `No org role found for user ${actorUserId}`);

    await client.query(
      `
        select
          set_config('request.jwt.claim.sub', $1::text, false),
          set_config('request.jwt.claim.role', 'authenticated', false),
          set_config('request.jwt.claim.email', 'smoke.caulk.workflow@example.local', false),
          set_config(
            'request.jwt.claims',
            json_build_object('sub', $1::text, 'role', 'authenticated', 'email', 'smoke.caulk.workflow@example.local')::text,
            false
          )
      `,
      [actorUserId],
    );

    const warehouseRes = await client.query(
      `
        select code
        from app.warehouses
        where org_id = $1::uuid
        order by code asc
        limit 1
      `,
      [orgId],
    );
    const warehouse = String(warehouseRes.rows[0]?.code || "").trim();
    assertOk(warehouse, `No warehouse found for org ${orgId}`);

    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const jobNumber = `9${suffix.slice(-7).padStart(7, "0")}`;
    const actor = `smoke-caulk-job-workflow-${suffix}`;
    const manufacturerName = `Smoke Manufacturer ${suffix}`;
    const productName = `Smoke Product ${suffix}`;
    const productCode = `SMK-${suffix.slice(-6)}`;
    const secondProductName = `Smoke Product Secondary ${suffix}`;
    const secondProductCode = `SMS-${suffix.slice(-6)}`;

    let step = "begin";
    await client.query("begin");
    try {
      step = "upsert manufacturer";
      const manufacturerRes = await client.query(
        `
          select (app_api.caulk_upsert_manufacturer($1::uuid, $2::text, $3::text, true)).id as manufacturer_id
        `,
        [orgId, actor, manufacturerName],
      );
      const manufacturerId = String(manufacturerRes.rows[0]?.manufacturer_id || "").trim();
      assertOk(manufacturerId, "Unable to upsert caulk manufacturer for smoke test.");

      step = "upsert product";
      const productRes = await client.query(
        `
          select (app_api.caulk_upsert_product($1::uuid, $2::text, null::uuid, $3::uuid, $4::text, $5::text, $6::integer, true, $7::text)).id as product_id
        `,
        [orgId, actor, manufacturerId, productName, productCode, 12, "Smoke test product"],
      );
      const productId = String(productRes.rows[0]?.product_id || "").trim();
      assertOk(productId, "Unable to upsert caulk product for smoke test.");

      step = "upsert second product";
      const secondProductRes = await client.query(
        `
          select (app_api.caulk_upsert_product($1::uuid, $2::text, null::uuid, $3::uuid, $4::text, $5::text, $6::integer, true, $7::text)).id as product_id
        `,
        [orgId, actor, manufacturerId, secondProductName, secondProductCode, 12, "Smoke test secondary product"],
      );
      const secondProductId = String(secondProductRes.rows[0]?.product_id || "").trim();
      assertOk(secondProductId, "Unable to upsert second caulk product for smoke test.");

      step = "seed stock";
      await client.query(
        `
          select app_api.caulk_apply_stock_delta($1::uuid, $2::text, $3::uuid, $4::text, 'RECEIVE', 50, 'SMOKE_CAULK_WORKFLOW', '', '', 'Seed stock for caulk job workflow smoke test')
        `,
        [orgId, actor, productId, warehouse],
      );
      assertOk((await getStockTubes(client, orgId, productId, warehouse)) === 50, "Seed stock was not applied as expected.");

      step = "create job";
      const createJobPayload = {
        jobNumber,
        warehouse,
        dueDate: "2026-03-22",
        crewLeader: "Smoke Test",
        requirements: [],
        caulkRequirements: [{ productId, requiredTubes: 20 }],
      };
      await client.query("select public.api_acl_jobs_create($1::uuid, $2::text, $3::jsonb)", [
        orgId,
        actor,
        JSON.stringify(createJobPayload),
      ]);

      step = "list caulk requirements";
      const requirementRes = await client.query(
        "select * from public.api_acl_list_job_caulk_requirements_by_job($1::uuid, $2::text)",
        [orgId, jobNumber],
      );
      const requirementId = String(requirementRes.rows[0]?.requirement_id || "").trim();
      assertOk(requirementId, "Caulk requirement row was not created.");

      step = "update job caulk requirements";
      const updateJobPayload = {
        jobNumber,
        warehouse,
        dueDate: "2026-03-24",
        crewLeader: "Smoke Test Updated",
        requirements: [],
        caulkRequirements: [
          { productId, requiredTubes: 26 },
          { productId: secondProductId, requiredTubes: 8 },
        ],
      };
      await client.query("select public.api_acl_jobs_update($1::uuid, $2::text, $3::jsonb)", [
        orgId,
        actor,
        JSON.stringify(updateJobPayload),
      ]);

      step = "relist updated caulk requirements";
      const updatedRequirementRes = await client.query(
        "select * from public.api_acl_list_job_caulk_requirements_by_job($1::uuid, $2::text)",
        [orgId, jobNumber],
      );
      assertOk(updatedRequirementRes.rows.length === 2, `Expected 2 caulk requirement rows after update, found ${updatedRequirementRes.rows.length}.`);
      const updatedPrimaryRequirement = updatedRequirementRes.rows.find((row) => String(row.product_id || "").trim() === productId);
      const updatedSecondaryRequirement = updatedRequirementRes.rows.find((row) => String(row.product_id || "").trim() === secondProductId);
      assertOk(Boolean(updatedPrimaryRequirement), "Updated primary caulk requirement row was not found.");
      assertOk(Boolean(updatedSecondaryRequirement), "Updated secondary caulk requirement row was not found.");
      assertOk(Number(updatedPrimaryRequirement?.required_tubes ?? 0) === 26, `Expected updated primary requirement to be 26 tubes, received ${updatedPrimaryRequirement?.required_tubes}.`);
      assertOk(Number(updatedSecondaryRequirement?.required_tubes ?? 0) === 8, `Expected updated secondary requirement to be 8 tubes, received ${updatedSecondaryRequirement?.required_tubes}.`);
      const updatedRequirementId = String(updatedPrimaryRequirement?.requirement_id || "").trim();
      assertOk(updatedRequirementId, "Updated primary requirement id was not found.");

      step = "add allocation";
      const addAllocationRes = await client.query(
        "select public.api_acl_allocations_caulk_add($1::uuid, $2::text, $3::jsonb) as result",
        [orgId, actor, JSON.stringify({ jobNumber, requirementId: updatedRequirementId, productId, warehouse, allocatedTubes: 10 })],
      );
      const allocationId = String(addAllocationRes.rows[0]?.result?.caulkAllocationId || "").trim();
      assertOk(allocationId, "Caulk allocation add did not return caulkAllocationId.");
      assertOk((await getStockTubes(client, orgId, productId, warehouse)) === 40, "Allocation reserve did not deduct stock.");

      step = "checkout 1";
      const checkout1Res = await client.query(
        "select public.api_acl_allocations_caulk_checkout($1::uuid, $2::text, $3::jsonb) as result",
        [orgId, actor, JSON.stringify({ caulkAllocationId: allocationId, checkoutTubes: 6 })],
      );
      const checkout1Id = String(checkout1Res.rows[0]?.result?.caulkCheckoutId || "").trim();
      assertOk(checkout1Id, "First checkout did not return caulkCheckoutId.");
      assertOk((await getStockTubes(client, orgId, productId, warehouse)) === 40, "Reserved checkout incorrectly deducted stock.");

      step = "guarded update failure check";
      await expectFailure(
        client,
        () =>
          client.query("select public.api_acl_allocations_caulk_update($1::uuid, $2::text, $3::jsonb)", [
            orgId,
            actor,
            JSON.stringify({ caulkAllocationId: allocationId, allocatedTubes: 9 }),
          ]),
        "Guarded edit decrease after checkout",
        /only increase after checkout starts/i,
      );

      step = "checkin 1";
      await client.query("select public.api_acl_allocations_caulk_checkin($1::uuid, $2::text, $3::jsonb)", [
        orgId,
        actor,
        JSON.stringify({ caulkCheckoutId: checkout1Id, unusedTubes: 2 }),
      ]);
      assertOk((await getStockTubes(client, orgId, productId, warehouse)) === 42, "Check-in unused did not return stock.");

      step = "checkout 2";
      const checkout2Res = await client.query(
        "select public.api_acl_allocations_caulk_checkout($1::uuid, $2::text, $3::jsonb) as result",
        [orgId, actor, JSON.stringify({ caulkAllocationId: allocationId, checkoutTubes: 8 })],
      );
      const checkout2Id = String(checkout2Res.rows[0]?.result?.caulkCheckoutId || "").trim();
      assertOk(checkout2Id, "Second checkout did not return caulkCheckoutId.");
      assertOk((await getStockTubes(client, orgId, productId, warehouse)) === 38, "Over-checkout did not deduct overage stock.");

      step = "checkin 2";
      await client.query("select public.api_acl_allocations_caulk_checkin($1::uuid, $2::text, $3::jsonb)", [
        orgId,
        actor,
        JSON.stringify({ caulkCheckoutId: checkout2Id, unusedTubes: 1 }),
      ]);
      assertOk((await getStockTubes(client, orgId, productId, warehouse)) === 39, "Second check-in did not return unused stock.");

      step = "add allocation 2";
      const addAllocation2Res = await client.query(
        "select public.api_acl_allocations_caulk_add($1::uuid, $2::text, $3::jsonb) as result",
        [orgId, actor, JSON.stringify({ jobNumber, productId, warehouse, allocatedTubes: 5 })],
      );
      const allocation2Id = String(addAllocation2Res.rows[0]?.result?.caulkAllocationId || "").trim();
      assertOk(allocation2Id, "Second allocation add failed.");
      assertOk((await getStockTubes(client, orgId, productId, warehouse)) === 34, "Second reserve deduct failed.");

      step = "checkout 3";
      const checkout3Res = await client.query(
        "select public.api_acl_allocations_caulk_checkout($1::uuid, $2::text, $3::jsonb) as result",
        [orgId, actor, JSON.stringify({ caulkAllocationId: allocation2Id, checkoutTubes: 3 })],
      );
      const checkout3Id = String(checkout3Res.rows[0]?.result?.caulkCheckoutId || "").trim();
      assertOk(checkout3Id, "Third checkout did not return caulkCheckoutId.");

      step = "remove with open checkout failure check";
      await expectFailure(
        client,
        () =>
          client.query("select public.api_acl_allocations_caulk_remove($1::uuid, $2::text, $3::jsonb)", [
            orgId,
            actor,
            JSON.stringify({ caulkAllocationId: allocation2Id, reason: "remove-open-checkout" }),
          ]),
        "Remove allocation with open checkout",
        /open checkout/i,
      );

      step = "checkin 3";
      await client.query("select public.api_acl_allocations_caulk_checkin($1::uuid, $2::text, $3::jsonb)", [
        orgId,
        actor,
        JSON.stringify({ caulkCheckoutId: checkout3Id, unusedTubes: 0 }),
      ]);
      step = "remove allocation 2";
      const remove2Res = await client.query(
        "select public.api_acl_allocations_caulk_remove($1::uuid, $2::text, $3::jsonb) as result",
        [orgId, actor, JSON.stringify({ caulkAllocationId: allocation2Id, reason: "remove-after-checkin" })],
      );
      const released2 = Number(remove2Res.rows[0]?.result?.releasedReservedTubes ?? -1);
      assertOk(released2 === 2, `Expected remove to release 2 tubes, received ${released2}.`);
      assertOk((await getStockTubes(client, orgId, productId, warehouse)) === 36, "Reserved release on remove failed.");

      step = "add allocation 3";
      const addAllocation3Res = await client.query(
        "select public.api_acl_allocations_caulk_add($1::uuid, $2::text, $3::jsonb) as result",
        [orgId, actor, JSON.stringify({ jobNumber, productId, warehouse, allocatedTubes: 4 })],
      );
      const allocation3Id = String(addAllocation3Res.rows[0]?.result?.caulkAllocationId || "").trim();
      assertOk(allocation3Id, "Third allocation add failed.");
      assertOk((await getStockTubes(client, orgId, productId, warehouse)) === 32, "Third reserve deduct failed.");

      step = "checkout 4";
      const checkout4Res = await client.query(
        "select public.api_acl_allocations_caulk_checkout($1::uuid, $2::text, $3::jsonb) as result",
        [orgId, actor, JSON.stringify({ caulkAllocationId: allocation3Id, checkoutTubes: 2 })],
      );
      const checkout4Id = String(checkout4Res.rows[0]?.result?.caulkCheckoutId || "").trim();
      assertOk(checkout4Id, "Fourth checkout did not return caulkCheckoutId.");

      step = "cancel with open checkout failure check";
      await expectFailure(
        client,
        () =>
          client.query("select public.api_acl_jobs_cancel_caulk_allocations($1::uuid, $2::text, $3::jsonb)", [
            orgId,
            actor,
            JSON.stringify({ jobNumber, reason: "cancel-with-open-checkout" }),
          ]),
        "Cancel active caulk allocations with open checkout",
        /checkout.*open|open.*checkout|remain open/i,
      );

      step = "checkin 4";
      await client.query("select public.api_acl_allocations_caulk_checkin($1::uuid, $2::text, $3::jsonb)", [
        orgId,
        actor,
        JSON.stringify({ caulkCheckoutId: checkout4Id, unusedTubes: 0 }),
      ]);
      step = "cancel allocations";
      const cancelRes = await client.query(
        "select public.api_acl_jobs_cancel_caulk_allocations($1::uuid, $2::text, $3::jsonb) as result",
        [orgId, actor, JSON.stringify({ jobNumber, reason: "cancel-after-checkin" })],
      );
      const cancelledCount = Number(cancelRes.rows[0]?.result?.cancelledAllocationCount ?? 0);
      const releasedReserved = Number(cancelRes.rows[0]?.result?.releasedReservedTubes ?? 0);
      assertOk(cancelledCount >= 1, "Expected at least one caulk allocation to be cancelled.");
      assertOk(releasedReserved >= 2, "Expected reserved tubes to be released during cancel.");
      assertOk((await getStockTubes(client, orgId, productId, warehouse)) === 34, "Cancel did not release reserved stock.");

      step = "list allocations by job";
      const allocationsByJobRes = await client.query(
        "select * from public.api_acl_list_caulk_job_allocations_by_job($1::uuid, $2::text)",
        [orgId, jobNumber],
      );
      assertOk(allocationsByJobRes.rows.length >= 2, "Expected caulk allocation rows to be listable by job.");

      step = "list checkouts by job";
      const checkoutsByJobRes = await client.query(
        "select * from public.api_acl_list_caulk_job_checkouts_by_job($1::uuid, $2::text)",
        [orgId, jobNumber],
      );
      assertOk(checkoutsByJobRes.rows.length >= 4, "Expected caulk checkout rows to be listable by job.");

      step = "negative stock guard";
      const minStockRes = await client.query(
        `
          select min(tubes_on_hand)::integer as min_tubes
          from app.caulk_stock
          where org_id = $1::uuid
            and product_id = $2::uuid
        `,
        [orgId, productId],
      );
      const minTubes = Number(minStockRes.rows[0]?.min_tubes ?? 0);
      assertOk(minTubes >= 0, "Smoke test observed negative caulk stock.");

      console.log(
        JSON.stringify(
          {
            smoke: "caulk_job_allocation_workflow",
            org_id: orgId,
            actor_user_id: actorUserId,
            actor_role: actorRole,
            warehouse,
            job_number: jobNumber,
            status: "PASS",
          },
          null,
          2,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[step: ${step}] ${message}`);
    } finally {
      await client.query("rollback");
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
