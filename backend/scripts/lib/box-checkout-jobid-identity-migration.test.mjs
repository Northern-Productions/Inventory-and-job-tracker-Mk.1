import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0130_box_checkout_jobid_identity.sql');
const duplicateCheckoutGuardMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0139_box_status_duplicate_job_checkout_guard.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260513230000_box_checkout_jobid_identity.sql'
);
const supabaseDuplicateCheckoutGuardMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260520030000_box_status_duplicate_job_checkout_guard.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const baseSchemaMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0001_supabase_inventory_schema.sql');
const duplicateGuardMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0117_duplicate_job_creation_guard.sql');
const localBoxStatusPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'boxes',
  'statusTransitions.mjs'
);
const edgeMutationHandlersPath = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'routes',
  'mutationHandlers.ts'
);
const frontendDomainPath = path.join(repoRoot, 'frontend', 'src', 'domain', 'inventory', 'boxes.ts');
const frontendApiDomainPath = path.join(repoRoot, 'frontend', 'src', 'domain', 'api.ts');
const frontendBoxMutationsPath = path.join(
  repoRoot,
  'frontend',
  'src',
  'features',
  'inventory',
  'hooks',
  'mutations',
  'boxMutations.ts'
);
const frontendFilmWorkflowPath = path.join(
  repoRoot,
  'frontend',
  'src',
  'features',
  'inventory',
  'pages',
  'allocation-job',
  'useJobFilmWorkflow.ts'
);
const localMappersPath = path.join(repoRoot, 'backend', 'src', 'app', 'repositories', 'mappers.mjs');
const edgeRepositoriesPath = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'repositories',
  'inventoryRepositories.ts'
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
  const normalizedSource = source.replace(/\r\n/g, '\n');
  const start = normalizedSource.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected marker ${startMarker}.`);
  const end = normalizedSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Expected marker ${endMarker}.`);
  return normalizedSource.slice(start, end);
}

test('box checkout jobId identity migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('box status duplicate checkout guard migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(duplicateCheckoutGuardMigrationPath, 'utf8'),
    readFile(supabaseDuplicateCheckoutGuardMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('box checkout jobId identity migration adds nullable durable identity without changing duplicate constraints', async () => {
  const [migration, baseSchemaMigration, duplicateGuardMigration, schemaCheck] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(baseSchemaMigrationPath, 'utf8'),
    readFile(duplicateGuardMigrationPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.match(migration, /alter table app\.boxes\s+add column if not exists last_checkout_job_id uuid;/);
  assert.match(migration, /foreign key \(last_checkout_job_id\)\s+references app\.jobs\(id\)\s+on delete set null;/);
  assert.match(migration, /create index if not exists idx_boxes_org_last_checkout_job_id\s+on app\.boxes \(org_id, last_checkout_job_id\)\s+where last_checkout_job_id is not null;/);
  assert.match(migration, /alter table app\.roll_weight_log\s+add column if not exists job_id uuid;/);
  assert.match(migration, /foreign key \(job_id\)\s+references app\.jobs\(id\)\s+on delete set null;/);
  assert.match(migration, /create index if not exists idx_roll_weight_log_org_job_id\s+on app\.roll_weight_log \(org_id, job_id\)\s+where job_id is not null;/);
  assert.match(migration, /last_checkout_job,/);
  assert.match(migration, /job_number,/);
  assert.doesNotMatch(migration, /update app\.boxes\s+set last_checkout_job_id/i);
  assert.doesNotMatch(migration, /update app\.roll_weight_log\s+set job_id/i);
  assert.doesNotMatch(migration, /drop constraint/i);
  assert.match(baseSchemaMigration, /unique\s*\(\s*org_id\s*,\s*job_number\s*\)/i);
  assert.match(duplicateGuardMigration, /Job %s already exists/);


  assert.match(schemaCheck, /app\.boxes\.last_checkout_job_id/);
  assert.match(schemaCheck, /app\.roll_weight_log\.job_id/);
});

test('api_boxes_set_status writes canonical checkout identity and preserves legacy check-in fallback', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'public.api_boxes_set_status');

  assert.match(body, /v_payload_job_id_text text := app_api\.trim_text\(p_payload->>'jobId'\);/);
  assert.match(body, /v_checkout_job := app_api\.parse_checkout_job_from_note\(p_payload->>'auditNote'\);/);
  assert.match(body, /if v_payload_job_id_text <> '' then/);
  assert.match(body, /perform app_api\.raise_http\(400, 'jobId must be a valid UUID\.'\);/);
  assert.match(body, /from app\.jobs j\s+where j\.org_id = p_org_id\s+and j\.id = v_checkout_job_id;/s);
  assert.match(body, /if v_checkout_job = '' and v_payload_job_number <> '' then\s+v_checkout_job := v_payload_job_number;/s);
  assert.match(body, /perform app_api\.raise_http\(400, 'jobId does not match jobNumber\.'\);/);
  assert.match(body, /v_box\.last_checkout_job_id := v_checkout_job_id;/);
  assert.match(body, /v_box\.last_checkout_job := v_checkout_job;/);
  assert.match(body, /if v_existing\.last_checkout_job_id is not null then/);
  assert.match(body, /and j\.id = v_existing\.last_checkout_job_id;/);
  assert.match(body, /v_checkout_job_id := v_selected_job\.id;/);
  assert.match(body, /v_checkout_job := v_selected_job\.job_number;/);
  assert.match(body, /coalesce\(nullif\(v_existing\.last_checkout_job, ''\), app_api\.parse_checkout_job_from_note\(v_checkout_audit\.notes\)\)/);
  assert.match(body, /v_checkout_job_id,/);
  assert.match(body, /v_box\.last_checkout_job_id := null;/);
  assert.match(body, /'jobId', v_checkout_job_id::text/);

  const mismatchIndex = body.indexOf("jobId does not match jobNumber.");
  const mutationIndex = body.indexOf("v_box.status := 'CHECKED_OUT';");
  assert.ok(mismatchIndex >= 0 && mutationIndex >= 0 && mismatchIndex < mutationIndex);
});

test('box status SQL owns planner scope with jobIds, jobNumbers, and boxIds for canonical responses', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const aclBody = extractBody(migration, 'public.api_acl_boxes_set_status');

  assert.match(aclBody, /v_result := public\.api_boxes_set_status\(p_org_id, p_actor, v_payload\);/);
  assert.match(aclBody, /'boxIds', jsonb_build_array\(v_lookup_box_id\)/);
  assert.match(aclBody, /'jobIds', jsonb_build_array\(v_result->>'jobId'\)/);
  assert.match(aclBody, /'jobNumbers', jsonb_build_array\(v_result->>'jobNumber'\)/);
  assert.match(aclBody, /perform app_api\.reconcile_auto_planned_allocations\(/);
  assert.match(migration, /create or replace function app_api\.append_roll_history\([\s\S]*p_job_number text,\s+p_job_id uuid,[\s\S]*insert into app\.roll_weight_log \([\s\S]*job_id,[\s\S]*p_job_id,/);
  assert.doesNotMatch(aclBody, /reconcile_auto_shortage_film_orders_for_box/);
});

test('box checkout identity migration keeps deferred workflows and duplicate behavior out of scope', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.doesNotMatch(migration, /api_jobs_checkout_all/);
  assert.doesNotMatch(migration, /api_jobs_set_staged_pickup/);
  assert.doesNotMatch(migration, /api_jobs_complete/);
  assert.doesNotMatch(migration, /api_film_orders_(cancel|delete|create)/);
  assert.doesNotMatch(migration, /api_allocations_(apply|preview)/);
  assert.doesNotMatch(migration, /api_acl_allocations_caulk_/);
  assert.doesNotMatch(migration, /api_jobs_create/);
  assert.doesNotMatch(migration, /api_jobs_check_duplicate/);
  assert.doesNotMatch(migration, /alter table app\.jobs/i);
});

test('backend local box status supports additive jobId without converting checkout-all or staged pickup', async () => {
  const source = await readFile(localBoxStatusPath, 'utf8');

  assert.match(source, /const suppliedJobId = asTrimmedString\(payload\.jobId\);/);
  assert.match(source, /selectedJobId = requireUuid\(suppliedJobId, 'jobId'\);/);
  assert.match(source, /selectedJob = await findJobById\(client, orgId, selectedJobId\);/);
  assert.match(source, /jobId does not match jobNumber\./);
  assert.match(source, /updatedBox\.lastCheckoutJobId = selectedJob \? selectedJobId : '';/);
  assert.match(source, /let checkoutJobId = asTrimmedString\(existing\.lastCheckoutJobId\);/);
  assert.match(source, /jobId: checkoutJobId,/);
  assert.match(source, /\.\.\.\(responseJobId \? \{ jobId: responseJobId \} : \{\}\)/);
  assert.match(source, /\.\.\.\(responseJobNumber \? \{ jobNumber: responseJobNumber \} : \{\}\)/);
});

test('box status duplicate checkout guard requires jobId for ambiguous checkout and releases check-in allocations by jobId', async () => {
  const [migration, localBoxStatus, schemaCheck] = await Promise.all([
    readFile(duplicateCheckoutGuardMigrationPath, 'utf8'),
    readFile(localBoxStatusPath, 'utf8'),
    readFile(schemaCheckPath, 'utf8'),
  ]);

  assert.match(migration, /v_legacy_checkout_job_match_count integer := 0;/);
  assert.match(migration, /replace\('[\s\S]*E'\\r\\n', E'\\n'\)/);
  assert.match(
    migration,
    /Job number %s matches multiple jobs\. Choose a Work Scope to continue\./
  );
  assert.match(migration, /p_job_id is not null and a\.job_id = p_job_id/);
  assert.match(migration, /v_checkout_job_id is not null[\s\S]*a\.job_id = v_checkout_job_id/);
  assert.match(migration, /''Released during film box check-in\.'',\s+v_checkout_job_id/s);
  assert.doesNotMatch(migration, /api_jobs_create/);
  assert.doesNotMatch(migration, /app\.jobs\s+add column/i);

  assert.match(localBoxStatus, /async function assertLegacyCheckoutJobNumberIsUnambiguous/);
  assert.match(localBoxStatus, /matches\.length > 1/);
  assert.match(localBoxStatus, /await assertLegacyCheckoutJobNumberIsUnambiguous\(client, orgId, jobNumber\);/);
  assert.match(localBoxStatus, /planBoxCheckIn\(existing, payload, existingAllocations, checkoutJob, \{\s+jobId: checkoutJobId\s+\}\)/s);
  assert.match(localBoxStatus, /jobId: checkoutJobId/);



  assert.match(schemaCheck, /app_api\.cancel_active_allocations_for_box_job\(uuid, text, text, text, text, uuid\)/);
});

test('Edge and frontend accept box status jobId additively and keep checkout-all/staged payloads unchanged', async () => {
  const [edgeSource, domainSource, apiDomainSource, boxMutationSource, filmWorkflowSource, localMapperSource, edgeRepositorySource] =
    await Promise.all([
      readFile(edgeMutationHandlersPath, 'utf8'),
      readFile(frontendDomainPath, 'utf8'),
      readFile(frontendApiDomainPath, 'utf8'),
      readFile(frontendBoxMutationsPath, 'utf8'),
      readFile(frontendFilmWorkflowPath, 'utf8'),
      readFile(localMappersPath, 'utf8'),
      readFile(edgeRepositoriesPath, 'utf8'),
    ]);

  const setStatusBody = extractBetween(edgeSource, '"/boxes/set-status": async', '"/boxes/delete": async');
  assert.match(setStatusBody, /const resultJobId = deps\.asTrimmedString\(result\.jobId\);/);
  assert.match(setStatusBody, /\.\.\.\(resultJobId \? \{ jobId: resultJobId \} : \{\}\)/);
  assert.match(edgeSource, /const SQL_PLANNER_HANDLED_ROUTES = new Set\(\[[\s\S]*"\/boxes\/set-status"/);

  assert.match(domainSource, /lastCheckoutJobId\?: string;/);
  assert.match(domainSource, /jobId\?: string;\s+jobNumber\?: string;\s+lastRollWeightLbs\?: number;/);
  assert.match(domainSource, /export interface RollHistoryEntry \{[\s\S]*jobId\?: string;[\s\S]*jobNumber: string;/);
  assert.match(apiDomainSource, /export interface BoxMutationResult \{[\s\S]*jobId\?: string;[\s\S]*jobNumber\?: string;/);
  assert.match(boxMutationSource, /const resultJobId = String\(result\.jobId \|\| _variables\.jobId \|\| ''\)\.trim\(\);/);
  assert.match(boxMutationSource, /inventoryKeys\.jobById\(resultJobId\)/);
  assert.match(boxMutationSource, /if \(!payloadJobId\) \{\s+updateCheckedOutBoxCaches\(queryClient, payload\.boxId, payload\.status\);\s+\}/);
  assert.match(filmWorkflowSource, /\.\.\.\(canonicalJobId \? \{ jobId: canonicalJobId, jobNumber: targetJobNumber \} : \{\}\)/);
  assert.doesNotMatch(filmWorkflowSource, /checkoutAllJobMaterials/);
  assert.doesNotMatch(filmWorkflowSource, /autoCheckoutRemaining/);
  assert.match(localMapperSource, /function toPublicAllocation\(entry\) \{\s+const jobId = asTrimmedString\(entry\.jobId\);/);
  assert.match(localMapperSource, /\.\.\.\(jobId \? \{ jobId \} : \{\}\),\s+jobNumber: entry\.jobNumber,/);
  assert.match(edgeRepositorySource, /function toPublicAllocation\(entry: any\) \{\s+const jobId = deps\.asTrimmedString\(entry\.jobId\);/);
  assert.match(edgeRepositorySource, /\.\.\.\(jobId \? \{ jobId \} : \{\}\),\s+jobNumber: entry\.jobNumber,/);
});
