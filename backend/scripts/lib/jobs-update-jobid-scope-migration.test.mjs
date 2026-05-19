import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0122_jobs_update_jobid_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260513150000_jobs_update_jobid_scope.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const baseSchemaMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0001_supabase_inventory_schema.sql');
const duplicateGuardMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0117_duplicate_job_creation_guard.sql');

function extractBody(sql, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sql.match(
    new RegExp(`create or replace function ${escapedName}[\\s\\S]*?as \\$\\$\\r?\\n(?<body>[\\s\\S]*?)\\r?\\n\\$\\$;`)
  );
  assert.ok(match?.groups?.body, `Expected ${functionName} body.`);
  return match.groups.body;
}

test('jobs update jobId scope migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('api_jobs_update canonical jobId path selects exact job and rejects unsafe identity', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_jobs_update');

  assert.match(body, /v_job_id_text text := app_api\.trim_text\(p_payload->>'jobId'\);/);
  assert.match(body, /v_has_job_id boolean := v_job_id_text <> '';/);
  assert.match(body, /jobId must be a valid UUID\./);
  assert.match(body, /where j\.org_id = p_org_id\s+and j\.id = v_job_id\s+for update;/s);
  assert.match(body, /Job was not found\./);
  assert.match(body, /upper\(trim\(v_job\.job_number\)\) <> upper\(trim\(v_job_number\)\)/);
  assert.match(body, /Job identity mismatch: selected job does not match jobNumber\./);
  assert.ok(
    body.indexOf('where j.org_id = p_org_id\n      and j.id = v_job_id') <
      body.indexOf('v_job := app_api.save_job(v_job);'),
    'Expected selected jobId row to be loaded before the update is saved.'
  );
});

test('api_jobs_update preserves legacy jobNumber create/update behavior only when jobId is absent', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_jobs_update');

  assert.match(
    body,
    /else\s+select \*\s+into v_job\s+from app\.jobs j\s+where j\.org_id = p_org_id\s+and j\.job_number = v_job_number\s+for update;\s+if not found then\s+v_job\.id := gen_random_uuid\(\);/s
  );
  assert.ok(
    body.indexOf('else\n    select *\n    into v_job') <
      body.indexOf('v_job.id := gen_random_uuid();'),
    'Expected fallback job creation to remain in the legacy jobNumber-only branch.'
  );
  assert.match(body, /'jobNumber', v_job\.job_number/);
  assert.match(body, /'warnings', '\[\]'::jsonb/);
});

test('canonical schedule sync helper scopes active allocations and open film orders by job_id only', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'app_api.sync_active_job_schedule_allocations_by_job_id');

  assert.match(body, /if p_job_id is null then/);
  assert.match(body, /a\.job_id = p_job_id/);
  assert.match(body, /f\.job_id = p_job_id/);
  assert.match(body, /perform app_api\.save_allocation\(v_allocation\);/);
  assert.match(body, /perform app_api\.save_film_order\(v_order\);/);
  assert.match(body, /perform app_api\.recalculate_physical_box_allocatable_now\(/);
  assert.doesNotMatch(body, /p_job_number/);
  assert.doesNotMatch(body, /upper\(trim\(a\.job_number\)\)/);
  assert.doesNotMatch(body, /upper\(trim\(f\.job_number\)\)/);
});

test('api_acl_jobs_update reconciles canonical updates by jobIds and preserves legacy jobNumber sync', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_acl_jobs_update');

  assert.match(body, /v_job_id_text text := app_api\.trim_text\(p_payload->>'jobId'\);/);
  assert.match(body, /jobId must be a valid UUID\./);
  assert.match(body, /where j\.org_id = p_org_id\s+and j\.id = v_job_id\s+limit 1;/s);
  assert.match(body, /Job identity mismatch: selected job does not match jobNumber\./);
  assert.ok(
    body.indexOf('Job identity mismatch: selected job does not match jobNumber.') <
      body.indexOf('v_result := public.api_jobs_update'),
    'Expected job identity mismatch to be rejected before the update RPC runs.'
  );
  assert.match(body, /perform app_api\.sync_active_job_schedule_allocations_by_job_id\(/);
  assert.match(
    body,
    /v_scope := jsonb_build_object\(\s+'jobIds', jsonb_build_array\(v_updated_job\.id\),\s+'jobNumbers', jsonb_build_array\(v_updated_job\.job_number\)\s+\);/s
  );
  assert.match(body, /perform app_api\.sync_active_job_schedule_allocations\(/);
  assert.match(body, /v_scope := jsonb_build_object\('jobNumbers', jsonb_build_array\(v_job_number\)\);/);
  assert.match(body, /perform app_api\.reconcile_auto_planned_allocations\(/);
  assert.doesNotMatch(body, /auto_planner_scope_job_numbers\(/);
});

test('jobs update jobId scope migration does not alter deferred workflows or duplicate guards', async () => {
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
  assert.doesNotMatch(migration, /api_jobs_set_staged_pickup/);
  assert.doesNotMatch(migration, /api_jobs_complete/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_/);
  assert.doesNotMatch(migration, /alter table app\.jobs/i);
  assert.doesNotMatch(migration, /drop constraint/i);
  assert.match(baseSchemaMigration, /unique\s*\(\s*org_id\s*,\s*job_number\s*\)/i);
  assert.match(duplicateGuardMigration, /Job %s already exists/);
  assert.match(schemaCheck, /const LATEST_MIGRATION = '0136_enable_job_number_work_scope_uniqueness\.sql';/);
  assert.match(schemaCheck, /sync_active_job_schedule_allocations_by_job_id/);
  assert.match(schemaCheck, /'jobIds', jsonb_build_array\(v_updated_job\.id\)/);
});
