import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0124_film_order_create_jobid_scope.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260513170000_film_order_create_jobid_scope.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const baseSchemaMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0001_supabase_inventory_schema.sql');
const duplicateGuardMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0117_duplicate_job_creation_guard.sql');
const runtimeJobsMutationsPath = path.join(repoRoot, 'backend', 'src', 'app', 'services', 'runtime', 'runtimeJobsMutations.mjs');
const edgeMutationHandlersPath = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'routes',
  'mutationHandlers.ts'
);

function extractBody(sql, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sql.match(
    new RegExp(`create or replace function ${escapedName}[\\s\\S]*?as \\$\\$\\r?\\n(?<body>[\\s\\S]*?)\\r?\\n\\$\\$;`)
  );
  assert.ok(match?.groups?.body, `Expected ${functionName} body.`);
  return match.groups.body;
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected marker ${startMarker}.`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Expected marker ${endMarker}.`);
  return source.slice(start, end);
}

test('film order create jobId scope migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('api_film_orders_create canonical path validates exact job identity before writes', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_film_orders_create');

  assert.match(body, /v_job_id_text text := app_api\.trim_text\(p_payload->>'jobId'\);/);
  assert.match(body, /v_has_job_id boolean := v_job_id_text <> '';/);
  assert.match(body, /jobId must be a valid UUID\./);
  assert.match(body, /where j\.org_id = p_org_id\s+and j\.id = v_job_id\s+for update;/s);
  assert.match(body, /Job was not found\./);
  assert.match(body, /upper\(trim\(v_job\.job_number\)\) <> upper\(trim\(v_payload_job_number\)\)/);
  assert.match(body, /Job identity mismatch: selected job does not match jobNumber\./);
  assert.match(body, /Job %s is closed and cannot receive film orders\./);
  assert.ok(
    body.indexOf('Job identity mismatch: selected job does not match jobNumber.') <
      body.indexOf('v_order := app_api.save_film_order(v_order);'),
    'Expected jobId/jobNumber mismatch to be rejected before film order creation.'
  );
  assert.match(body, /when v_has_job_id then v_job\.id/);
  assert.match(body, /when v_has_job_id then v_job\.job_number/);
});

test('canonical film order create validates requirement ownership and duplicate checks by selected job_id', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_film_orders_create');

  assert.match(body, /RequirementID is required when jobId is supplied\./);
  assert.match(body, /v_requirement\.job_id is distinct from v_order\.job_id/);
  assert.match(body, /RequirementID must belong to the selected job\./);
  assert.match(body, /Film order product and width must match the selected requirement\./);
  assert.match(body, /when v_has_job_id then fo\.job_id = v_order\.job_id/);
  assert.match(body, /app_api\.film_order_matches_requirement\(/);
  assert.match(body, /v_order := app_api\.save_film_order\(v_order\);/);
});

test('legacy film order create path remains jobNumber-only and response shape is preserved', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_film_orders_create');

  assert.match(body, /else app_api\.get_or_resolve_job_id\(p_org_id, v_payload_job_number\)/);
  assert.match(body, /else v_payload_job_number/);
  assert.match(body, /RequirementID must belong to the same job as the film order\./);
  assert.match(body, /else upper\(trim\(fo\.job_number\)\) = upper\(trim\(v_order\.job_number\)\)/);
  assert.match(body, /'filmOrderId', v_order\.film_order_id/);
  assert.match(body, /'warnings', '\[\]'::jsonb/);
});

test('film order create jobId scope migration does not alter deferred workflows or duplicate guards', async () => {
  const [migration, baseSchemaMigration, duplicateGuardMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(baseSchemaMigrationPath, 'utf8'),
    readFile(duplicateGuardMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.doesNotMatch(migration, /api_film_orders_cancel/);
  assert.doesNotMatch(migration, /api_film_orders_delete/);
  assert.doesNotMatch(migration, /api_allocations_apply/);
  assert.doesNotMatch(migration, /api_jobs_create/);
  assert.doesNotMatch(migration, /api_jobs_check_duplicate/);
  assert.doesNotMatch(migration, /api_jobs_set_staged_pickup/);
  assert.doesNotMatch(migration, /api_jobs_complete/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_/);
  assert.doesNotMatch(migration, /alter table app\.jobs/i);
  assert.doesNotMatch(migration, /drop constraint/i);
  assert.match(baseSchemaMigration, /unique\s*\(\s*org_id\s*,\s*job_number\s*\)/i);
  assert.match(duplicateGuardMigration, /Job %s already exists/);
  assert.match(schemaCheck, /const LATEST_MIGRATION = '0137_repair_box_update_partial_receiving_parity\.sql';/);
  assert.match(schemaCheck, /RequirementID is required when jobId is supplied/);
  assert.match(schemaCheck, /when v_has_job_id then fo\.job_id = v_order\.job_id/);
});

test('local runtime film order create mirrors canonical jobId guards and keeps legacy fallback', async () => {
  const runtime = await readFile(runtimeJobsMutationsPath, 'utf8');
  const body = extractBetween(runtime, 'async function createFilmOrder', 'async function cancelJob');

  assert.match(body, /requireUuid\(suppliedJobId, 'jobId'\)/);
  assert.match(body, /resolveJobMutationTargetById\(client, orgId, payload\)/);
  assert.match(body, /target\.usedJobId\s+\?\s+target\.job/);
  assert.match(body, /RequirementID is required when jobId is supplied\./);
  assert.match(body, /listJobRequirementsByJobId\(client, orgId, target\.jobId\)/);
  assert.match(body, /listJobRequirementsByJob\(client, orgId, jobNumber\)/);
  assert.match(body, /listFilmOrdersByJobId\(client, orgId, target\.jobId\)/);
  assert.match(body, /listFilmOrdersByJob\(client, orgId, jobNumber\)/);
  assert.match(body, /target\.usedJobId\s+\?\s+target\.jobId\s+:\s+await getOrResolveJobId\(client, orgId, jobNumber\)/);
});

test('Edge film order create validates canonical jobId before RPC and strips request orgId', async () => {
  const edgeHandlers = await readFile(edgeMutationHandlersPath, 'utf8');
  const body = extractBetween(edgeHandlers, '"/film-orders/create": async', '"/film-orders/cancel": async');

  assert.match(body, /JOB_ID_PATTERN\.test\(suppliedJobId\)/);
  assert.match(body, /resolveEdgeJobMutationTargetById\(client, orgId, normalizedPayload/);
  assert.match(body, /const \{ orgId: _requestOrgId, \.\.\.payloadWithoutRequestOrg \} = normalizedPayload;/);
  assert.match(body, /target\.usedJobId\s+\?\s+target\.job/);
  assert.match(body, /RequirementID is required when jobId is supplied\./);
  assert.match(body, /target\.usedJobId\s+\?\s+\{ \.\.\.payloadWithoutRequestOrg, jobId: target\.jobId, jobNumber \}/);
  assert.match(body, /api_acl_film_orders_create/);
});
