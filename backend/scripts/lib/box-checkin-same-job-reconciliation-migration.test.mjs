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
  '0141_box_checkin_reconcile_same_job_allocations.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260520050000_box_checkin_reconcile_same_job_allocations.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('same-job check-in reconciliation migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('same-job check-in reconciliation migration removes pre-reconciliation planning release', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const replacementNewBlock = extractReplacementNewBlock(migration);

  assert.match(migration, /same-job active allocations before check-in reconciliation/);
  assert.match(migration, /v_reconciliation_result := app_api\.reconcile_box_checkin_allocations/);
  assert.doesNotMatch(
    replacementNewBlock,
    /Released %s active planning allocation%s totaling %s LF for job %s during check-in\./
  );
});

test('latest schema check requires same-job check-in reconciliation semantics', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');


  assert.match(schemaCheck, /0162_prevent_box_id_alias_collisions\.sql/);

  assert.match(schemaCheck, /v_reconciliation_result := app_api\.reconcile_box_checkin_allocations/);
  assert.match(
    schemaCheck,
    /Consumed during film box check-in after actual LF was recorded\./
  );
});

function extractReplacementNewBlock(migration) {
  const match = migration.match(/\$new\$([\s\S]*?)\$new\$/);
  assert.ok(match, 'Expected migration to include replacement new block');
  return match[1];
}
