import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0123_allocation_apply_jobid_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260513160000_allocation_apply_jobid_scope.sql'
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

test('allocation apply jobId scope migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('api_allocations_apply canonical path validates exact job identity before allocation writes', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_allocations_apply');

  assert.match(body, /v_job_id_text text := app_api\.trim_text\(p_payload->>'jobId'\);/);
  assert.match(body, /v_has_job_id boolean := v_job_id_text <> '';/);
  assert.match(body, /jobId must be a valid UUID\./);
  assert.match(body, /where j\.org_id = p_org_id\s+and j\.id = v_job_id\s+for update;/s);
  assert.match(body, /Job was not found\./);
  assert.match(body, /upper\(trim\(v_job\.job_number\)\) <> upper\(trim\(v_job_number\)\)/);
  assert.match(body, /Job identity mismatch: selected job does not match jobNumber\./);
  assert.ok(
    body.indexOf('Job identity mismatch: selected job does not match jobNumber.') <
      body.indexOf('app_api.create_or_merge_manual_requirement_allocation_with_coverage('),
    'Expected jobId/jobNumber mismatch to be rejected before allocation creation.'
  );
  assert.match(body, /v_job_context := jsonb_build_object\(\s+'jobId', v_job\.id::text,\s+'jobNumber', v_job\.job_number/s);
  assert.match(body, /Job %s is closed and cannot receive allocations\./);
});

test('canonical allocation apply validates requirements and conflicts by selected job_id', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_allocations_apply');

  assert.match(body, /and r\.job_id = v_job_id\s+and r\.id = v_requirement_id;/);
  assert.match(body, /when v_has_job_id then a\.job_id is distinct from v_job\.id/);
  assert.match(body, /app_api\.create_or_merge_manual_requirement_allocation_with_coverage\(/);
  assert.match(body, /app_api\.create_allocation\(/);
  assert.doesNotMatch(body, /and r\.job_id = app_api\.get_or_resolve_job_id/);
});

test('allocation creation helpers honor explicit jobId without changing legacy fallback', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const createBody = extractBody(migration, 'app_api.create_allocation');
  const coverageBody = extractBody(migration, 'app_api.create_allocation_with_coverage');
  const mergeBody = extractBody(migration, 'app_api.create_or_merge_manual_requirement_allocation_with_coverage');

  for (const body of [createBody, coverageBody, mergeBody]) {
    assert.match(body, /v_job_id_text text := app_api\.trim_text\(p_job_context->>'jobId'\);/);
    assert.match(body, /v_job_id := v_job_id_text::uuid;/);
    assert.match(body, /v_job_id := app_api\.get_or_resolve_job_id\(p_org_id, p_job_context->>'jobNumber'\);/);
  }

  assert.match(createBody, /v_allocation\.job_id := v_job_id;/);
  assert.match(coverageBody, /v_allocation\.job_id := v_job_id;/);
  assert.match(mergeBody, /when v_has_job_id then a\.job_id = v_job_id/);
  assert.match(mergeBody, /v_primary\.job_id := v_job_id;/);
});

test('api_acl_allocations_apply reconciles canonical scope with jobIds and preserves legacy scope', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_acl_allocations_apply');

  assert.match(body, /v_job_id_text text := app_api\.trim_text\(p_payload->>'jobId'\);/);
  assert.match(body, /jobId must be a valid UUID\./);
  assert.match(body, /where j\.org_id = p_org_id\s+and j\.id = v_job_id\s+limit 1;/s);
  assert.match(body, /Job identity mismatch: selected job does not match jobNumber\./);
  assert.ok(
    body.indexOf('Job identity mismatch: selected job does not match jobNumber.') <
      body.indexOf('v_result := public.api_allocations_apply'),
    'Expected ACL wrapper to reject mismatches before mutation RPC execution.'
  );
  assert.match(
    body,
    /'jobIds',\s+jsonb_build_array\(v_job\.id\),\s+'jobNumbers',\s+jsonb_build_array\(v_job\.job_number\),\s+'boxIds'/s
  );
  assert.match(body, /case when v_job_number = '' then '\[\]'::jsonb else jsonb_build_array\(v_job_number\) end/);
  assert.match(body, /perform app_api\.recalculate_physical_box_allocatable_now\(p_org_id, v_box_id\);/);
});

test('allocation apply jobId scope migration does not alter deferred workflows or duplicate guards', async () => {
  const [migration, baseSchemaMigration, duplicateGuardMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(baseSchemaMigrationPath, 'utf8'),
    readFile(duplicateGuardMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

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

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0188_member_permission_mirror_remediation\.sql';/);

  assert.match(schemaCheck, /'jobIds',/);
  assert.match(schemaCheck, /jsonb_build_array\(v_job\.id\)/);
});
