import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildPublicJobRequirementEntries,
  deriveRequirementCompletionResult,
} from '../../src/app/services/runtime/runtimeAllocationCoverage.mjs';
import { computeJobStatusFromRequirements } from '../../src/app/services/runtime/runtimeJobSummaries.mjs';
import { isJobNeedingAllocationAttention } from '../../src/app/services/appShell.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0142_requirement_actual_usage_state.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260521010000_requirement_actual_usage_state.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

function buildRequirement(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    manufacturer: '3M',
    filmName: 'Night Vision 15',
    widthIn: 36,
    requiredFeet: 25,
    status: 'ACTIVE',
    actualUsedFeet: 0,
    ...overrides,
  };
}

function buildFilmOrder(overrides = {}) {
  return {
    filmOrderId: 'fo-1',
    requirementId: '11111111-1111-4111-8111-111111111111',
    manufacturer: '3M',
    filmName: 'Night Vision 15',
    widthIn: 36,
    requestedFeet: 25,
    orderedFeet: 25,
    status: 'FILM_ON_THE_WAY',
    ...overrides,
  };
}

test('requirement usage state migration is mirrored and guarded by schema latest', () => {
  const backendMigration = readFileSync(backendMigrationPath, 'utf8');
  const supabaseMigration = readFileSync(supabaseMigrationPath, 'utf8');
  const schemaCheck = readFileSync(schemaCheckPath, 'utf8');

  assert.equal(supabaseMigration, backendMigration);

  assert.match(schemaCheck, /const LATEST_MIGRATION = '0168_film_weight_pending_review_resolution\.sql';/);

  assert.match(backendMigration, /actual_used_feet integer not null default 0/);
  assert.match(backendMigration, /status text not null default 'ACTIVE'/);
  assert.match(backendMigration, /record_requirement_actual_usage_for_checkin/);
  assert.match(backendMigration, /api_acl_job_requirement_set_state/);
  assert.match(backendMigration, /Reactivate it before allocating film/);
  assert.match(backendMigration, /Reactivate it before ordering more film/);
  assert.match(backendMigration, /coalesce\(r\.status, 'ACTIVE'\) = 'ACTIVE'/);
  assert.match(
    backendMigration,
    /and r\.job_id = v_job\.job_id\s+and coalesce\(r\.status, 'ACTIVE'\) = 'ACTIVE'\s+order by/
  );
});

test('new requirement rows default to Active with no actual usage', () => {
  const [entry] = buildPublicJobRequirementEntries([buildRequirement({ status: undefined })], [], {});

  assert.equal(entry.status, 'ACTIVE');
  assert.equal(entry.isComplete, false);
  assert.equal(entry.actualUsedFeet, 0);
  assert.equal(entry.completionResult, '');
  assert.equal(entry.remainingFeet, 25);
});

test('completion result is green for under or exact usage and red for overuse', () => {
  assert.equal(deriveRequirementCompletionResult(buildRequirement({ status: 'COMPLETE' }), 25, 20), 'ON_TARGET');
  assert.equal(deriveRequirementCompletionResult(buildRequirement({ status: 'COMPLETE' }), 25, 25), 'ON_TARGET');
  assert.equal(deriveRequirementCompletionResult(buildRequirement({ status: 'COMPLETE' }), 25, 28), 'OVERUSED');
  assert.equal(deriveRequirementCompletionResult(buildRequirement({ status: 'ACTIVE' }), 25, 28), '');
});

test('complete requirements do not create material demand, and active rows only demand remaining unused LF', () => {
  const completeStatus = computeJobStatusFromRequirements(
    'ACTIVE',
    false,
    false,
    [buildRequirement({ status: 'COMPLETE', actualUsedFeet: 20 })],
    [],
    [],
    [],
    { jobNumber: '9001' }
  );
  assert.equal(completeStatus, 'READY');

  const activeStatus = computeJobStatusFromRequirements(
    'ACTIVE',
    false,
    false,
    [buildRequirement({ status: 'ACTIVE', actualUsedFeet: 20 })],
    [],
    [],
    [],
    { jobNumber: '9001' }
  );
  assert.equal(activeStatus, 'FILM_ORDER');

  const overusedActiveStatus = computeJobStatusFromRequirements(
    'ACTIVE',
    false,
    false,
    [buildRequirement({ status: 'ACTIVE', actualUsedFeet: 28 })],
    [],
    [],
    [],
    { jobNumber: '9001' }
  );
  assert.equal(overusedActiveStatus, 'READY');

  const orderedStatus = computeJobStatusFromRequirements(
    'ACTIVE',
    false,
    false,
    [buildRequirement({ status: 'ACTIVE', actualUsedFeet: 20 })],
    [],
    [],
    [buildFilmOrder()],
    { jobNumber: '9001' }
  );
  assert.equal(orderedStatus, 'ORDERED');
});

test('red dot rule still depends on install date plus Film Order or Ordered with remaining material', () => {
  assert.equal(
    isJobNeedingAllocationAttention({
      lifecycleStatus: 'ACTIVE',
      installDate: '2026-05-21',
      status: 'FILM_ORDER',
      remainingFeet: 10,
    }),
    true
  );
  assert.equal(
    isJobNeedingAllocationAttention({
      lifecycleStatus: 'ACTIVE',
      installDate: '2026-05-21',
      status: 'ORDERED',
      remainingFeet: 10,
    }),
    true
  );
  assert.equal(
    isJobNeedingAllocationAttention({
      lifecycleStatus: 'ACTIVE',
      installDate: '',
      status: 'FILM_ORDER',
      remainingFeet: 10,
    }),
    false
  );
  assert.equal(
    isJobNeedingAllocationAttention({
      lifecycleStatus: 'ACTIVE',
      installDate: '2026-05-21',
      status: 'READY',
      remainingFeet: 0,
    }),
    false
  );
});
