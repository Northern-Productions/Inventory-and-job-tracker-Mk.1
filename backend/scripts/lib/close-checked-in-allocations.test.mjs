import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0148_close_checked_in_allocations.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260522090000_close_checked_in_allocations.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('checked-in allocation close migration is mirrored and schema-guarded', async () => {
  const [backendMigration, supabaseMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);

  assert.match(schemaCheck, /0187_caulk_owner_transfer_id_uppercase\.sql/);

  assert.match(schemaCheck, /a\.job_id is null/);
  assert.match(schemaCheck, /JOB_ALLOCATION_CANCEL_RETURN/);
  assert.match(schemaCheck, /reserved_tubes_remaining = 0/);
});

test('film check-in release keeps jobId safety while closing deterministic legacy rows', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.cancel_active_allocations_for_box_job/);
  assert.match(migration, /p_job_id is not null[\s\S]*a\.job_id = p_job_id/);
  assert.match(migration, /a\.job_id is null[\s\S]*upper\(coalesce\(a\.job_number, ''\)\) = upper\(app_api\.trim_text\(p_job_number\)\)/);
  assert.match(migration, /Consumed during film box check-in after actual LF was recorded\./);
});

test('caulk check-in resolves closed cycles even when reserved tubes remain', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const usageIndex = migration.indexOf('app_api.record_caulk_requirement_actual_usage_for_checkin');
  const releaseIndex = migration.indexOf('JOB_ALLOCATION_CANCEL_RETURN', usageIndex);
  const closeIndex = migration.indexOf("status = 'CANCELLED'", releaseIndex);

  assert.ok(usageIndex >= 0, 'expected caulk actual usage recording');
  assert.ok(releaseIndex > usageIndex, 'expected unused reserved tubes released after usage recording');
  assert.ok(closeIndex > releaseIndex, 'expected allocation close after reserved tube release');
  assert.match(migration, /if v_open_checkout_count = 0 then/);
  assert.match(migration, /reserved_tubes_remaining = 0/);
});

test('historical cleanup is deterministic and does not guess requirement usage', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /checked_in_film_allocation_close_candidates/);
  assert.doesNotMatch(migration, /checked_in_film_allocation_close_candidates on commit drop/);
  assert.match(migration, /l\.job_id is not null/);
  assert.match(migration, /r\.job_id = l\.job_id/);
  assert.match(migration, /checked_in_caulk_allocation_close_candidates/);
  assert.doesNotMatch(migration, /checked_in_caulk_allocation_close_candidates on commit drop/);
  assert.match(migration, /open_checkout_count = 0/);
  assert.match(migration, /coalesce\(a\.checked_out_tubes_total, 0\) =\s+coalesce\(a\.returned_unused_tubes_total, 0\) \+ coalesce\(a\.used_tubes_total, 0\)/);
  assert.doesNotMatch(migration, /update app\.job_requirements\s+set actual_used_feet/i);
  assert.doesNotMatch(migration, /update app\.job_caulk_requirements\s+set actual_used_tubes/i);
});
