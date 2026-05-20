import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0138_preserve_partial_box_update_physical_feet.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260520020000_preserve_partial_box_update_physical_feet.sql'
);
const migrationsPath = path.join(repoRoot, 'backend', 'migrations');
const supabaseMigrationsPath = path.join(repoRoot, 'supabase', 'migrations');
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const edgeMutationHandlersPath = path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'mutationHandlers.ts');
const runtimeCollectionsAndBoxesPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeCollectionsAndBoxes.mjs'
);

test('box update partial receiving parity repair migrations stay mirrored', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('box update partial receiving parity repair is latest in both migration trees', async () => {
  const backendMigrations = (await readdir(migrationsPath)).filter((entry) => /^\d+_/.test(entry)).sort();
  const supabaseMigrations = (await readdir(supabaseMigrationsPath)).filter((entry) => /^\d+_/.test(entry)).sort();

  assert.equal(backendMigrations.at(-3), '0137_repair_box_update_partial_receiving_parity.sql');
  assert.equal(backendMigrations.at(-2), '0138_preserve_partial_box_update_physical_feet.sql');
  assert.equal(backendMigrations.at(-1), '0139_box_status_duplicate_job_checkout_guard.sql');
  assert.equal(supabaseMigrations.at(-3), '20260520010000_repair_box_update_partial_receiving_parity.sql');
  assert.equal(supabaseMigrations.at(-2), '20260520020000_preserve_partial_box_update_physical_feet.sql');
  assert.equal(supabaseMigrations.at(-1), '20260520030000_box_status_duplicate_job_checkout_guard.sql');
});

test('repair migration reasserts existing-box partial receiving metrics without app data updates', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const functionBody = migration.slice(
    migration.indexOf('create or replace function app_api.build_box_from_payload('),
    migration.indexOf('\nDO $$')
  );

  assert.match(migration, /create or replace function app_api\.build_box_from_payload\(/);
  assert.match(functionBody, /v_use_partial_receiving_metrics boolean := false;/);
  assert.match(functionBody, /if not v_has_full_receiving_metrics and p_existing_box_id is not null then/);
  assert.match(functionBody, /v_use_partial_receiving_metrics := true;/);
  assert.match(functionBody, /app_api\.physical_film_commitment_feet_for_box\(/);
  assert.match(functionBody, /coalesce\(v_existing\.feet_available, v_feet_available\)/);
  assert.doesNotMatch(functionBody, /if v_initial_weight_input is null and v_existing\.initial_weight_lbs is null then/);
  assert.doesNotMatch(
    functionBody,
    /v_feet_available := app_api\.clamp_feet_to_initial_range\(v_feet_available, v_initial_feet\);/
  );
  assert.match(migration, /missing existing-box partial receiving metrics branch/);
  assert.match(migration, /stale first-save InitialWeightLbs guard/);
  assert.match(migration, /does not preserve existing physical feet for partial receiving updates/);
  assert.match(migration, /still overwrites partial receiving physical feet from payload feetAvailable/);
  assert.doesNotMatch(migration, /\bupdate\s+app\./i);
  assert.doesNotMatch(migration, /\binsert\s+into\s+app\./i);
  assert.doesNotMatch(migration, /\bdelete\s+from\s+app\./i);
});

test('schema latest guard catches stale box update partial receiving function drift', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');
  const requiredFunctionSemantics = schemaLatest.slice(
    schemaLatest.indexOf('const REQUIRED_FUNCTION_SEMANTICS = ['),
    schemaLatest.indexOf('const AUTHENTICATED_PUBLIC_RPC_ALLOWLIST = [')
  );

  assert.match(schemaLatest, /const LATEST_MIGRATION = '0139_box_status_duplicate_job_checkout_guard\.sql';/);
  assert.match(requiredFunctionSemantics, /signature: 'app_api\.build_box_from_payload\(uuid, jsonb, text\)'/);
  assert.match(requiredFunctionSemantics, /v_use_partial_receiving_metrics boolean := false;/);
  assert.match(
    requiredFunctionSemantics,
    /if not v_has_full_receiving_metrics and p_existing_box_id is not null then/
  );
  assert.match(requiredFunctionSemantics, /v_use_partial_receiving_metrics := true;/);
  assert.match(requiredFunctionSemantics, /v_active_allocated_feet := app_api\.physical_film_commitment_feet_for_box\(/);
  assert.match(requiredFunctionSemantics, /coalesce\(v_existing\.feet_available, v_feet_available\)/);
  assert.match(
    requiredFunctionSemantics,
    /'if v_initial_weight_input is null and v_existing\.initial_weight_lbs is null then'/
  );
  assert.match(
    requiredFunctionSemantics,
    /'v_feet_available := app_api\.clamp_feet_to_initial_range\(v_feet_available, v_initial_feet\);'/
  );
});

test('Edge boxes update route still targets the SQL ACL wrapper', async () => {
  const edgeMutationHandlers = await readFile(edgeMutationHandlersPath, 'utf8');

  assert.match(edgeMutationHandlers, /"\/boxes\/update": async/);
  assert.match(edgeMutationHandlers, /callMutationRpc\(client, "api_acl_boxes_update", orgId, actor, normalizedPayload\)/);
});

test('local runtime partial receiving update preserves stored physical feet without explicit current feet', async () => {
  const runtimeCollectionsAndBoxes = await readFile(runtimeCollectionsAndBoxesPath, 'utf8');

  assert.match(
    runtimeCollectionsAndBoxes,
    /feetAvailable = clampFeetToInitialRange\(existingBox\?\.feetAvailable \?\? feetAvailable, initialFeet\);/
  );
  assert.doesNotMatch(
    runtimeCollectionsAndBoxes,
    /feetAvailable = clampFeetToInitialRange\(feetAvailable, initialFeet\);/
  );
});
