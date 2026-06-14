import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const backendMigrationPath = path.join(repoRoot, 'backend', 'migrations', '0099_auto_planner_global_capacity.sql');
const supabaseMigrationPath = path.join(
  repoRoot,
  'supabase',
  'migrations',
  '20260429110000_auto_planner_global_capacity.sql'
);
const schemaCheckPath = path.join(repoRoot, 'backend', 'scripts', 'check-schema-latest.mjs');

test('auto planner global capacity migration stays mirrored between backend and Supabase', async () => {
  const [backendMigration, supabaseMigration] = await Promise.all([
    readFile(backendMigrationPath, 'utf8'),
    readFile(supabaseMigrationPath, 'utf8'),
  ]);

  assert.equal(supabaseMigration, backendMigration);
});

test('auto planner global capacity migration treats out-of-scope reservations as fixed capacity', async () => {
  const migration = await readFile(backendMigrationPath, 'utf8');
  const newCapacitySnippet = extractSnippetVariable(migration, 'v_new_capacity');

  assert.match(migration, /create temporary table if not exists auto_planner_fixed_box_commitments/);
  assert.match(migration, /left join auto_planner_jobs scoped_job/);
  assert.match(migration, /scoped_job\.job_id = a\.job_id/);
  assert.match(migration, /upper\(trim\(scoped_job\.job_number\)\) = upper\(trim\(a\.job_number\)\)/);
  assert.match(migration, /coalesce\(a\.allocation_source::text, 'MANUAL'\) = 'AUTO_PLANNED'/);
  assert.match(migration, /upper\(coalesce\(b\.status::text, ''\)\) = 'IN_STOCK'/);
  assert.match(migration, /fixed_reserved_feet > bx\.capacity/);
  assert.match(migration, /AUTO planner capacity invariant failed/);
  assert.doesNotMatch(
    newCapacitySnippet,
    /set remaining = bx\.remaining - coalesce\(\([\s\S]*CHECKED_OUT[\s\S]*where bx\.box_id is not null;/
  );
});

test('latest schema check requires manual-only planner semantics after global capacity migration', async () => {
  const schemaCheck = await readFile(schemaCheckPath, 'utf8');


  assert.match(schemaCheck, /0159_box_lf_correction_reconciles_allocations\.sql/);

  assert.match(schemaCheck, /'manualOnly', true/);
  assert.match(schemaCheck, /filmInserted', 0/);
  assert.match(schemaCheck, /caulkInserted', 0/);
  assert.match(schemaCheck, /insert into app\.allocations/);
  assert.match(schemaCheck, /insert into app\.caulk_job_allocations/);
  assert.doesNotMatch(schemaCheck, /auto_planner_fixed_box_commitments/);
  assert.doesNotMatch(schemaCheck, /AUTO planner capacity invariant failed/);
  assert.doesNotMatch(
    schemaCheck,
    /set remaining = bx\.capacity - coalesce\([\s\S]*coalesce\(a\.allocation_source::text, 'MANUAL'\) <> 'AUTO_PLANNED'[\s\S]*\), 0\)\n  where bx\.box_id is not null;['"]/
  );
});

test('global capacity policy gives a later scoped job only unreserved physical LF', () => {
  const box = { boxId: 'IL1-100', physicalFeet: 100, status: 'IN_STOCK' };
  const allocations = [
    buildAllocation({
      allocationId: 'job-a-auto',
      jobId: 'job-a',
      jobNumber: '90001',
      allocatedFeet: 75,
      source: 'AUTO_PLANNED',
    }),
  ];
  const scopedJobs = new Set(['job-b']);
  const remaining = calculatePlannerRemainingFeet(box, allocations, scopedJobs);
  const jobBAllocated = Math.min(50, remaining);

  assert.equal(remaining, 25);
  assert.equal(jobBAllocated, 25);
  assert.equal(allocations[0].allocatedFeet, 75, 'Job A reservation must remain unchanged');
  assert.equal(totalReservedFeet([...allocations, buildAllocation({ jobId: 'job-b', allocatedFeet: jobBAllocated })]), 100);
});

test('global capacity policy allows existing in-scope AUTO_PLANNED rows to be replanned', () => {
  const box = { boxId: 'IL1-100', physicalFeet: 100, status: 'IN_STOCK' };
  const allocations = [
    buildAllocation({
      allocationId: 'job-a-auto',
      jobId: 'job-a',
      jobNumber: '90001',
      allocatedFeet: 75,
      source: 'AUTO_PLANNED',
    }),
    buildAllocation({
      allocationId: 'job-b-auto',
      jobId: 'job-b',
      jobNumber: '90002',
      allocatedFeet: 40,
      source: 'AUTO_PLANNED',
    }),
  ];
  const scopedJobs = new Set(['job-b']);
  const remaining = calculatePlannerRemainingFeet(box, allocations, scopedJobs);
  const replannedJobBAllocated = Math.min(50, remaining);

  assert.equal(remaining, 25);
  assert.equal(replannedJobBAllocated, 25);
  assert.equal(allocations[0].allocatedFeet, 75, 'Out-of-scope Job A reservation must remain fixed');
  assert.ok(replannedJobBAllocated < allocations[1].allocatedFeet, 'In-scope Job B AUTO_PLANNED row may be reduced');
  assertCapacityInvariant(box.physicalFeet, 75 + replannedJobBAllocated);
});

test('global capacity policy treats checked-out AUTO_PLANNED rows as fixed even when scoped', () => {
  const box = { boxId: 'IL1-100', physicalFeet: 100, status: 'CHECKED_OUT' };
  const allocations = [
    buildAllocation({
      allocationId: 'job-a-checked-out',
      jobId: 'job-a',
      jobNumber: '90001',
      allocatedFeet: 75,
      source: 'AUTO_PLANNED',
    }),
  ];

  assert.equal(calculateFixedReservedFeet(box, allocations, new Set(['job-a'])), 75);
});

test('global capacity invariant fails when reserved LF exceeds physical LF', () => {
  assert.throws(() => assertCapacityInvariant(100, 125), /reserved LF exceeds physical LF/);
});

function buildAllocation({
  allocationId = '',
  jobId = '',
  jobNumber = '',
  allocatedFeet = 0,
  source = 'AUTO_PLANNED',
  status = 'ACTIVE',
  kind = 'REQUIREMENT',
  requirementId = 'requirement-1',
} = {}) {
  return {
    allocationId,
    jobId,
    jobNumber,
    allocatedFeet,
    source,
    status,
    kind,
    requirementId,
  };
}

function calculatePlannerRemainingFeet(box, allocations, scopedJobIds) {
  return Math.max(box.physicalFeet - calculateFixedReservedFeet(box, allocations, scopedJobIds), 0);
}

function calculateFixedReservedFeet(box, allocations, scopedJobIds) {
  return allocations
    .filter((allocation) => reservesCapacity(allocation, box.status))
    .filter((allocation) => !isMutableScopedAutoPlannedAllocation(allocation, box.status, scopedJobIds))
    .reduce((total, allocation) => total + allocation.allocatedFeet, 0);
}

function totalReservedFeet(allocations) {
  return allocations
    .filter((allocation) => reservesCapacity(allocation, 'IN_STOCK'))
    .reduce((total, allocation) => total + allocation.allocatedFeet, 0);
}

function reservesCapacity(allocation, boxStatus) {
  if (allocation.kind !== 'REQUIREMENT' || !allocation.requirementId || allocation.allocatedFeet <= 0) {
    return false;
  }
  if (!allocation.jobId && !allocation.jobNumber) {
    return false;
  }
  return allocation.status === 'ACTIVE' || (allocation.status === 'FULFILLED' && boxStatus === 'CHECKED_OUT');
}

function isMutableScopedAutoPlannedAllocation(allocation, boxStatus, scopedJobIds) {
  return (
    allocation.source === 'AUTO_PLANNED' &&
    boxStatus === 'IN_STOCK' &&
    scopedJobIds.has(allocation.jobId)
  );
}

function assertCapacityInvariant(physicalFeet, reservedFeet) {
  if (reservedFeet > physicalFeet) {
    throw new Error(`reserved LF exceeds physical LF: ${reservedFeet} > ${physicalFeet}`);
  }
}

function extractSnippetVariable(migration, variableName) {
  const match = migration.match(new RegExp(`${variableName} text := \\$snippet\\$([\\s\\S]*?)\\$snippet\\$;`));
  assert.ok(match, `Expected ${variableName} snippet in migration`);
  return match[1];
}
