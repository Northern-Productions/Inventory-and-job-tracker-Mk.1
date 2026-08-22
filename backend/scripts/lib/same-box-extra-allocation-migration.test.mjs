import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0201_same_box_extra_allocation.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260814150000_same_box_extra_allocation.sql'
);
const backendCapacityMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0202_extra_allocation_capacity.sql'
);
const supabaseCapacityMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260814210000_extra_allocation_capacity.sql'
);
const migration0192Path = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0192_atomic_cross_warehouse_affected_box_scan.sql'
);
const dialogPath = path.join(
  repoRoot,
  'frontend',
  'src',
  'features',
  'inventory',
  'components',
  'JobAllocateDialog.tsx'
);
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const filmParityVerifierPath = path.join(
  repoRoot,
  'backend',
  'scripts',
  'verify-allocation-film-match-parity.mjs'
);

function stripDollarQuotedBlocks(sql) {
  return sql.replace(/\$\$[\s\S]*?\$\$/g, '$$BLOCK$$');
}

test('migration 0201 remains byte-identical across backend and Supabase mirrors', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('migration 0202 remains byte-identical across backend and Supabase mirrors', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendCapacityMigrationPath, 'utf8'),
    readFile(supabaseCapacityMigrationPath, 'utf8')
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('migration 0202 is function-only and makes EXTRA a physical capacity claim', async () => {
  const migration = await readFile(backendCapacityMigrationPath, 'utf8');
  const topLevelSql = stripDollarQuotedBlocks(migration);

  assert.doesNotMatch(topLevelSql, /^\s*(?:insert\s+into|update|delete\s+from|truncate)\s+app\./im);
  assert.doesNotMatch(migration, /\bcreate\s+(?:unique\s+)?index\b/i);
  assert.doesNotMatch(migration, /\balter\s+table\b/i);
  assert.match(migration, /create or replace function app_api\.film_allocation_reserves_capacity/);
  assert.match(migration, /allocation_kind::text, 'REQUIREMENT'\) = 'EXTRA'/);
  assert.match(migration, /allocation_kind::text, 'REQUIREMENT'\) = 'REQUIREMENT'/);
  assert.match(migration, /\(p_allocation\)\.requirement_id is not null/);
  assert.match(migration, /\(p_allocation\)\.job_id is not null/);
  assert.match(migration, /\(p_allocation\)\.status = 'FULFILLED'/);
  assert.match(migration, /upper\(coalesce\(p_box_status, ''\)\) = 'CHECKED_OUT'/);
});

test('migration 0201 is function-only and preserves the 0192 duplicate guard', async () => {
  const [migration, migration0192] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(migration0192Path, 'utf8')
  ]);
  const topLevelSql = stripDollarQuotedBlocks(migration);

  assert.doesNotMatch(topLevelSql, /^\s*(?:insert\s+into|update|delete\s+from|truncate)\s+app\./im);
  assert.doesNotMatch(migration, /\bcreate\s+(?:unique\s+)?index\b/i);
  assert.doesNotMatch(migration, /\balter\s+table\b/i);
  assert.match(
    migration0192,
    /The same box cannot be selected more than once in one allocation apply request\./
  );
  assert.ok(
    migration.includes(
      String.raw`regexp_matches(v_apply_def, 'app_api\.build_allocation_apply_plan_0192\(', 'g')`
    )
  );
  assert.ok(
    !migration.includes(
      String.raw`regexp_matches(v_apply_def, 'app_api\\.build_allocation_apply_plan_0192\\(', 'g')`
    )
  );
  assert.doesNotMatch(migration, /drop\s+function\s+app_api\.build_allocation_apply_plan_0192/i);
});

test('0201 delegates unchanged requirement requests and rewrites one exact primary extra operation', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /if v_allocation_kind = 'REQUIREMENT' then\s+return app_api\.build_allocation_apply_plan_0192/s);
  assert.match(migration, /if v_allocation_kind <> 'EXTRA' then/);
  assert.match(migration, /v_primary_requested_covered_feet := v_primary_extra_feet \* v_coverage_multiplier/);
  assert.match(migration, /v_payload - 'allocationKind'/);
  assert.match(migration, /coalesce\(v_operation->>'role', ''\) = 'SOURCE'/);
  assert.match(migration, /v_primary_operation_count := v_primary_operation_count \+ 1/);
  assert.match(migration, /'role', 'PRIMARY_EXTRA'/);
  assert.match(migration, /'kind', 'EXTRA'/);
  assert.match(migration, /'coveredFeet', v_primary_extra_feet/);
  assert.match(migration, /'priorBoxIds', '\[\]'::jsonb/);
  assert.match(migration, /v_primary_operation_count <> 1/);
  assert.match(migration, /remainingUncoveredFeet/);
});

test('0201 fails closed on invalid kind, width, capacity, and cross-warehouse extra handling', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /AllocationKind must be REQUIREMENT or EXTRA/);
  assert.match(migration, /Primary EXTRA allocation must be greater than zero/);
  assert.match(migration, /The primary EXTRA box must meet the selected requirement width/);
  assert.match(migration, /The primary EXTRA box no longer has enough allocatable LF/);
  assert.match(migration, /Cross-warehouse extra film must be transferred and received before it can be allocated/);
  assert.match(migration, /Pending-transfer boxes cannot receive additional allocations/);
});

test('the public apply worker executes only the 0201 plan and keeps operation-level capacity checks', async () => {
  const [migration, migration0192] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(migration0192Path, 'utf8')
  ]);
  const applyDefinition = migration.match(
    /create or replace function public\.api_allocations_apply\([\s\S]*?\n\$\$;/
  )?.[0] || '';
  const apply0192Definition = migration0192.match(
    /create or replace function public\.api_allocations_apply\([\s\S]*?\n\$\$;/
  )?.[0] || '';
  const expectedDefinition = apply0192Definition.replace(
    'v_plan := app_api.build_allocation_apply_plan_0192(p_org_id, p_actor, v_payload);',
    'v_plan := app_api.build_allocation_apply_plan_0201(p_org_id, p_actor, v_payload);'
  );

  assert.equal(applyDefinition.replace(/\r\n/g, '\n'), expectedDefinition.replace(/\r\n/g, '\n'));
  assert.equal(
    (applyDefinition.match(/app_api\.build_allocation_apply_plan_0201\(/g) || []).length,
    1
  );
  assert.doesNotMatch(applyDefinition, /build_allocation_apply_plan_0192\(p_org_id, p_actor, v_payload\)/);
  assert.match(applyDefinition, /sum\(\(operation\.value->>'allocatedFeet'\)::integer\)/);
  assert.match(applyDefinition, /Allocation capacity changed before apply/);
  assert.match(applyDefinition, /coalesce\(v_operation->>'kind', 'REQUIREMENT'\) = 'EXTRA'/);
});

test('the frontend sends the primary extra box exactly once in the allocation contract', async () => {
  const dialog = await readFile(dialogPath, 'utf8');

  assert.match(dialog, /primaryExtraAllocation/);
  assert.match(dialog, /requestedFeet: isExtraFilmMode \? primaryExtraAllocation\?\.allocatedFeet \?\? 0/);
  assert.match(dialog, /allocationKind: 'EXTRA'/);
  assert.match(dialog, /filter\(\(\{ boxId \}\) => !isExtraFilmMode \|\| boxId !== sourceBox\.boxId\)/);
});

test('0201 keeps the private planner and worker ACLs narrow and the schema guard advances through 0203', async () => {
  const [migration, schemaLatest] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(schemaLatestPath, 'utf8')
  ]);

  assert.match(
    migration,
    /revoke execute on function app_api\.build_allocation_apply_plan_0201\(uuid, text, jsonb\)\s+from public, anon, authenticated, service_role/s
  );
  assert.match(
    migration,
    /revoke execute on function public\.api_allocations_apply\(uuid, text, jsonb\)\s+from public, anon, authenticated, service_role/s
  );
  assert.match(schemaLatest, /const LATEST_MIGRATION = '0203_restore_default_warehouse_auth_context\.sql'/);
  assert.match(schemaLatest, /app_api\.build_allocation_apply_plan_0201\(uuid, text, jsonb\)/);
  assert.match(schemaLatest, /v_plan := app_api\.build_allocation_apply_plan_0201/);
  assert.match(schemaLatest, /app_api\.film_allocation_reserves_capacity\(app\.allocations, text\)/);
  assert.match(schemaLatest, /allocation_kind::text, 'REQUIREMENT'\) = 'EXTRA'/);
});

test('film-match parity follows the canonical planner chain without weakening compatibility checks', async () => {
  const verifier = await readFile(filmParityVerifierPath, 'utf8');

  assert.match(verifier, /public\.api_allocations_apply\(uuid, text, jsonb\)/);
  assert.match(verifier, /app_api\.build_allocation_apply_plan_0201\(uuid, text, jsonb\)/);
  assert.match(verifier, /app_api\.build_allocation_apply_plan_0192\(uuid, text, jsonb\)/);
  assert.match(verifier, /canonicalPlanDef\.includes\('app_api\.requirement_film_is_compatible'\)/);
});
