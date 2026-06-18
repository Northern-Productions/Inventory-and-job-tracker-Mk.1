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
  '0164_job_edit_preserve_phase_requirement_state.sql'
);
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260618100000_job_edit_preserve_phase_requirement_state.sql'
);
const runtimeJobsMutationsPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'services',
  'runtime',
  'runtimeJobsMutations.mjs'
);
const jobsRepositoryPath = path.join(
  repoRoot,
  'backend',
  'src',
  'app',
  'repositories',
  'jobsRepository.mjs'
);

test('job edit state preservation migration is mirrored', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('job edit state preservation migration keeps omitted state fields nullable', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create or replace function app_api\.requirement_rows_from_payload_with_ids/);
  assert.match(migration, /value \? 'status' or value \? 'requirementStatus'/);
  assert.match(migration, /filter \(where n\.status is not null\)/);
  assert.match(migration, /create or replace function app_api\.caulk_requirement_rows_from_payload/);
  assert.match(migration, /value \? 'actualUsedTubes' or value \? 'actual_used_tubes'/);
  assert.match(migration, /create or replace function app_api\.replace_job_phases/);
  assert.match(migration, /v_existing_workflow_status/);
  assert.match(migration, /coalesce\(nullif\(v_workflow_text, ''\), v_existing_workflow_status/);
});

test('local job update path preserves existing phase workflow status when omitted', async () => {
  const runtimeSource = await readFile(runtimeJobsMutationsPath, 'utf8');
  const repositorySource = await readFile(jobsRepositoryPath, 'utf8');

  assert.match(runtimeSource, /function findExistingPhaseForPayloadEntry/);
  assert.match(runtimeSource, /existingPhase\?\.workflowStatus/);
  assert.match(runtimeSource, /normalizePhaseInputsFromPayload\(updatePayload, primaryExistingPhase, existingPhases\)/);
  assert.match(repositorySource, /const existingPhaseById = \{\}/);
  assert.match(repositorySource, /existingPhase\?\.workflowStatus/);
});

test('local caulk requirement normalization distinguishes omitted status from explicit ACTIVE', async () => {
  const repositorySource = await readFile(jobsRepositoryPath, 'utf8');

  assert.match(repositorySource, /const rawStatus = asTrimmedString\(entry\.status\)\.toUpperCase\(\)/);
  assert.match(repositorySource, /rawStatus === 'ACTIVE'\s+\?\s+'ACTIVE'\s+:\s+undefined/);
  assert.match(repositorySource, /rawStatus === 'ACTIVE'\s+\?\s+'ACTIVE'\s+:\s+asTrimmedString\(matchedExisting\?\.status\)/);
});
