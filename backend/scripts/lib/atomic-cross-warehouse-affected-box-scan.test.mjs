import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0192_atomic_cross_warehouse_affected_box_scan.sql',
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260721101000_atomic_cross_warehouse_affected_box_scan.sql',
);
const backend0191Path = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0191_atomic_cross_warehouse_transfer_assisted_allocation.sql',
);
const supabase0191Path = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260721100000_atomic_cross_warehouse_transfer_assisted_allocation.sql',
);
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const accepted0191Hash = '723177cd488d3110aa29d5246a6b961540e77557a5403cd20046ace7541dd8a0';

function sha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

function stripDollarQuotedBlocks(sql) {
  return sql.replace(/\$\$[\s\S]*?\$\$/g, '$$BLOCK$$');
}

function publicApplyDefinition(sql) {
  return (
    sql.match(
      /create or replace function public\.api_allocations_apply\([\s\S]*?\n\$\$;\n\nalter function app_api\.allocation_apply_box_states_0192/,
    )?.[0] || ''
  );
}

test('0192 is mirrored exactly and migration 0191 remains immutable', async () => {
  const [backend0192, supabase0192, backend0191, supabase0191] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(backend0191Path, 'utf8'),
    readFile(supabase0191Path, 'utf8'),
  ]);

  assert.equal(supabase0192, backend0192);
  assert.equal(sha256(backend0191), accepted0191Hash);
  assert.equal(sha256(supabase0191), accepted0191Hash);
});

test('0192 is forward-only function DDL with no index, backfill, or timeout change', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const topLevelSql = stripDollarQuotedBlocks(migration);

  assert.doesNotMatch(topLevelSql, /^\s*(?:insert\s+into|update|delete\s+from|truncate)\s+app\./im);
  assert.doesNotMatch(migration, /\bcreate\s+(?:unique\s+)?index\b/i);
  assert.doesNotMatch(migration, /\balter\s+table\b/i);
  assert.doesNotMatch(migration, /\b(?:statement|lock)_timeout\b/i);
  assert.doesNotMatch(migration, /0191_atomic_cross_warehouse_transfer_assisted_allocation\.sql/i);
});

test('0192 builds one canonical plan and executes that exact ordered operation list', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const applyDefinition = publicApplyDefinition(migration);
  const plannerCalls = applyDefinition.match(/app_api\.build_allocation_apply_plan_0192\(/g) || [];

  assert.equal(plannerCalls.length, 1);
  assert.match(applyDefinition, /v_operations := coalesce\(v_plan->'operations', '\[\]'::jsonb\)/);
  assert.match(applyDefinition, /select coalesce\(array_agg\(value order by ordinality\)/);
  assert.match(applyDefinition, /with recursive transfer_edges as materialized/);
  assert.match(applyDefinition, /if v_pre_states is distinct from v_locked_states then/);
  assert.match(applyDefinition, /group by operation\.value->>'boxId'\s+order by operation\.value->>'boxId'/s);
  assert.match(applyDefinition, /from jsonb_array_elements\(v_operations\) with ordinality[\s\S]*?order by ordinality/);
  assert.match(applyDefinition, /v_allocation_ids := array_append\(v_allocation_ids, v_allocation\.allocation_id\)/);
  assert.doesNotMatch(applyDefinition, /api_allocations_apply_pre_0191/);
  assert.doesNotMatch(applyDefinition, /for v_pre_box in/);
});

test('0192 batches only requested affected-box state and fails closed after locking', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /from unnest\(coalesce\(p_box_ids, array\[\]::text\[\]\)\) entry/);
  assert.match(migration, /join app\.boxes b\s+on b\.org_id = p_org_id\s+and b\.box_id = r\.box_id/s);
  assert.match(migration, /left join app\.allocations a\s+on a\.org_id = p_org_id\s+and a\.box_id = b\.box_id/s);
  assert.match(migration, /left join app\.box_transfers t/);
  assert.match(migration, /allocation_state jsonb/);
  assert.match(migration, /pending_transfer_state jsonb/);
  assert.match(migration, /An affected allocation identity could not be resolved/);
  assert.match(migration, /An affected allocation box could not be locked/);
  assert.match(migration, /Allocation state changed before apply/);
  assert.match(migration, /for update of t/);
});

test('0192 preserves live same-warehouse planning, phase, extras, and response semantics', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /v_auto_allocate boolean := coalesce\(\(v_payload->>'autoAllocate'\)::boolean, false\)/);
  assert.match(migration, /v_auto_allocate\s+or b\.box_id = any\(v_selected_box_ids\)/s);
  assert.match(migration, /Requirement %s is complete\. Reactivate it before allocating film\./);
  assert.match(migration, /JobDate must match the selected requirement phase\./);
  assert.match(migration, /CrewLeader must match the selected requirement phase\./);
  assert.match(migration, /order by array_position\(v_candidate_box_ids, s\.box_id\)/);
  assert.match(migration, /'role', 'SOURCE'/);
  assert.match(migration, /'role', 'SUGGESTION'/);
  assert.match(migration, /'role', 'EXTRA'/);
  assert.match(migration, /'filmOrderId', ''::text/);
  assert.match(migration, /'warnings', coalesce\(v_plan->'warnings', '\[\]'::jsonb\)/);
  assert.match(migration, /'transferIds', to_jsonb\(v_transfer_ids\)/);
});

test('0192 preserves the canonical public contract and private helper grants', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  const legacyGrantNormalization =
    'revoke execute on function public.api_allocations_apply(uuid, text, jsonb)\n' +
    '  from service_role;';
  const preconditionStart = migration.indexOf('do $$');

  assert.notEqual(preconditionStart, -1);
  assert.ok(migration.indexOf(legacyGrantNormalization) < preconditionStart);
  assert.equal(
    migration.match(
      /revoke execute on function public\.api_allocations_apply\(uuid, text, jsonb\)\s+from service_role;/g,
    )?.length,
    1,
  );
  assert.doesNotMatch(migration, /grant execute on function public\.api_allocations_apply/i);
  assert.match(migration, /create or replace function public\.api_allocations_apply\(\s*p_org_id uuid,\s*p_actor text,\s*p_payload jsonb\s*\)/s);
  assert.match(migration, /language plpgsql\s+security definer\s+set search_path = public, app, app_api/s);
  assert.match(migration, /alter function public\.api_allocations_apply\(uuid, text, jsonb\) owner to postgres/);
  assert.match(migration, /revoke execute on function public\.api_allocations_apply\(uuid, text, jsonb\)\s+from public, anon, authenticated, service_role/s);
  assert.match(migration, /v_apply_count <> 1/);
  assert.match(migration, /v_apply_owner <> 'postgres'/);
  assert.match(migration, /search_path=public, app, app_api/);
  assert.match(migration, /acl\.grantee = 0 or r\.rolname in \('anon', 'authenticated', 'service_role'\)/);
});

test('schema latest retains the 0192 bounded allocator contract after 0193', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');

  assert.match(schemaLatest, /app_api\.allocation_apply_box_states_0192\(uuid, text\[\]\)/);
  assert.match(schemaLatest, /app_api\.build_allocation_apply_plan_0192\(uuid, text, jsonb\)/);
  assert.match(schemaLatest, /v_plan := app_api\.build_allocation_apply_plan_0192/);
  assert.match(schemaLatest, /if v_pre_states is distinct from v_locked_states then/);
});
