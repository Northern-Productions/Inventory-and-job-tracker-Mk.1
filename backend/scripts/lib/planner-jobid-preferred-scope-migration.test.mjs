import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0119_planner_jobid_preferred_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260513120000_planner_jobid_preferred_scope.sql'
);
const baseSchemaMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0001_supabase_inventory_schema.sql');
const duplicateGuardMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0117_duplicate_job_creation_guard.sql');
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

const runtimePaths = [
  path.join(repoRoot, 'backend', 'src', 'app', 'services', 'runtime', 'runtimeAutoAllocationPlanner.mjs'),
  path.join(repoRoot, 'backend', 'src', 'app', 'services', 'runtime', 'runtimeAllocationApply.mjs'),
  path.join(repoRoot, 'backend', 'src', 'app', 'handlers', 'mutationHandlers.mjs'),
  path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'mutationHandlers.ts'),
  path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'readHandlers.ts'),
];

function extractScopeJobsBody(sql) {
  const match = sql.match(
    /create or replace function app_api\.auto_planner_scope_jobs[\s\S]*?as \$\$\r?\n(?<body>[\s\S]*?)\r?\n\$\$;/
  );
  assert.ok(match?.groups?.body, 'Expected auto_planner_scope_jobs function body.');
  return match.groups.body;
}

test('planner jobId-preferred scope migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('auto_planner_scope_jobs consumes all transition scope fields and returns job ids', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const helperBody = extractScopeJobsBody(migration);

  assert.match(migration, /create or replace function app_api\.auto_planner_scope_jobs/);
  assert.match(migration, /returns table\(job_id uuid, job_number text\)/);
  assert.match(helperBody, /v_scope->'jobIds'/);
  assert.match(helperBody, /v_scope->'jobNumbers'/);
  assert.match(helperBody, /v_scope->'boxIds'/);
  assert.match(helperBody, /v_scope->'caulkProductWarehousePairs'/);
  assert.match(helperBody, /auto_planner_scope_job_id_candidates/);
  assert.match(helperBody, /auto_planner_scope_job_number_candidates/);
  assert.match(helperBody, /auto_planner_scope_box_candidates/);
  assert.match(helperBody, /auto_planner_scope_caulk_pair_candidates/);
  assert.match(helperBody, /result_job_id uuid primary key/);
  assert.match(helperBody, /on conflict do nothing/);
  assert.match(helperBody, /select r\.result_job_id, r\.result_job_number/);
});

test('valid jobIds are exact explicit candidates and prevent jobNumber expansion', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const helperBody = extractScopeJobsBody(migration);

  assert.match(helperBody, /v_has_valid_job_ids := exists/);
  assert.match(helperBody, /if v_has_valid_job_ids then/);
  assert.match(helperBody, /j\.id = s\.candidate_job_id/);
  assert.match(helperBody, /else\s+insert into auto_planner_scope_job_results/s);
  assert.match(helperBody, /upper\(btrim\(j\.job_number\)\) = s\.job_number_key/);
  assert.ok(
    helperBody.indexOf('if v_has_valid_job_ids then') < helperBody.indexOf('upper(btrim(j.job_number)) = s.job_number_key'),
    'Expected jobNumber fallback to be below valid jobId branch.'
  );
  assert.doesNotMatch(helperBody, /auto_planner_scope_job_numbers\(/);
});

test('box and caulk affected scopes remain additive and jobId-safe', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const helperBody = extractScopeJobsBody(migration);

  assert.match(helperBody, /auto_planner_scope_box_candidates/);
  assert.match(helperBody, /a\.job_id is not null and j\.id = a\.job_id/);
  assert.match(helperBody, /a\.job_id is null/);
  assert.match(helperBody, /upper\(btrim\(j\.job_number\)\) = upper\(btrim\(a\.job_number\)\)/);
  assert.match(helperBody, /app_api\.requirement_film_is_compatible\(/);
  assert.match(helperBody, /auto_planner_scope_caulk_pair_candidates/);
  assert.match(helperBody, /r\.product_id = sc\.product_id/);
});

test('reconcile uses jobId-preferred scope helper and blocks jobId-only warehouse-wide box loading', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(
    migration,
    /pg_get_functiondef\('app_api\.reconcile_auto_planned_allocations\(uuid, text, jsonb\)'::regprocedure\)/
  );
  assert.match(
    migration,
    /join app_api\.auto_planner_scope_jobs\(p_org_id, coalesce\(p_scope, '\{\}'::jsonb\)\) s\s+on s\.job_id = j\.id/
  );
  assert.match(migration, /create temporary table if not exists auto_planner_explicit_job_id_scope/);
  assert.match(migration, /not exists \(select 1 from auto_planner_explicit_job_id_scope\)/);
  assert.match(migration, /position\(v_old_jobs_join in v_next_definition\) > 0/);
});

test('reconcile patch normalizes CRLF snippets before anchor matching', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const normalizationLines = [
    "v_definition := replace(v_definition, E'\\r\\n', E'\\n');",
    "v_old_jobs_join := replace(v_old_jobs_join, E'\\r\\n', E'\\n');",
    "v_new_jobs_join := replace(v_new_jobs_join, E'\\r\\n', E'\\n');",
    "v_old_explicit_scope_anchor := replace(v_old_explicit_scope_anchor, E'\\r\\n', E'\\n');",
    "v_new_explicit_scope_anchor := replace(v_new_explicit_scope_anchor, E'\\r\\n', E'\\n');",
    "v_old_explicit_insert_anchor := replace(v_old_explicit_insert_anchor, E'\\r\\n', E'\\n');",
    "v_new_explicit_insert_anchor := replace(v_new_explicit_insert_anchor, E'\\r\\n', E'\\n');",
    "v_old_org_wide_guard := replace(v_old_org_wide_guard, E'\\r\\n', E'\\n');",
    "v_new_org_wide_guard := replace(v_new_org_wide_guard, E'\\r\\n', E'\\n');",
  ];

  for (const line of normalizationLines) {
    assert.ok(migration.includes(line), `Expected migration to normalize line endings with: ${line}`);
  }
  assert.ok(
    migration.indexOf(normalizationLines[0]) < migration.indexOf('v_next_definition := v_definition;'),
    'Expected line-ending normalization before anchor matching starts.'
  );
});

test('legacy helpers remain defined and duplicate job numbers stay disabled', async () => {
  const [migration, baseSchemaMigration, duplicateGuardMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(baseSchemaMigrationPath, 'utf8'),
    readFile(duplicateGuardMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.doesNotMatch(migration, /create or replace function app_api\.auto_planner_scope_job_numbers/);
  assert.doesNotMatch(migration, /create or replace function app_api\.auto_planner_scope_job_ids/);
  assert.match(schemaCheck, /app_api\.auto_planner_scope_job_numbers\(uuid, jsonb\)/);
  assert.match(schemaCheck, /app_api\.auto_planner_scope_job_ids\(uuid, jsonb\)/);
  assert.match(schemaCheck, /app_api\.auto_planner_scope_jobs\(uuid, jsonb\)/);
  assert.match(baseSchemaMigration, /unique\s*\(\s*org_id\s*,\s*job_number\s*\)/i);
  assert.match(duplicateGuardMigration, /Job %s already exists/);
  assert.doesNotMatch(migration, /alter table app\.jobs/i);
  assert.doesNotMatch(migration, /drop constraint/i);
});

test('runtime callers are not switched to the new SQL helper in this slice', async () => {
  const runtimeSources = await Promise.all(runtimePaths.map((runtimePath) => readFile(runtimePath, 'utf8')));

  for (const source of runtimeSources) {
    assert.doesNotMatch(source, /auto_planner_scope_jobs/);
    assert.doesNotMatch(source, /backend\/migrations|supabase\/migrations/);
  }
});
