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
  '0111_receive_ordered_core_type.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260508120000_receive_ordered_core_type.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('ordered receive core type migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('ordered receive core type migration patches the existing receive RPC narrowly', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(
    migration,
    /pg_get_functiondef\('public\.api_acl_boxes_receive_ordered\(uuid, text, jsonb\)'::regprocedure\)/
  );
  assert.match(migration, /v_core_type := app_api\.normalize_core_type\(v_payload->>'coreType', true\);/);
  assert.match(migration, /v_box\.core_type := v_core_type;/);
  assert.match(
    migration,
    /v_box\.core_weight_lbs := app_api\.derive_core_weight_lbs\(v_core_type, v_box\.width_in\);/
  );
  assert.match(
    migration,
    /v_locked_allocated_feet := app_api\.physical_film_commitment_feet_for_box\(p_org_id, v_lookup_box_id\);/
  );
  assert.doesNotMatch(migration, /add\s+column\s+core_type/i);
});

test('latest schema check tracks ordered receive core type semantics', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');

  assert.match(schemaCheck, /0132_complete_job_jobid_scope\.sql/);
  assert.match(schemaCheck, /v_core_type := app_api\.normalize_core_type\(v_payload->>'coreType', true\);/);
  assert.match(
    schemaCheck,
    /v_box\.core_weight_lbs := app_api\.derive_core_weight_lbs\(v_core_type, v_box\.width_in\);/
  );
});
