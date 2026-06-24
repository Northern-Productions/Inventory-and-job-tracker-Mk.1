import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0152_fix_planner_suppression_on_conflict.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260527100000_fix_planner_suppression_on_conflict.sql'
);
const multiPhaseMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0143_multi_phase_jobs.sql');
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

function extractBody(sql, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sql.match(
    new RegExp(`create or replace function ${escapedName}[\\s\\S]*?as \\$\\$\\r?\\n(?<body>[\\s\\S]*?)\\r?\\n\\$\\$;`)
  );
  assert.ok(match?.groups?.body, `Expected ${functionName} body.`);
  return match.groups.body;
}

test('planner suppression conflict-target hotfix migration stays mirrored', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('film suppression upsert matches the phase-aware active suppression unique index', async () => {
  const [migration, multiPhaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(multiPhaseMigrationPath, 'utf8'),
  ]);
  const body = extractBody(migration, 'app_api.record_auto_planned_allocation_suppression');

  assert.match(
    multiPhaseMigration,
    /create unique index if not exists idx_allocation_planner_suppressions_active_unique[\s\S]*coalesce\(phase_id, '00000000-0000-0000-0000-000000000000'::uuid\)[\s\S]*where cleared_at is null;/
  );
  assert.match(
    body,
    /on conflict \(\s+org_id,\s+job_id,\s+material_type,\s+\(coalesce\(phase_id, '00000000-0000-0000-0000-000000000000'::uuid\)\),\s+requirement_signature\s+\)\s+where cleared_at is null/s
  );
  assert.doesNotMatch(body, /on conflict \(org_id, job_id, material_type, requirement_signature\)/);
});

test('caulk suppression upsert matches the phase-aware active suppression unique index', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'app_api.record_auto_planned_caulk_allocation_suppression');

  assert.match(
    body,
    /on conflict \(\s+org_id,\s+job_id,\s+material_type,\s+\(coalesce\(phase_id, '00000000-0000-0000-0000-000000000000'::uuid\)\),\s+requirement_signature\s+\)\s+where cleared_at is null/s
  );
  assert.doesNotMatch(body, /on conflict \(org_id, job_id, material_type, requirement_signature\)/);
});

test('planner suppression conflict-target hotfix stays scoped to suppression persistence', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.record_auto_planned_allocation_suppression/);
  assert.match(migration, /create or replace function app_api\.record_auto_planned_caulk_allocation_suppression/);
  assert.doesNotMatch(migration, /api_allocations_remove_box/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_remove/);
  assert.doesNotMatch(migration, /api_allocations_apply/);
  assert.doesNotMatch(migration, /reconcile_auto_planned_allocations/);
  assert.doesNotMatch(migration, /create unique index/i);
  assert.doesNotMatch(migration, /drop index/i);
  assert.doesNotMatch(migration, /alter table/i);
});

test('schema latest guard tracks the planner suppression conflict-target hotfix', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');


  assert.match(schemaCheck, /const LATEST_MIGRATION = '0171_checked_out_allocation_apply_guard\.sql';/);

  assert.match(schemaCheck, /app_api\.record_auto_planned_allocation_suppression\(uuid, text, text, text\)/);
  assert.match(schemaCheck, /app_api\.record_auto_planned_caulk_allocation_suppression\(uuid, text, text, text\)/);
  assert.match(schemaCheck, /\(coalesce\(phase_id, '00000000-0000-0000-0000-000000000000'::uuid\)\)/);
  assert.match(schemaCheck, /on conflict \(org_id, job_id, material_type, requirement_signature\)/);
});
