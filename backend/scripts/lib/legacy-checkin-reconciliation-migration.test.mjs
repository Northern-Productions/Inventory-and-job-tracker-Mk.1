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
  '0145_legacy_checkin_requirement_reconciliation.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260521150000_legacy_checkin_requirement_reconciliation.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('legacy check-in reconciliation migration is mirrored and schema-guarded', async () => {
  const [backendMigration, supabaseMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
  assert.match(schemaCheck, /0151_user_default_warehouse_preferences\.sql/);
  assert.match(schemaCheck, /legacy_match\.requirement_match_count = 1/);
  assert.match(schemaCheck, /Consumed during film box check-in after actual LF was recorded\./);
});

test('legacy check-in usage mapping only uses unambiguous requirement matches', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /a\.requirement_id is null/);
  assert.match(migration, /box_match\.box_match_count = 1/);
  assert.match(migration, /legacy_match\.requirement_match_count = 1/);
  assert.match(migration, /app_api\.normalize_requirement_film_key/);
  assert.match(migration, /p_job_id is null and v_distinct_job_count > 1/);
});

test('check-in releases same-job allocations only after actual usage recording', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const usageIndex = migration.indexOf('app_api.record_requirement_actual_usage_for_checkin');
  const releaseIndex = migration.indexOf('Consumed during film box check-in after actual LF was recorded.');
  const reconcileIndex = migration.indexOf('v_reconciliation_result := app_api.reconcile_box_checkin_allocations');

  assert.ok(usageIndex >= 0, 'expected actual usage recording call');
  assert.ok(releaseIndex > usageIndex, 'expected same-job release after actual usage recording');
  assert.ok(reconcileIndex > releaseIndex, 'expected capacity reconciliation after same-job release');
});

test('deterministic historical repair avoids ambiguous roll-history backfill', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /allocation_match_count = 1/);
  assert.match(migration, /current_actual_used_feet = 0/);
  assert.match(migration, /status = 'CANCELLED'/);
  assert.match(migration, /legacy-checkin-reconciliation-0145/);
});
