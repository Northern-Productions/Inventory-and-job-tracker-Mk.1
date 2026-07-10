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
  '0153_manual_only_auto_allocation_job_warehouse.sql'
);
const explicitSelectionBackendMigrationPath = path.join(
  repoRoot,
  'backend',
  'migrations',
  '0154_manual_allocation_explicit_selection.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260528100000_manual_only_auto_allocation_job_warehouse.sql'
);
const explicitSelectionSupabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260529100000_manual_allocation_explicit_selection.sql'
);
const schemaLatestPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const localAllocationApplyPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeAllocationApply.mjs'
);
const edgeMutationHandlersPath = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'routes',
  'mutationHandlers.ts'
);
const edgeReadHandlersPath = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'routes',
  'readHandlers.ts'
);
const allocationPageModelPath = path.join(
  repoRoot,
  'frontend',
  'src',
  'features',
  'inventory',
  'pages',
  'allocation-job',
  'useAllocationJobPageModel.ts'
);

function extractBody(sql, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = sql.match(
    new RegExp(`create or replace function ${escapedName}[\\s\\S]*?as \\$\\$\\r?\\n(?<body>[\\s\\S]*?)\\r?\\n\\$\\$;`)
  );
  assert.ok(match?.groups?.body, `Expected ${functionName} body.`);
  return match.groups.body;
}

test('manual-only auto-allocation migration stays mirrored', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('manual allocation explicit-selection SQL patch stays mirrored', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(explicitSelectionBackendMigrationPath, 'utf8'),
    readFile(explicitSelectionSupabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
  assert.match(
    backendMigration,
    /v_auto_allocate boolean := coalesce\(\(p_payload->>'autoAllocate'\)::boolean, false\);/
  );
  assert.match(
    backendMigration,
    /if not v_auto_allocate and array_position\(v_selected_box_ids, v_candidate\.box_id\) is null then/
  );
});

test('legacy SQL planner reconciliation is guarded as a no-op', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const body = extractBody(migration, 'app_api.reconcile_auto_planned_allocations');

  assert.match(body, /'manualOnly', true/);
  assert.match(body, /'filmInserted', 0/);
  assert.match(body, /'caulkInserted', 0/);
  assert.doesNotMatch(body, /insert into app\.allocations/i);
  assert.doesNotMatch(body, /insert into app\.caulk_job_allocations/i);
  assert.doesNotMatch(body, /AUTO_PLANNED allocation created by planner reconciliation/);
});

test('schema latest guard tracks manual-only planner semantics', async () => {
  const schemaLatest = await readFile(schemaLatestPath, 'utf8');


  assert.match(schemaLatest, /const LATEST_MIGRATION = '0187_caulk_owner_transfer_id_uppercase\.sql';/);

  assert.match(schemaLatest, /'manualOnly', true/);
  assert.match(schemaLatest, /insert into app\.allocations/);
  assert.match(schemaLatest, /insert into app\.caulk_job_allocations/);
  assert.match(schemaLatest, /v_auto_allocate boolean := coalesce/);
  assert.match(schemaLatest, /if not v_auto_allocate and array_position/);
});

test('row-level film Auto Allocate uses only the job warehouse', async () => {
  const pageModel = await readFile(allocationPageModelPath, 'utf8');

  assert.match(pageModel, /const searchableWarehouses = \[summary\.warehouse\];/);
  assert.match(pageModel, /crossWarehouse: false/);
  assert.match(pageModel, /jobWarehouse: summary\.warehouse/);
  assert.match(pageModel, /autoAllocate: true/);
  assert.match(pageModel, /Assign a warehouse to this job before auto-allocating material\./);
});

test('local and Edge allocation routes defensively scope explicit Auto Allocate by job warehouse', async () => {
  const [localApply, edgeMutations, edgeReads] = await Promise.all([
    readFile(localAllocationApplyPath, 'utf8'),
    readFile(edgeMutationHandlersPath, 'utf8'),
    readFile(edgeReadHandlersPath, 'utf8'),
  ]);

  for (const source of [localApply, edgeMutations, edgeReads]) {
    assert.match(source, /autoAllocate/);
    assert.match(source, /Assign a warehouse to this job before auto-allocating material\./);
    assert.match(source, /Auto Allocate only uses material from the job warehouse/);
    assert.match(source, /crossWarehouse = autoAllocate \? false : requestedCrossWarehouse|rpcPayload\.crossWarehouse = false/);
  }
  assert.match(localApply, /listBoxesByWarehouses\(client, orgId, \[jobWarehouse\]\)/);
  assert.match(localApply, /hasExplicitSuggestionSelection/);
  assert.match(localApply, /: autoAllocate\s+\?\s+plan\.suggestions\.map/);
  assert.match(edgeReads, /deps\.listBoxesByWarehouses\(client, orgId, \[jobWarehouse\]\)/);
  assert.match(edgeMutations, /rpcPayload\.jobWarehouse = jobWarehouse/);
});
