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
  '0146_caulk_requirement_actual_usage_state.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260521160000_caulk_requirement_actual_usage_state.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('caulk requirement actual usage migration is mirrored and schema-guarded', async () => {
  const [backendMigration, supabaseMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);

  assert.match(schemaCheck, /0194_scoped_job_summary_reads\.sql/);

  assert.match(schemaCheck, /app\.job_caulk_requirements\.actual_used_tubes/);
  assert.match(schemaCheck, /app_api\.record_caulk_requirement_actual_usage_for_checkin/);
});

test('caulk requirements get Active Complete state and preserve actual usage on edits', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /add column if not exists status text not null default 'ACTIVE'/);
  assert.match(migration, /add column if not exists actual_used_tubes integer not null default 0/);
  assert.match(migration, /job_caulk_requirements_status_check/);
  assert.match(
    migration,
    /greatest\(coalesce\(v_existing\.actual_used_tubes, 0\), coalesce\(v_requirement\.actual_used_tubes, 0\)\)/
  );
  assert.match(migration, /app_api\.normalize_requirement_status/);
});

test('caulk check-in records requirement usage and resolves consumed allocations', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const usageIndex = migration.indexOf('app_api.record_caulk_requirement_actual_usage_for_checkin');
  const resolveIndex = migration.indexOf('Resolved after caulk checkout check-in usage was recorded.');
  const plannerIndex = migration.indexOf('v_planner_result := app_api.reconcile_auto_planned_allocations');

  assert.ok(usageIndex >= 0, 'expected caulk actual usage recording');
  assert.ok(resolveIndex > usageIndex, 'expected allocation resolution after usage recording');
  assert.ok(plannerIndex > resolveIndex, 'expected planner reconciliation after allocation resolution');
  assert.match(migration, /'caulkAllocationStatus'/);
  assert.match(migration, /'requirementUsage'/);
});

test('caulk legacy usage mapping only links unambiguous requirement matches', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /v_distinct_job_count <> 1/);
  assert.match(migration, /job number %s maps to %s jobs/);
  assert.doesNotMatch(migration, /job_number %s maps to %s jobs/);
  assert.match(migration, /v_match_count <> 1/);
  assert.match(migration, /set requirement_id = v_requirement_id/);
  assert.match(migration, /caulk_checkin_backfill_candidates/);
  assert.match(migration, /b\.requirement_id is null/);
  assert.match(migration, /m\.requirement_match_count = 1/);
});

test('caulk Complete rows are excluded from material demand and can be toggled through shared RPC', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /v_material_type not in \('FILM', 'CAULK'\)/);
  assert.match(migration, /from app\.job_caulk_requirements r/);
  assert.match(migration, /'actualUsedTubes'/);
  assert.match(migration, /coalesce\(r\.status, 'ACTIVE'\) = 'ACTIVE'/);
});
