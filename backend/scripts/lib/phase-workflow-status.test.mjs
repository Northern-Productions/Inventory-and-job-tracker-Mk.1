import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildJobListEntry } from '../../src/app/services/runtime/runtimeJobSummaries.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0150_phase_workflow_status.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260523110000_phase_workflow_status.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');
const backendJobsCorePath = path.join(repoRoot, 'backend', 'src', 'app', 'core', 'jobs.mjs');
const backendStagingValidationPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'checkout',
  'stagingValidation.mjs'
);
const edgeMutationHandlersPath = path.join(
  repoRoot,
  'supabase',
  'functions',
  '_shared',
  'routes',
  'mutationHandlers.ts'
);

test('phase workflow migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('phase workflow migration adds Active/Placeholder status and staged invalidation helper', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /add column if not exists workflow_status text not null default 'ACTIVE'/);
  assert.match(migration, /job_phases_workflow_status_check/);
  assert.match(migration, /phase_number = 1 then 'ACTIVE' else 'PLACEHOLDER'/);
  assert.match(migration, /app_api\.normalize_job_phase_workflow_status/);
  assert.match(migration, /public\.api_acl_jobs_clear_staged_for_active_requirement/);
  assert.match(migration, /public\.api_acl_job_phase_set_state/);
});

test('schema latest guard tracks phase workflow status objects', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');


  assert.match(schemaCheck, /const LATEST_MIGRATION = '0178_film_allocation_remove_preserve_physical_lf\.sql';/);

  assert.match(schemaCheck, /app\.job_phases\.workflow_status/);
  assert.match(schemaCheck, /app_api\.normalize_job_phase_workflow_status\(text\)/);
  assert.match(schemaCheck, /public\.api_acl_jobs_clear_staged_for_active_requirement\(uuid, text, jsonb\)/);
});

test('runtime phase workflow helpers and staging validation use active phases only', async () => {
  const [jobsCore, stagingValidation] = await Promise.all([
    readFile(backendJobsCorePath, 'utf8'),
    readFile(backendStagingValidationPath, 'utf8'),
  ]);

  assert.match(jobsCore, /function normalizeJobPhaseWorkflowStatus/);
  assert.match(stagingValidation, /filterForActivePhases/);
  assert.match(stagingValidation, /filterLinkedForActiveRequirements/);
  assert.match(stagingValidation, /isPhaseWorkflowActive/);
});

test('job list summaries ignore placeholder-only film order and ordered allocation pressure', () => {
  const summary = buildJobListEntry(
    {
      id: 'job-1',
      jobNumber: '18722',
      warehouse: 'IL1',
      lifecycleStatus: 'ACTIVE',
      isLaborOnly: false,
      isStagedForPickup: false,
    },
    [],
    [
      {
        allocationId: 'alloc-placeholder',
        phaseId: 'phase-placeholder',
        jobNumber: '18722',
        boxId: 'IL1-ORDERED',
        status: 'ACTIVE',
        allocationKind: 'REQUIREMENT',
        allocatedFeet: 20,
      },
    ],
    [
      {
        filmOrderId: 'fo-placeholder',
        phaseId: 'phase-placeholder',
        jobNumber: '18722',
        status: 'FILM_ORDER',
      },
    ],
    [],
    [],
    {
      'IL1-ORDERED': {
        boxId: 'IL1-ORDERED',
        status: 'ORDERED',
      },
    },
    {
      phases: [
        {
          phaseId: 'phase-active',
          phaseNumber: 1,
          workflowStatus: 'ACTIVE',
          laborStatus: 'ACTIVE',
          isPrimary: true,
        },
        {
          phaseId: 'phase-placeholder',
          phaseNumber: 2,
          workflowStatus: 'PLACEHOLDER',
          laborStatus: 'ACTIVE',
        },
      ],
    }
  );

  assert.equal(summary.status, 'READY');
  assert.equal(summary.filmOrderCount, 0);
  assert.equal(summary.hasOrderedAllocations, false);
});

test('Edge mutation handlers clear staged pickup when active requirement material changes', async () => {
  const routeSource = await readFile(edgeMutationHandlersPath, 'utf8');

  assert.match(routeSource, /api_acl_jobs_clear_staged_for_active_requirement/);
  assert.match(routeSource, /clearStagedPickupForActiveRequirements\([\s\S]*"CAULK"/);
  assert.match(routeSource, /materialType,\s+\[deps\.asTrimmedString\(rpcPayloadRecord\.requirementId\)\]/);
  assert.match(routeSource, /clearStagedPickupIfUpdatedJobBlocked/);
  assert.match(routeSource, /loadJobStagingValidationState/);
});
