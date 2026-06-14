import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0121_planner_suppression_jobid_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260513140000_planner_suppression_jobid_scope.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const baseSchemaMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0001_supabase_inventory_schema.sql');
const duplicateGuardMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0117_duplicate_job_creation_guard.sql');

function extractSuppressionClearBody(sql) {
  const match = sql.match(
    /create or replace function public\.api_acl_clear_allocation_planner_suppression[\s\S]*?as \$\$\r?\n(?<body>[\s\S]*?)\r?\n\$\$;/
  );
  assert.ok(match?.groups?.body, 'Expected public.api_acl_clear_allocation_planner_suppression body.');
  return match.groups.body;
}

test('planner suppression jobId scope migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('planner suppression canonical jobId path selects exact job and rejects mismatched identity', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractSuppressionClearBody(migration);

  assert.match(migration, /create or replace function public\.api_acl_clear_allocation_planner_suppression/);
  assert.match(body, /v_job_id_text text := app_api\.trim_text\(v_payload->>'jobId'\);/);
  assert.match(body, /v_has_valid_job_id boolean := coalesce\(v_job_id_text ~\*/);
  assert.match(body, /if v_has_valid_job_id then\s+v_job_id := v_job_id_text::uuid;/s);
  assert.match(body, /where j\.org_id = p_org_id\s+and j\.id = v_job_id\s+for update;/s);
  assert.match(body, /upper\(trim\(v_job\.job_number\)\) <> upper\(trim\(v_job_number\)\)/);
  assert.match(body, /Job identity mismatch: selected job does not match jobNumber\./);
  assert.ok(
    body.indexOf('Job identity mismatch: selected job does not match jobNumber.') <
      body.indexOf("if v_material_type = 'CAULK' then"),
    'Expected job identity mismatch to be rejected before suppression clear helpers run.'
  );
});

test('planner suppression canonical path validates film and caulk ownership by job_id before mutation', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractSuppressionClearBody(migration);

  assert.match(
    body,
    /select \*\s+into v_caulk_requirement\s+from app\.job_caulk_requirements r\s+where r\.org_id = p_org_id\s+and r\.job_id = v_job\.id\s+and r\.id = v_requirement_id\s+for update;/s
  );
  assert.match(body, /Caulk requirement was not found for selected job\./);
  assert.match(
    body,
    /select \*\s+into v_film_requirement\s+from app\.job_requirements r\s+where r\.org_id = p_org_id\s+and r\.job_id = v_job\.id\s+and r\.id = v_requirement_id\s+for update;/s
  );
  assert.match(body, /Film requirement was not found for selected job\./);
  assert.ok(
    body.indexOf('into v_caulk_requirement') <
      body.indexOf('app_api.clear_caulk_allocation_planner_suppression_for_requirement('),
    'Expected caulk ownership check before caulk suppression clear helper.'
  );
  assert.ok(
    body.indexOf('into v_film_requirement') <
      body.indexOf('app_api.clear_allocation_planner_suppression_for_requirement('),
    'Expected film ownership check before film suppression clear helper.'
  );
});

test('planner suppression canonical planner scope includes jobIds with legacy additive fields', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractSuppressionClearBody(migration);

  assert.match(body, /perform app_api\.reconcile_auto_planned_allocations\(/);
  assert.match(
    body,
    /v_scope := jsonb_build_object\(\s+'jobIds', jsonb_build_array\(v_job\.id\),\s+'jobNumbers', jsonb_build_array\(v_job\.job_number\),\s+'caulkProductWarehousePairs',\s+jsonb_build_array\(/s
  );
  assert.match(
    body,
    /v_scope := jsonb_build_object\(\s+'jobIds', jsonb_build_array\(v_job\.id\),\s+'jobNumbers', jsonb_build_array\(v_job\.job_number\)\s+\);/s
  );
  assert.doesNotMatch(body, /auto_planner_scope_job_numbers\(/);
});

test('planner suppression legacy jobNumber-only behavior and response shape are preserved', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractSuppressionClearBody(migration);

  assert.match(
    body,
    /else\s+v_result := app_api\.clear_caulk_allocation_planner_suppression_for_requirement\(\s+p_org_id,\s+p_actor,\s+v_job_number,\s+v_requirement_id,/s
  );
  assert.match(
    body,
    /v_scope := jsonb_build_object\(\s+'jobNumbers', jsonb_build_array\(v_job_number\),\s+'caulkProductWarehousePairs',/s
  );
  assert.match(
    body,
    /else\s+v_result := app_api\.clear_allocation_planner_suppression_for_requirement\(\s+p_org_id,\s+p_actor,\s+v_job_number,\s+v_requirement_id,/s
  );
  assert.match(body, /v_scope := jsonb_build_object\('jobNumbers', jsonb_build_array\(v_job_number\)\);/);
  assert.match(body, /return v_result \|\| jsonb_build_object\('materialType', v_material_type\);/);
});

test('planner suppression jobId scope migration does not alter deferred workflows or duplicate guards', async () => {
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

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0161_linked_film_order_shortage_reconcile_guard\.sql';/);

  assert.match(schemaCheck, /'jobIds', jsonb_build_array\(v_job\.id\)/);
});
