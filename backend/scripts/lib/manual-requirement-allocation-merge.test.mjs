import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildManualRequirementAllocationMergePlan } from '../../src/app/services/runtime/runtimeAllocationPlanning.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0088_manual_requirement_allocation_merge.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260425133000_manual_requirement_allocation_merge.sql'
);

function buildAllocation(overrides = {}) {
  return {
    allocationId: overrides.allocationId || 'alloc-1',
    boxId: overrides.boxId || 'IL1-6594',
    warehouse: 'IL1',
    jobId: overrides.jobId || 'job-1',
    jobNumber: overrides.jobNumber || '19413',
    installDate: '2026-04-25',
    allocatedFeet: overrides.allocatedFeet ?? 40,
    coveredFeet: overrides.coveredFeet ?? overrides.allocatedFeet ?? 40,
    requirementId: overrides.requirementId || 'req-1',
    allocationKind: overrides.allocationKind || 'REQUIREMENT',
    allocationSource: overrides.allocationSource || 'MANUAL',
    status: overrides.status || 'ACTIVE',
    createdAt: overrides.createdAt || '2026-04-25T12:00:00.000Z',
    createdBy: 'planner',
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    crewLeader: 'Crew',
    filmOrderId: overrides.filmOrderId || ''
  };
}

test('manual allocation to the same box and requirement merges into the existing manual row', () => {
  const existing = buildAllocation({ allocationId: 'manual-1', allocatedFeet: 40, coveredFeet: 80 });
  const addition = buildAllocation({
    allocationId: 'new-manual',
    allocatedFeet: 10,
    coveredFeet: 20,
    createdBy: 'user'
  });

  const plan = buildManualRequirementAllocationMergePlan([existing], addition, {
    resolvedBy: 'user',
    resolvedAt: '2026-04-25T13:00:00.000Z'
  });

  assert.equal(plan.supersededAllocations.length, 0);
  assert.equal(plan.mergedAllocation.allocationId, 'manual-1');
  assert.equal(plan.mergedAllocation.allocatedFeet, 50);
  assert.equal(plan.mergedAllocation.coveredFeet, 100);
  assert.equal(plan.mergedAllocation.allocationSource, 'MANUAL');
});

test('manual allocation converts an existing same-box AUTO_PLANNED row to one MANUAL row', () => {
  const existing = buildAllocation({
    allocationId: 'auto-1',
    allocationSource: 'AUTO_PLANNED',
    allocatedFeet: 100,
    coveredFeet: 100
  });
  const addition = buildAllocation({ allocationId: 'manual-new', allocatedFeet: 25, coveredFeet: 25 });

  const plan = buildManualRequirementAllocationMergePlan([existing], addition);

  assert.equal(plan.supersededAllocations.length, 0);
  assert.equal(plan.mergedAllocation.allocationId, 'auto-1');
  assert.equal(plan.mergedAllocation.allocatedFeet, 125);
  assert.equal(plan.mergedAllocation.coveredFeet, 125);
  assert.equal(plan.mergedAllocation.allocationSource, 'MANUAL');
});

test('manual allocation consolidates existing manual and auto duplicates into one manual row', () => {
  const existingManual = buildAllocation({
    allocationId: 'manual-1',
    allocationSource: 'MANUAL',
    allocatedFeet: 30,
    coveredFeet: 30,
    createdAt: '2026-04-25T11:00:00.000Z'
  });
  const existingAuto = buildAllocation({
    allocationId: 'auto-1',
    allocationSource: 'AUTO_PLANNED',
    allocatedFeet: 20,
    coveredFeet: 20,
    createdAt: '2026-04-25T10:00:00.000Z'
  });
  const addition = buildAllocation({ allocationId: 'manual-new', allocatedFeet: 15, coveredFeet: 15 });

  const plan = buildManualRequirementAllocationMergePlan([existingAuto, existingManual], addition, {
    resolvedBy: 'user',
    resolvedAt: '2026-04-25T13:00:00.000Z'
  });

  assert.equal(plan.mergedAllocation.allocationId, 'manual-1');
  assert.equal(plan.mergedAllocation.allocatedFeet, 65);
  assert.equal(plan.mergedAllocation.coveredFeet, 65);
  assert.deepEqual(
    plan.supersededAllocations.map((entry) => ({
      allocationId: entry.allocationId,
      status: entry.status,
      resolvedBy: entry.resolvedBy
    })),
    [{ allocationId: 'auto-1', status: 'CANCELLED', resolvedBy: 'user' }]
  );
});

test('manual merge ignores different requirements and cancelled historical rows', () => {
  const addition = buildAllocation({ allocationId: 'manual-new', allocatedFeet: 15 });

  assert.equal(
    buildManualRequirementAllocationMergePlan([
      buildAllocation({ allocationId: 'other-req', requirementId: 'req-2' })
    ], addition),
    null
  );
  assert.equal(
    buildManualRequirementAllocationMergePlan([
      buildAllocation({ allocationId: 'cancelled-old', status: 'CANCELLED' })
    ], addition),
    null
  );
});

test('manual allocation merge migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8')
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('manual allocation merge migration patches only requirement manual apply behavior', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');

  assert.match(migration, /create_or_merge_manual_requirement_allocation_with_coverage/);
  assert.match(migration, /coalesce\(a\.allocation_source::text, 'MANUAL'\) in \('MANUAL', 'AUTO_PLANNED'\)/);
  assert.match(migration, /v_duplicate\.status := 'CANCELLED'/);
  assert.match(migration, /v_primary\.allocation_source := 'MANUAL'::app\.allocation_source/);
  assert.match(migration, /v_kind <> 'REQUIREMENT'/);
  assert.match(migration, /or v_film_order_id <> ''/);
  assert.match(migration, /v_allocation := app_api\.create_or_merge_manual_requirement_allocation_with_coverage\(/);
});
