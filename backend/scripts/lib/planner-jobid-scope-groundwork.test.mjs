import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0118_planner_jobid_scope_groundwork.sql');
const narrowScopeMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0095_narrow_auto_planner_scope.sql');
const duplicateGuardMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0117_duplicate_job_creation_guard.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260512120000_planner_jobid_scope_groundwork.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

const runtimePaths = [
  path.join(repoRoot, 'backend', 'src', 'app', 'services', 'runtime', 'runtimeAutoAllocationPlanner.mjs'),
  path.join(repoRoot, 'backend', 'src', 'app', 'services', 'runtime', 'runtimeAllocationApply.mjs'),
  path.join(repoRoot, 'backend', 'src', 'app', 'handlers', 'mutationHandlers.mjs'),
  path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'mutationHandlers.ts'),
  path.join(repoRoot, 'supabase', 'functions', '_shared', 'routes', 'readHandlers.ts'),
];

function extractFunctionBody(sql) {
  const match = sql.match(
    /create or replace function app_api\.auto_planner_scope_job_ids[\s\S]*?as \$\$\r?\n(?<body>[\s\S]*?)\r?\n\$\$;/
  );
  assert.ok(match?.groups?.body, 'Expected auto_planner_scope_job_ids function body.');
  return match.groups.body;
}

test('planner jobId scope groundwork migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('planner jobId scope helper selects exact org-owned job ids only', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const helperBody = extractFunctionBody(migration);

  assert.match(migration, /create or replace function app_api\.auto_planner_scope_job_ids/);
  assert.match(migration, /returns table\(job_id uuid, job_number text\)/);
  assert.match(helperBody, /coalesce\(p_scope, '\{\}'::jsonb\)->'jobIds'/);
  assert.match(helperBody, /btrim\(value\)::uuid as job_id/);
  assert.match(helperBody, /group by btrim\(value\)::uuid/);
  assert.match(helperBody, /j\.org_id = p_org_id/);
  assert.match(helperBody, /j\.id = r\.job_id/);
  assert.match(helperBody, /order by\s+r\.first_position,\s+j\.job_number,\s+j\.id/s);
  assert.doesNotMatch(helperBody, /upper\(trim\(j\.job_number\)\)/);
});

test('planner jobId scope groundwork preserves legacy jobNumber planner behavior', async () => {
  const [migration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.doesNotMatch(migration, /drop function/i);
  assert.doesNotMatch(migration, /create or replace function app_api\.auto_planner_scope_job_numbers/);
  assert.match(schemaCheck, /0118_planner_jobid_scope_groundwork\.sql/);
  assert.match(schemaCheck, /app_api\.auto_planner_scope_job_numbers\(uuid, jsonb\)/);
  assert.match(schemaCheck, /app_api\.auto_planner_scope_job_ids\(uuid, jsonb\)/);
});

test('planner jobId scope groundwork documents future ambiguity safety without enabling duplicates', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /Existing jobNumber planner entry points remain legacy compatibility only/);
  assert.match(migration, /future duplicate-number support must not call jobNumber planner entry points/);
  assert.match(migration, /Duplicate job numbers remain disabled in this branch/);
  assert.doesNotMatch(migration, /\bdrop\s+constraint\b/i);
  assert.doesNotMatch(migration, /\bcreate\s+unique\s+index\b/i);
  assert.doesNotMatch(migration, /\bunique\s*\(\s*org_id\s*,\s*job_number/i);
});

test('planner jobId helper is not wired into runtime behavior yet', async () => {
  const runtimeSources = await Promise.all(runtimePaths.map((runtimePath) => readFile(runtimePath, 'utf8')));

  for (const source of runtimeSources) {
    assert.doesNotMatch(source, /auto_planner_scope_job_ids/);
  }
});

test('planner reconciliation still uses jobNumber candidate selection while jobIds stay shadow metadata', async () => {
  const [narrowScopeMigration, schemaCheck] = await Promise.all([
    readFile(narrowScopeMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.match(narrowScopeMigration, /join app_api\.auto_planner_scope_job_numbers\(p_org_id, coalesce\(p_scope, '\{\}'::jsonb\)\) s/);
  assert.doesNotMatch(narrowScopeMigration, /auto_planner_scope_job_ids/);
  assert.match(schemaCheck, /signature: 'app_api\.reconcile_auto_planned_allocations\(uuid, text, jsonb\)'/);
  assert.match(schemaCheck, /'auto_planner_scope_job_numbers\('/);
});

test('planner jobId shadow scope does not change duplicate-number or migration requirements', async () => {
  const [duplicateGuardMigration, runtimeSources] = await Promise.all([
    readFile(duplicateGuardMigrationPath, 'utf8'),
    Promise.all(runtimePaths.map((runtimePath) => readFile(runtimePath, 'utf8'))),
  ]);

  assert.doesNotMatch(duplicateGuardMigration, /alter table app\.jobs/i);
  assert.doesNotMatch(duplicateGuardMigration, /drop constraint/i);
  assert.doesNotMatch(duplicateGuardMigration, /unique\s*\(\s*org_id\s*,\s*job_number/i);
  for (const source of runtimeSources) {
    assert.doesNotMatch(source, /supabase\/migrations|backend\/migrations/);
    assert.doesNotMatch(source, /auto_planner_scope_job_ids/);
  }
});
