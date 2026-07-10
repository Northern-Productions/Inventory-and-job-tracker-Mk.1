import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0120_remove_box_jobid_planner_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260513130000_remove_box_jobid_planner_scope.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const baseSchemaMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0001_supabase_inventory_schema.sql');
const duplicateGuardMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0117_duplicate_job_creation_guard.sql');

function extractRemoveBoxBody(sql) {
  const match = sql.match(
    /create or replace function public\.api_allocations_remove_box[\s\S]*?as \$\$\r?\n(?<body>[\s\S]*?)\r?\n\$\$;/
  );
  assert.ok(match?.groups?.body, 'Expected public.api_allocations_remove_box body.');
  return match.groups.body;
}

test('remove-box jobId planner scope migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('remove-box canonical jobId path selects exact job and rejects mismatched identity', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractRemoveBoxBody(migration);

  assert.match(migration, /create or replace function public\.api_allocations_remove_box/);
  assert.match(body, /v_job_id_text text := app_api\.trim_text\(v_payload->>'jobId'\);/);
  assert.match(body, /v_has_valid_job_id boolean := v_job_id_text ~\*/);
  assert.match(body, /if v_has_valid_job_id then\s+v_job_id := v_job_id_text::uuid;/s);
  assert.match(body, /where j\.org_id = p_org_id\s+and j\.id = v_job_id\s+for update;/s);
  assert.match(body, /upper\(trim\(v_job\.job_number\)\) <> upper\(trim\(v_job_number\)\)/);
  assert.match(body, /Job identity mismatch: selected job does not match jobNumber\./);
});

test('remove-box canonical allocation ownership uses allocation job_id before mutation', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractRemoveBoxBody(migration);

  assert.match(
    body,
    /if v_has_valid_job_id then\s+select \*\s+into v_allocation\s+from app\.allocations a\s+where a\.org_id = p_org_id\s+and a\.allocation_id = v_allocation_id\s+for update;/s
  );
  assert.match(body, /if v_allocation\.job_id is distinct from v_job\.id then/);
  assert.match(body, /Allocation %s belongs to a different job\./);
  assert.ok(
    body.indexOf('if v_allocation.job_id is distinct from v_job.id then') <
      body.indexOf('update app.allocations'),
    'Expected allocation ownership mismatch to be rejected before mutation.'
  );
});

test('remove-box planner scope includes jobIds only for canonical jobId payloads', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractRemoveBoxBody(migration);

  assert.match(body, /perform app_api\.reconcile_auto_planned_allocations\(/);
  assert.match(
    body,
    /when v_has_valid_job_id then jsonb_build_object\(\s+'jobIds', jsonb_build_array\(v_job\.id\),\s+'jobNumbers', jsonb_build_array\(v_job\.job_number\),\s+'boxIds', jsonb_build_array\(v_box\.box_id\)\s+\)/s
  );
  assert.match(
    body,
    /else jsonb_build_object\(\s+'jobNumbers', jsonb_build_array\(v_job\.job_number\),\s+'boxIds', jsonb_build_array\(v_box\.box_id\)\s+\)/s
  );
  assert.doesNotMatch(body, /auto_planner_scope_job_numbers\(/);
});

test('remove-box legacy jobNumber path and public response shape are preserved', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractRemoveBoxBody(migration);

  assert.match(
    body,
    /else\s+select \*\s+into v_job\s+from app\.jobs j\s+where j\.org_id = p_org_id\s+and upper\(trim\(j\.job_number\)\) = upper\(trim\(v_job_number\)\)\s+for update;/s
  );
  assert.match(
    body,
    /a\.job_id = v_job\.id\s+or upper\(trim\(coalesce\(a\.job_number, ''\)\)\) = upper\(trim\(v_job\.job_number\)\)/s
  );
  assert.match(body, /'jobNumber', v_job\.job_number/);
  assert.match(body, /'allocationId', v_removed\.allocation_id/);
  assert.match(body, /'boxId', v_removed\.box_id/);
  assert.match(body, /'removedAllocationCount', 1/);
  assert.match(body, /'releasedFeet', v_released_feet/);
});

test('remove-box jobId planner migration does not alter deferred workflows or duplicate guards', async () => {
  const [migration, baseSchemaMigration, duplicateGuardMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(baseSchemaMigrationPath, 'utf8'),
    readFile(duplicateGuardMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.doesNotMatch(migration, /api_allocations_apply/);
  assert.doesNotMatch(migration, /api_film_orders_create/);
  assert.doesNotMatch(migration, /api_film_orders_cancel/);
  assert.doesNotMatch(migration, /api_jobs_create/);
  assert.doesNotMatch(migration, /api_jobs_check_duplicate/);
  assert.doesNotMatch(migration, /alter table app\.jobs/i);
  assert.doesNotMatch(migration, /drop constraint/i);
  assert.match(baseSchemaMigration, /unique\s*\(\s*org_id\s*,\s*job_number\s*\)/i);
  assert.match(duplicateGuardMigration, /Job %s already exists/);

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0187_caulk_owner_transfer_id_uppercase\.sql';/);

  assert.match(schemaCheck, /'jobIds', jsonb_build_array\(v_job\.id\)/);
});
