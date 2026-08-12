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
  '0140_box_checkin_physical_lf_reconciliation_priority.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260520040000_box_checkin_physical_lf_reconciliation_priority.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('physical LF reconciliation priority migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('physical LF reconciliation removes the check-in active allocation lower-bound guard', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /v_reconciliation_result := app_api\.reconcile_box_checkin_allocations/);
  assert.match(migration, /physical LF reconciliation patch left unsafe semantics/);
  assert.doesNotMatch(
    extractReplacementNewBlock(migration),
    /Received physical LF cannot be lower than the box''s active allocated feet/
  );
});

test('physical LF reconciliation preserves scheduled and older job priority before cancelling shortages', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const reconciliationFunction = extractFunctionBody(migration, 'app_api.reconcile_box_checkin_allocations');

  assert.match(reconciliationFunction, /left join lateral \(/);
  assert.match(reconciliationFunction, /case when a\.job_date is not null then 0 else 1 end/);
  assert.match(reconciliationFunction, /a\.job_date asc nulls last/);
  assert.match(reconciliationFunction, /coalesce\(j\.created_at, a\.created_at\) asc/);
  assert.match(reconciliationFunction, /coalesce\(j\.id::text, a\.job_id::text, ''\) asc/);
  assert.match(reconciliationFunction, /a\.created_at asc,\s+a\.allocation_id asc/);
  assert.match(reconciliationFunction, /for update of a/);
});

test('latest schema check requires physical LF reconciliation priority semantics', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');



  assert.match(schemaCheck, /v_reconciliation_result := app_api\.reconcile_box_checkin_allocations/);
  assert.match(schemaCheck, /case when a\.job_date is not null then 0 else 1 end/);
  assert.match(schemaCheck, /coalesce\(j\.created_at, a\.created_at\) asc/);
  assert.match(schemaCheck, /coalesce\(j\.id::text, a\.job_id::text, ''\) asc/);
  assert.match(schemaCheck, /Received physical LF cannot be lower than the box''s active allocated feet/);
});

function extractFunctionBody(migration, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = migration.match(new RegExp(`create or replace function ${escapedName}[\\s\\S]*?\\n\\$\\$;`));
  assert.ok(match, `Expected migration to define ${functionName}`);
  return match[0];
}

function extractReplacementNewBlock(migration) {
  const match = migration.match(/\$new\$([\s\S]*?)\$new\$/);
  assert.ok(match, 'Expected migration to include replacement new block');
  return match[1];
}
